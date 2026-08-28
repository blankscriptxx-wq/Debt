import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, type Database } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, type Principal } from '@solvenda/auth';
import { saveStatement, loadCurrentStatement, StatementEntryError } from '@solvenda/core';

/**
 * Saving income and expenditure from the case file.
 *
 * The invariant under test is versioning: a statement is replaced, never
 * edited, and exactly one version of it is current at a time. That is enforced
 * in the database by a partial unique index, which means the order of writes is
 * load-bearing — the outgoing statement has to be retired before the
 * replacement is inserted, or the save fails outright. It did, once.
 */

let tenant: TestTenant;
let clientId: string;
let caseId: string;

function adviser(): Principal {
  return {
    kind: 'user',
    tenantId: tenant.id,
    userId: tenant.userId,
    permissions: new Set(['sfs:write', 'case:read']),
    competencies: ['debt-advice'],
    mfaSatisfied: true,
    status: 'active',
  };
}

const HOUSEHOLD = { adults: 1, children: 0, childAges: [] as number[] };

const wages = (amount: number) => ({
  section: 'income' as const, category: 'wages',
  enteredAmountPence: amount, enteredFrequency: 'monthly' as const,
});
const rent = (amount: number) => ({
  section: 'expenditure' as const, category: 'rent-or-mortgage',
  enteredAmountPence: amount, enteredFrequency: 'monthly' as const,
});

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('sfs-entry');

  const ids = await tenant.as(async (db: Database) => {
    const client = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, jurisdiction, household_adults)
      VALUES ('CL-7100', 'Ade', 'Okonkwo', 'england-wales', 1) RETURNING id`);
    const clientRow = client.rows[0]!.id;
    const kase = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
      VALUES ('DMP-7100', ${clientRow}, 'dmp', 1, 'assessment', ${tenant.userId}) RETURNING id`);
    return { clientRow, caseRow: kase.rows[0]!.id };
  });
  clientId = ids.clientRow;
  caseId = ids.caseRow;
});

afterAll(async () => { await closeDatabase(); });

describe('saving a statement', () => {
  it('records the first version as current', async () => {
    const saved = await tenant.as((db) => saveStatement(db, tenant.context, adviser(), {
      caseId, clientId, household: HOUSEHOLD,
      lines: [wages(180_000), rent(75_000)],
    }));

    expect(saved.version).toBe(1);
    expect(saved.totals.totalIncomePence).toBe(180_000);
    expect(saved.totals.surplusPence).toBe(105_000);
  });

  it('supersedes rather than edits, leaving one current version', async () => {
    const saved = await tenant.as((db) => saveStatement(db, tenant.context, adviser(), {
      caseId, clientId, household: HOUSEHOLD,
      lines: [wages(190_000), rent(75_000)],
      supersedeReason: 'Client provided a new payslip',
    }));

    expect(saved.version).toBe(2);

    const rows = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, string | null>>(sql`
        SELECT version::text, status, superseded_by, supersede_reason
          FROM financial_statements WHERE case_id = ${caseId} ORDER BY version`);
      return r.rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]!['status']).toBe('superseded');
    // The retired version points at what replaced it, so "what was the basis of
    // that advice, and what came after it" stays answerable.
    expect(rows[0]!['superseded_by']).toBe(saved.statementId);
    expect(rows[0]!['supersede_reason']).toBe('Client provided a new payslip');
    expect(rows[1]!['status']).toBe('current');

    // The first version's figures are untouched by the correction.
    const original = await tenant.as(async (db) => {
      const r = await db.execute<{ total: string }>(sql`
        SELECT total_income_pence::text AS total FROM financial_statements
         WHERE case_id = ${caseId} AND version = 1`);
      return Number(r.rows[0]!.total);
    });
    expect(original).toBe(180_000);
  });

  it('survives repeated saves, which the unique current index would otherwise reject', async () => {
    for (const amount of [200_000, 210_000, 220_000]) {
      await tenant.as((db) => saveStatement(db, tenant.context, adviser(), {
        caseId, clientId, household: HOUSEHOLD, lines: [wages(amount), rent(75_000)],
      }));
    }

    const current = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM financial_statements
         WHERE case_id = ${caseId} AND status = 'current'`);
      return Number(r.rows[0]!.n);
    });
    expect(current).toBe(1);

    const loaded = await tenant.as((db) => loadCurrentStatement(db, caseId));
    expect(loaded.version).toBe(5);
    expect(loaded.lines.find((l) => l.category === 'wages')?.amountPence).toBe(220_000);
  });

  it('refuses a negative amount rather than storing a nonsense figure', async () => {
    await expect(tenant.as((db) => saveStatement(db, tenant.context, adviser(), {
      caseId, clientId, household: HOUSEHOLD, lines: [wages(-500)],
    }))).rejects.toBeInstanceOf(StatementEntryError);
  });

  it('refuses a principal without sfs:write', async () => {
    const readOnly: Principal = { ...adviser(), permissions: new Set(['case:read']) } as Principal;
    await expect(tenant.as((db) => saveStatement(db, tenant.context, readOnly, {
      caseId, clientId, household: HOUSEHOLD, lines: [wages(180_000)],
    }))).rejects.toThrow();
  });
});
