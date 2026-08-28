import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import { toMonthlyPence, type Frequency, type Pence } from '../money.js';

/**
 * Employment and where the money comes from.
 *
 * Take-home pay at the frequency the client is actually paid, because that is
 * the figure they can give you without looking anything up. It is normalised to
 * monthly for the statement, and the entered frequency is kept so the client
 * sees back the number they gave.
 *
 * `incomeVaries` earns its place: variable pay is the commonest reason an
 * income figure turns out to be wrong, and a plan built on one good month fails
 * three months later. Flagging it lets Case Intelligence ask for more payslips
 * rather than an adviser having to remember to.
 */

export interface EmploymentInput {
  clientId: string;
  belongsTo?: 'client' | 'partner';
  status: 'employed' | 'self-employed' | 'unemployed' | 'retired' | 'student'
        | 'carer' | 'unable-to-work' | 'homemaker' | 'other';
  employerName?: string | null;
  jobTitle?: string | null;
  contractType?: 'permanent' | 'fixed-term' | 'zero-hours' | 'agency' | 'casual' | 'contractor' | null;
  startedOn?: string | null;
  endedOn?: string | null;
  isCurrent?: boolean;
  netPayPence?: Pence | null;
  payFrequency?: Frequency;
  incomeVaries?: boolean;
  notes?: string | null;
}

export interface EmploymentRecord extends EmploymentInput {
  id: string;
  belongsTo: 'client' | 'partner';
  isCurrent: boolean;
  payFrequency: Frequency;
  incomeVaries: boolean;
  /** Normalised, so callers never repeat the conversion. */
  monthlyNetPence: Pence;
}

export class EmploymentValidationError extends Error {}

const EARNING = new Set(['employed', 'self-employed']);

function validate(input: EmploymentInput): void {
  if (EARNING.has(input.status) && (input.netPayPence == null || input.netPayPence <= 0)) {
    throw new EmploymentValidationError(
      `A status of "${input.status}" means there is income to record. Enter the take-home `
      + 'pay, or use a status that reflects no earnings.',
    );
  }
  if (!EARNING.has(input.status) && (input.netPayPence ?? 0) > 0) {
    throw new EmploymentValidationError(
      `Pay was entered against a status of "${input.status}". Earnings from work belong on `
      + 'an employed or self-employed record; benefits and pensions belong in income.',
    );
  }
  if (input.endedOn && input.isCurrent !== false) {
    throw new EmploymentValidationError(
      'A record with an end date cannot also be the current one.',
    );
  }
}

/** What this employment contributes to the statement each month. */
export function monthlyIncomeOf(record: EmploymentInput): Pence {
  if (!record.netPayPence || record.netPayPence <= 0) return 0;
  return toMonthlyPence(record.netPayPence, record.payFrequency ?? 'monthly');
}

export async function listEmployment(
  db: Database, clientId: string,
): Promise<EmploymentRecord[]> {
  const res = await db.execute<Record<string, string | null> & {
    is_current: boolean; income_varies: boolean;
  }>(sql`
    SELECT id, belongs_to, status, employer_name, job_title, contract_type,
           started_on::text, ended_on::text, is_current, net_pay_pence::text,
           pay_frequency, income_varies, notes
      FROM employment_records WHERE client_id = ${clientId}
     ORDER BY is_current DESC, started_on DESC NULLS LAST`);
  return res.rows.map((r) => {
    const netPayPence = r['net_pay_pence'] == null ? null : Number(r['net_pay_pence']);
    const payFrequency = r['pay_frequency'] as Frequency;
    return {
      id: r['id']!, clientId,
      belongsTo: r['belongs_to'] as 'client' | 'partner',
      status: r['status'] as EmploymentRecord['status'],
      employerName: r['employer_name'] ?? null,
      jobTitle: r['job_title'] ?? null,
      contractType: (r['contract_type'] ?? null) as EmploymentRecord['contractType'],
      startedOn: r['started_on'] ?? null,
      endedOn: r['ended_on'] ?? null,
      isCurrent: r.is_current,
      netPayPence,
      payFrequency,
      incomeVaries: r.income_varies,
      notes: r['notes'] ?? null,
      monthlyNetPence: monthlyIncomeOf({ netPayPence, payFrequency } as EmploymentInput),
    };
  });
}

export async function recordEmployment(
  db: Database, ctx: TenantContext, principal: Principal, input: EmploymentInput,
): Promise<string> {
  requirePermission(principal, 'client:write');
  validate(input);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO employment_records
      (client_id, belongs_to, status, employer_name, job_title, contract_type,
       started_on, ended_on, is_current, net_pay_pence, pay_frequency,
       income_varies, notes)
    VALUES (${input.clientId}, ${input.belongsTo ?? 'client'}, ${input.status},
            ${input.employerName ?? null}, ${input.jobTitle ?? null},
            ${input.contractType ?? null}, ${input.startedOn ?? null},
            ${input.endedOn ?? null}, ${input.isCurrent ?? true},
            ${input.netPayPence ?? null}, ${input.payFrequency ?? 'monthly'},
            ${input.incomeVaries ?? false}, ${input.notes ?? null})
    RETURNING id`);
  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'employment.recorded',
    resourceType: 'employment_record',
    resourceId: id,
    reason: `${input.status}${input.employerName ? ` at ${input.employerName}` : ''}`,
    source: 'console',
    after: { ...input, monthlyNetPence: monthlyIncomeOf(input) } as Record<string, unknown>,
  });
  return id;
}

export async function updateEmployment(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string, input: EmploymentInput,
): Promise<void> {
  requirePermission(principal, 'client:write');
  validate(input);

  const before = await db.execute(sql`SELECT * FROM employment_records WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE employment_records
       SET belongs_to = ${input.belongsTo ?? 'client'}, status = ${input.status},
           employer_name = ${input.employerName ?? null}, job_title = ${input.jobTitle ?? null},
           contract_type = ${input.contractType ?? null}, started_on = ${input.startedOn ?? null},
           ended_on = ${input.endedOn ?? null}, is_current = ${input.isCurrent ?? true},
           net_pay_pence = ${input.netPayPence ?? null},
           pay_frequency = ${input.payFrequency ?? 'monthly'},
           income_varies = ${input.incomeVaries ?? false}, notes = ${input.notes ?? null}
     WHERE id = ${id}`);
  const after = await db.execute(sql`SELECT * FROM employment_records WHERE id = ${id}`);

  await recordAudit(db, ctx, {
    action: 'employment.updated',
    resourceType: 'employment_record',
    resourceId: id,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: (after.rows[0] ?? null) as Record<string, unknown> | null,
  });
}
