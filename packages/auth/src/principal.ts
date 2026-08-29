import { sql, type Database } from '@solvenda/db';
import type { Principal } from './authorize.js';

/**
 * Assembles the caller's effective permissions from their role assignments.
 * Permissions are the union across roles; there is no deny rule, because a
 * subtractive model makes "what can this person actually do?" unanswerable at a
 * glance, which is exactly the question an audit asks.
 */
export async function loadUserPrincipal(
  db: Database,
  userId: string,
  mfaSatisfied: boolean,
): Promise<Principal | null> {
  const res = await db.execute<{
    id: string; tenant_id: string; status: string; competencies: string[];
  }>(sql`
    SELECT id, tenant_id, status, competencies FROM users WHERE id = ${userId}`);
  const user = res.rows[0];
  if (!user) return null;

  const perms = await db.execute<{ permission_key: string }>(sql`
    SELECT DISTINCT rp.permission_key
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ${userId}`);

  return {
    kind: 'user',
    tenantId: user.tenant_id,
    userId: user.id,
    permissions: new Set(perms.rows.map((r) => r.permission_key)),
    competencies: user.competencies ?? [],
    mfaSatisfied,
    status: user.status as 'active' | 'invited' | 'suspended' | 'closed',
  };
}

/** Principal for an automated workflow step. */
export function workflowPrincipal(
  tenantId: string,
  runId: string,
  permissions: readonly string[],
): Principal {
  return { kind: 'workflow', tenantId, runId, permissions: new Set(permissions) };
}

/**
 * Principal for an AI capability. Cannot hold a regulated permission.
 *
 * The invocation id is optional because a capability is authorised *before* its
 * invocation row is written — requiring it made the principal impossible to
 * construct for the one thing it exists for. Nothing in authorisation reads it;
 * it is carried for the record.
 */
export function aiPrincipal(
  tenantId: string,
  capability: string,
  invocationId?: string,
): Principal {
  return { kind: 'ai', tenantId, capability, invocationId };
}
