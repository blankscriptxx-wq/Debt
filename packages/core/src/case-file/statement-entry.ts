import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import {
  buildStatement, type HouseholdComposition, type StatementLineInput,
  type TriggerFigureSet,
} from '../sfs/statement.js';
import type { Frequency, Pence } from '../money.js';

/**
 * Entering income and expenditure.
 *
 * A statement is never edited. Saving produces a new version and marks the old
 * one superseded, because "what did this file look like when that advice was
 * given" has to keep having an answer — and an adviser correcting a figure two
 * months after a proposal went out must not silently rewrite the basis of it.
 *
 * Everything is computed by `buildStatement` rather than here: monthly
 * normalisation, trigger comparison and the totals. This module's only job is
 * to persist what that produced, so the figures on screen and the figures in
 * the database are the same calculation.
 */

export interface StatementEntryLine {
  section: 'income' | 'expenditure' | 'asset';
  category: string;
  subcategory?: string | null;
  label?: string | null;
  enteredAmountPence: Pence;
  enteredFrequency: Frequency;
  evidenceStatus?: 'none' | 'verbal' | 'document' | 'open-banking' | 'waived';
  explanation?: string | null;
  observedAmountPence?: Pence | null;
}

export class StatementEntryError extends Error {}

export interface LoadedStatement {
  id: string | null;
  version: number;
  status: string;
  lines: (StatementEntryLine & { id: string; amountPence: Pence })[];
}

export async function loadCurrentStatement(
  db: Database, caseId: string,
): Promise<LoadedStatement> {
  const head = await db.execute<Record<string, string>>(sql`
    SELECT id, version::text, status FROM financial_statements
     WHERE case_id = ${caseId} AND status IN ('draft','current')
     ORDER BY version DESC LIMIT 1`);
  const row = head.rows[0];
  if (!row) return { id: null, version: 0, status: 'none', lines: [] };

  const lines = await db.execute<Record<string, string | null>>(sql`
    SELECT id, section, category, subcategory, label, amount_pence::text,
           entered_amount_pence::text, entered_frequency, evidence_status,
           explanation, observed_amount_pence::text
      FROM financial_statement_lines WHERE statement_id = ${row['id']}
     ORDER BY section, category`);

  return {
    id: row['id']!, version: Number(row['version']), status: row['status']!,
    lines: lines.rows.map((l) => ({
      id: l['id']!,
      section: l['section'] as StatementEntryLine['section'],
      category: l['category']!,
      subcategory: l['subcategory'] ?? null,
      label: l['label'] ?? null,
      amountPence: Number(l['amount_pence']),
      enteredAmountPence: Number(l['entered_amount_pence'] ?? l['amount_pence']),
      enteredFrequency: (l['entered_frequency'] ?? 'monthly') as Frequency,
      evidenceStatus: (l['evidence_status'] ?? 'none') as StatementEntryLine['evidenceStatus'],
      explanation: l['explanation'] ?? null,
      observedAmountPence: l['observed_amount_pence'] == null
        ? null : Number(l['observed_amount_pence']),
    })),
  };
}

/**
 * Saves a statement as a new version.
 *
 * Returns the built statement so the caller can show the totals and any trigger
 * exceedance without recomputing them differently.
 */
export async function saveStatement(
  db: Database, ctx: TenantContext, principal: Principal,
  input: {
    caseId: string;
    clientId: string;
    lines: readonly StatementEntryLine[];
    household: HouseholdComposition;
    triggers?: TriggerFigureSet | null;
    supersedeReason?: string;
  },
): Promise<{ statementId: string; version: number; totals: ReturnType<typeof buildStatement>['totals']; exceedances: ReturnType<typeof buildStatement>['exceedances'] }> {
  requirePermission(principal, 'sfs:write');

  const negative = input.lines.find((l) => l.enteredAmountPence < 0);
  if (negative) {
    throw new StatementEntryError(
      `A negative amount was entered for ${negative.category}. Income and expenditure are `
      + 'both recorded as positive figures.',
    );
  }

  const built = buildStatement({
    lines: input.lines as readonly StatementLineInput[],
    household: input.household,
    triggers: input.triggers ?? null,
  });

  const previous = await db.execute<Record<string, string>>(sql`
    SELECT id, version::text FROM financial_statements
     WHERE case_id = ${input.caseId} ORDER BY version DESC LIMIT 1`);
  const version = previous.rows[0] ? Number(previous.rows[0]['version']) + 1 : 1;

  // Retire the outgoing statement before the new one lands. Only one statement
  // per case may be current — the database enforces that with a partial unique
  // index — so the order here is not stylistic: inserting first would collide.
  // `superseded_by` is filled in below, once the replacement has an id.
  if (previous.rows[0]) {
    await db.execute(sql`
      UPDATE financial_statements
         SET status = 'superseded', superseded_at = now(),
             supersede_reason = ${input.supersedeReason ?? 'Replaced by a newer statement'}
       WHERE id = ${previous.rows[0]['id']} AND status <> 'superseded'`);
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO financial_statements
      (case_id, client_id, version, status, total_income_pence,
       total_expenditure_pence, surplus_pence, trigger_exceedances,
       household_composition, completed_by, completed_at)
    VALUES (${input.caseId}, ${input.clientId}, ${version}, 'current',
            ${built.totals.totalIncomePence}, ${built.totals.totalExpenditurePence},
            ${built.totals.surplusPence},
            ${JSON.stringify(built.exceedances)}::jsonb,
            ${JSON.stringify(built.household)}::jsonb,
            ${ctx.userId ?? null}, now())
    RETURNING id`);
  const statementId = created.rows[0]!.id;

  for (const line of built.lines) {
    await db.execute(sql`
      INSERT INTO financial_statement_lines
        (statement_id, section, category, subcategory, label, amount_pence,
         entered_amount_pence, entered_frequency, evidence_status, explanation,
         observed_amount_pence, trigger_figure_pence, exceeds_trigger, source)
      VALUES (${statementId}, ${line.section}, ${line.category},
              ${line.subcategory ?? null}, ${line.label ?? null}, ${line.amountPence},
              ${line.enteredAmountPence}, ${line.enteredFrequency},
              ${(line as StatementEntryLine).evidenceStatus ?? 'none'},
              ${line.explanation ?? null},
              ${(line as StatementEntryLine).observedAmountPence ?? null},
              ${line.triggerFigurePence}, ${line.exceedsTrigger},
              -- Everything entered here is what the client told the adviser.
              -- Observed figures arrive from bank data on a different path and
              -- are never overwritten by this one.
              'declared')`);
  }

  // Now that the replacement exists, point the retired statement at it. The
  // whole save runs in one transaction, so a reader never sees a superseded
  // statement with nothing to succeed it.
  if (previous.rows[0]) {
    await db.execute(sql`
      UPDATE financial_statements SET superseded_by = ${statementId}
       WHERE id = ${previous.rows[0]['id']} AND superseded_by IS NULL`);
  }

  await recordAudit(db, ctx, {
    action: previous.rows[0] ? 'sfs.statement.superseded' : 'sfs.statement.created',
    resourceType: 'financial_statement',
    resourceId: statementId,
    caseId: input.caseId,
    reason: input.supersedeReason
      ?? `Statement version ${version} recorded from the case file`,
    source: 'console',
    after: {
      version,
      totalIncomePence: built.totals.totalIncomePence,
      totalExpenditurePence: built.totals.totalExpenditurePence,
      surplusPence: built.totals.surplusPence,
      exceedances: built.exceedances.length,
    },
  });

  return {
    statementId, version,
    totals: built.totals,
    exceedances: built.exceedances,
  };
}
