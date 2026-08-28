import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { Pence } from '../money.js';

/**
 * The debts on a case.
 *
 * Provenance is not decoration. A balance the client remembered, a balance from
 * a credit file and a balance the creditor confirmed carry different weight,
 * and a proposal built on the first is a different thing from one built on the
 * third. It is recorded on every debt and never overwritten silently.
 *
 * Secured and priority debts are separated structurally rather than by a label,
 * because they behave differently: they cannot go into most solutions, and
 * non-payment costs a home, a vehicle or liberty rather than a default notice.
 */

export interface DebtInput {
  caseId: string;
  clientId: string;
  creditorName: string;
  accountReference?: string | null;
  customerNumber?: string | null;
  debtType?: string;
  isPriority?: boolean;
  balancePence: Pence;
  arrearsPence?: Pence;
  contractualPaymentPence?: Pence | null;
  isJoint?: boolean;
  isCreditAgreement?: boolean;
  inDispute?: boolean;
  isStatuteBarred?: boolean;
  includedInSolution?: boolean;
  provenance?: string;
  notes?: string | null;
}

export interface DebtTotals {
  unsecuredCount: number;
  securedCount: number;
  unsecuredPence: Pence;
  securedPence: Pence;
  unsecuredMonthlyPence: Pence;
  securedMonthlyPence: Pence;
  priorityCount: number;
  priorityPence: Pence;
}

export class DebtValidationError extends Error {}

const SECURED = new Set(['secured']);

function validate(input: DebtInput): void {
  if (!input.creditorName.trim()) {
    throw new DebtValidationError('A debt needs a creditor.');
  }
  if (input.balancePence < 0) {
    throw new DebtValidationError('A balance cannot be negative.');
  }
  if (input.isStatuteBarred && input.includedInSolution !== false) {
    throw new DebtValidationError(
      'A debt marked statute barred should not be included in a solution. Exclude it, '
      + 'or clear the statute-barred flag if it is being paid anyway.',
    );
  }
}

/**
 * The figures the summary bar shows.
 *
 * Computed rather than stored: a total that is written down is a total that can
 * disagree with the rows beneath it, and this one is read constantly.
 */
export function totalsFor(debts: readonly {
  debtType: string; balancePence: Pence; contractualPaymentPence?: Pence | null;
  isPriority?: boolean; status?: string;
}[]): DebtTotals {
  const active = debts.filter((d) => (d.status ?? 'active') === 'active');
  const totals: DebtTotals = {
    unsecuredCount: 0, securedCount: 0,
    unsecuredPence: 0, securedPence: 0,
    unsecuredMonthlyPence: 0, securedMonthlyPence: 0,
    priorityCount: 0, priorityPence: 0,
  };
  for (const debt of active) {
    const monthly = debt.contractualPaymentPence ?? 0;
    if (SECURED.has(debt.debtType)) {
      totals.securedCount += 1;
      totals.securedPence += debt.balancePence;
      totals.securedMonthlyPence += monthly;
    } else {
      totals.unsecuredCount += 1;
      totals.unsecuredPence += debt.balancePence;
      totals.unsecuredMonthlyPence += monthly;
    }
    if (debt.isPriority) {
      totals.priorityCount += 1;
      totals.priorityPence += debt.balancePence;
    }
  }
  return totals;
}

export async function addDebt(
  db: Database, ctx: TenantContext, principal: Principal, input: DebtInput,
): Promise<string> {
  requirePermission(principal, 'debt:write');
  validate(input);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO debts
      (case_id, client_id, creditor_name, account_reference, customer_number,
       debt_type, is_priority, balance_pence, arrears_pence,
       contractual_payment_pence, is_joint, is_credit_agreement, in_dispute,
       is_statute_barred, included_in_solution, provenance)
    VALUES (${input.caseId}, ${input.clientId}, ${input.creditorName},
            ${input.accountReference ?? null}, ${input.customerNumber ?? null},
            ${input.debtType ?? 'unsecured'}, ${input.isPriority ?? false},
            ${input.balancePence}, ${input.arrearsPence ?? 0},
            ${input.contractualPaymentPence ?? null}, ${input.isJoint ?? false},
            ${input.isCreditAgreement ?? false}, ${input.inDispute ?? false},
            ${input.isStatuteBarred ?? false}, ${input.includedInSolution ?? true},
            ${input.provenance ?? 'client-declared'})
    RETURNING id`);
  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'debt.created',
    resourceType: 'debt',
    resourceId: id,
    caseId: input.caseId,
    reason: `${input.creditorName} added`,
    source: 'console',
    after: { ...input } as Record<string, unknown>,
  });
  return id;
}

export async function updateDebt(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string, input: DebtInput,
): Promise<void> {
  requirePermission(principal, 'debt:write');
  validate(input);

  const before = await db.execute(sql`SELECT * FROM debts WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE debts
       SET creditor_name = ${input.creditorName},
           account_reference = ${input.accountReference ?? null},
           customer_number = ${input.customerNumber ?? null},
           debt_type = ${input.debtType ?? 'unsecured'},
           is_priority = ${input.isPriority ?? false},
           balance_pence = ${input.balancePence},
           arrears_pence = ${input.arrearsPence ?? 0},
           contractual_payment_pence = ${input.contractualPaymentPence ?? null},
           is_joint = ${input.isJoint ?? false},
           is_credit_agreement = ${input.isCreditAgreement ?? false},
           in_dispute = ${input.inDispute ?? false},
           is_statute_barred = ${input.isStatuteBarred ?? false},
           included_in_solution = ${input.includedInSolution ?? true}
     WHERE id = ${id}`);
  const after = await db.execute(sql`SELECT * FROM debts WHERE id = ${id}`);

  await recordAudit(db, ctx, {
    action: 'debt.updated',
    resourceType: 'debt',
    resourceId: id,
    caseId: input.caseId,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: (after.rows[0] ?? null) as Record<string, unknown> | null,
  });
}

/**
 * Debts are withdrawn, not deleted.
 *
 * A debt that turns out not to exist is still something the file said existed,
 * and a proposal may already have gone out naming it.
 */
export async function removeDebt(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string, reason: string,
): Promise<void> {
  requirePermission(principal, 'debt:write');
  if (!reason.trim()) {
    throw new DebtValidationError('Removing a debt needs a reason.');
  }
  const before = await db.execute(sql`SELECT * FROM debts WHERE id = ${id}`);
  await db.execute(sql`
    UPDATE debts SET status = 'removed', included_in_solution = false WHERE id = ${id}`);
  await recordAudit(db, ctx, {
    action: 'debt.removed',
    resourceType: 'debt',
    resourceId: id,
    reason,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: { status: 'removed' },
  });
}
