import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * Identity, address and income checks.
 *
 * What must be verified comes from the case type definition; this records what
 * was actually done about each requirement. The two are kept apart on purpose:
 * change the rules and existing cases keep their history rather than silently
 * acquiring or losing obligations.
 *
 * A waiver cannot be recorded without a reason. That mirrors the audit ledger's
 * rule for regulated actions, and for the same argument: a decision that cannot
 * explain itself is not a decision anyone can defend at a file review.
 */

export type VerificationStatus =
  'outstanding' | 'received' | 'verified' | 'rejected' | 'waived' | 'not-applicable';

export interface VerificationItem {
  id: string;
  requirementKey: string;
  category: 'identity' | 'address' | 'income' | 'expenditure' | 'debt' | 'vulnerability' | 'other';
  status: VerificationStatus;
  method: string | null;
  documentId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  waivedReason: string | null;
  expiresOn: string | null;
  notes: string | null;
}

export class VerificationError extends Error {}

/**
 * Where a requirement belongs in the checks table, from what kind of thing it
 * is. Category is how the list is grouped for an adviser; it plays no part in
 * whether a requirement counts as met.
 */
export function categoryForKind(kind: string): VerificationItem['category'] {
  switch (kind) {
    case 'identity': return 'identity';
    case 'vulnerability-assessment': return 'vulnerability';
    case 'financial-statement': case 'bank-data': return 'income';
    case 'credit-file': return 'debt';
    default: return 'other';
  }
}

export async function listVerificationItems(
  db: Database, caseId: string,
): Promise<VerificationItem[]> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT id, requirement_key, category, status, method, document_id,
           verified_by, verified_at::text, waived_reason, expires_on::text, notes
      FROM verification_items WHERE case_id = ${caseId}
     ORDER BY category, requirement_key`);
  return res.rows.map((r) => ({
    id: r['id']!, requirementKey: r['requirement_key']!,
    category: r['category'] as VerificationItem['category'],
    status: r['status'] as VerificationStatus,
    method: r['method'] ?? null,
    documentId: r['document_id'] ?? null,
    verifiedBy: r['verified_by'] ?? null,
    verifiedAt: r['verified_at'] ?? null,
    waivedReason: r['waived_reason'] ?? null,
    expiresOn: r['expires_on'] ?? null,
    notes: r['notes'] ?? null,
  }));
}

/**
 * Creates any requirement the case type asks for that is not yet tracked.
 *
 * Idempotent, so it can run whenever the case is opened: a case type gaining a
 * requirement should surface on existing cases, while one losing a requirement
 * leaves the completed history alone.
 */
export async function syncRequirements(
  db: Database, caseId: string, clientId: string,
  requirements: readonly { key: string; category: VerificationItem['category'] }[],
): Promise<number> {
  let created = 0;
  for (const requirement of requirements) {
    const res = await db.execute(sql`
      INSERT INTO verification_items (case_id, client_id, requirement_key, category)
      VALUES (${caseId}, ${clientId}, ${requirement.key}, ${requirement.category})
      ON CONFLICT (case_id, requirement_key) DO NOTHING
      RETURNING id`);
    created += res.rows.length;
  }
  return created;
}

export async function setVerificationStatus(
  db: Database, ctx: TenantContext, principal: Principal,
  id: string,
  input: {
    status: VerificationStatus;
    method?: string | null;
    documentId?: string | null;
    waivedReason?: string | null;
    expiresOn?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  requirePermission(principal, 'case:write');

  if (input.status === 'waived' && !input.waivedReason?.trim()) {
    throw new VerificationError(
      'Waiving a check is a compliance decision. Record why the evidence is not needed.',
    );
  }
  if (input.status === 'verified' && !input.method) {
    throw new VerificationError(
      'A verified check needs a method: how it was verified is the evidence.',
    );
  }

  const before = await db.execute(sql`SELECT * FROM verification_items WHERE id = ${id}`);
  const verified = input.status === 'verified';
  await db.execute(sql`
    UPDATE verification_items
       SET status = ${input.status}, method = ${input.method ?? null},
           document_id = ${input.documentId ?? null},
           waived_reason = ${input.waivedReason ?? null},
           expires_on = ${input.expiresOn ?? null}, notes = ${input.notes ?? null},
           verified_by = ${verified ? (ctx.userId ?? null) : null},
           verified_at = ${verified ? new Date().toISOString() : null}
     WHERE id = ${id}`);
  const after = await db.execute(sql`SELECT * FROM verification_items WHERE id = ${id}`);

  await recordAudit(db, ctx, {
    action: input.status === 'waived' ? 'verification.waived' : 'verification.recorded',
    resourceType: 'verification_item',
    resourceId: id,
    reason: input.waivedReason ?? `marked ${input.status}`,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
    after: (after.rows[0] ?? null) as Record<string, unknown> | null,
  });
}
