import { sql, type Database, type TenantContext } from '@solvenda/db';
import { changedFields, redact } from './diff.js';
import { defaultSeverity, type AuditAction, type AuditSeverity } from './actions.js';

export interface AuditInput {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  caseId?: string | null;
  /** WHY: the business reason. Required for regulated actions. */
  reason?: string | null;
  /** SOURCE: 'console' | 'client_portal' | 'api:<keyId>' | 'workflow:<runId>' | 'ai:<capability>' | 'migration:<runId>' */
  source: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  severity?: AuditSeverity;
  aiInvocationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditedEvent {
  id: string;
  seq: number;
  hash: string;
}

export class AuditReasonRequiredError extends Error {
  constructor(action: string) {
    super(`Action "${action}" carries regulatory weight and requires a reason`);
    this.name = 'AuditReasonRequiredError';
  }
}

/**
 * Writes one entry to the ledger. Must be called inside the same transaction as
 * the change it describes, so a committed change always has a committed audit
 * record and a rolled-back one leaves nothing behind.
 */
export async function recordAudit(
  db: Database,
  ctx: TenantContext,
  input: AuditInput,
): Promise<AuditedEvent> {
  const severity = input.severity ?? defaultSeverity(input.action);

  // Regulated actions without a stated reason are refused outright: an audit
  // trail that cannot answer "why" is not an audit trail.
  if (severity === 'regulated' && !input.reason?.trim()) {
    throw new AuditReasonRequiredError(input.action);
  }

  const before = input.before ? redact(input.before) : null;
  const after = input.after ? redact(input.after) : null;
  const fields = changedFields(before, after);

  const result = await db.execute<{ id: string; seq: string; hash: string }>(sql`
    INSERT INTO audit_events (
      actor_user_id, actor_type, actor_label,
      action, resource_type, resource_id, case_id,
      reason, source, before_state, after_state, changed_fields,
      request_id, ip, user_agent, ai_invocation_id, severity
    ) VALUES (
      ${ctx.userId ?? null}, ${ctx.actorType ?? 'user'}, ${ctx.actorLabel ?? ctx.userId ?? 'unknown'},
      ${input.action}, ${input.resourceType}, ${input.resourceId ?? null}, ${input.caseId ?? null},
      ${input.reason ?? null}, ${input.source},
      ${before ? JSON.stringify(before) : null}::jsonb,
      ${after ? JSON.stringify(after) : null}::jsonb,
      CASE WHEN ${fields.length} = 0 THEN NULL
           ELSE string_to_array(${fields.join(',')}, ',') END,
      ${ctx.requestId ?? null}, ${input.ip ?? null}::inet, ${input.userAgent ?? null},
      ${input.aiInvocationId ?? null}, ${severity}
    )
    RETURNING id, seq::text AS seq, hash
  `);

  const row = result.rows[0]!;
  return { id: row.id, seq: Number(row.seq), hash: row.hash };
}

/**
 * Performs a mutation and records it in one step, capturing the before and
 * after states automatically.
 *
 * Application code is expected to use this rather than writing an UPDATE and
 * remembering to log it. `readSnapshot` runs before and after the mutation
 * against the same transaction, so the pair is always consistent.
 */
export async function auditedMutation<T>(
  db: Database,
  ctx: TenantContext,
  input: Omit<AuditInput, 'before' | 'after'>,
  ops: {
    readSnapshot: (db: Database) => Promise<Record<string, unknown> | null>;
    mutate: (db: Database) => Promise<T>;
  },
): Promise<{ result: T; audit: AuditedEvent }> {
  const before = await ops.readSnapshot(db);
  const result = await ops.mutate(db);
  const after = await ops.readSnapshot(db);
  const audit = await recordAudit(db, ctx, { ...input, before, after });
  return { result, audit };
}
