import { sql, type Database } from '@solvenda/db';

export interface ChainVerification {
  tenantId: string;
  checked: number;
  ok: boolean;
  firstBadSeq: number | null;
  detail: string | null;
}

/**
 * Recomputes the hash chain and reports the first divergence. Intended to run
 * as a scheduled integrity job and on demand from the compliance console; a
 * failure here means history has been altered outside the application.
 */
export async function verifyAuditChain(
  db: Database,
  tenantId?: string,
): Promise<ChainVerification[]> {
  const res = await db.execute<{
    tenant_id: string; checked: string; ok: boolean;
    first_bad_seq: string | null; detail: string | null;
  }>(sql`SELECT * FROM app.verify_audit_chain(${tenantId ?? null}::uuid)`);

  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    checked: Number(r.checked),
    ok: r.ok,
    firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq),
    detail: r.detail,
  }));
}
