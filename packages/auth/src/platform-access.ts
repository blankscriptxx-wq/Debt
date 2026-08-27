import { sql, withPlatform } from '@solvenda/db';

export class PlatformAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformAccessError';
  }
}

/**
 * Confirms that an operator holds a live, unexpired, unrevoked grant for the
 * tenant they are about to look at.
 *
 * Support access to a firm's client data is a privileged act, so it is
 * time-boxed and reason-coded up front rather than justified afterwards. This
 * check is the gate every operator-facing read passes through.
 */
export async function assertActiveGrant(input: {
  operatorId: string;
  tenantId: string;
  scope?: 'read' | 'write';
}): Promise<{ grantId: string; expiresAt: Date; reason: string }> {
  const wanted = input.scope ?? 'read';
  const grant = await withPlatform(
    { operatorId: input.operatorId, reason: 'verifying support access grant' },
    async (db) => {
      const res = await db.execute<{ id: string; expires_at: Date; reason: string; scope: string }>(sql`
        SELECT id, expires_at, reason, scope
          FROM platform_access_grants
         WHERE operator_id = ${input.operatorId}
           AND tenant_id = ${input.tenantId}
           AND revoked_at IS NULL
           AND expires_at > now()
           AND (scope = ${wanted} OR scope = 'write')
         ORDER BY expires_at DESC
         LIMIT 1`);
      return res.rows[0] ?? null;
    },
  );

  if (!grant) {
    throw new PlatformAccessError(
      `Operator ${input.operatorId} holds no active ${wanted} grant for tenant ${input.tenantId}`,
    );
  }
  return { grantId: grant.id, expiresAt: grant.expires_at, reason: grant.reason };
}

export interface GrantRequest {
  operatorId: string;
  tenantId: string;
  reason: string;
  ticketRef?: string;
  scope?: 'read' | 'write';
  durationMinutes?: number;
  approvedBy?: string;
}

const MAX_GRANT_MINUTES = 8 * 60;

export async function requestPlatformAccess(input: GrantRequest): Promise<string> {
  if (!input.reason || input.reason.trim().length < 10) {
    throw new PlatformAccessError('A specific reason of at least 10 characters is required');
  }
  const minutes = Math.min(input.durationMinutes ?? 60, MAX_GRANT_MINUTES);
  // Write access to a firm's data always needs a second operator to approve.
  if ((input.scope ?? 'read') === 'write' && !input.approvedBy) {
    throw new PlatformAccessError('Write access requires approval by a second operator');
  }

  return withPlatform(
    { operatorId: input.operatorId, tenantId: input.tenantId, reason: input.reason },
    async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO platform_access_grants
          (operator_id, tenant_id, reason, ticket_ref, scope, approved_by, expires_at)
        VALUES (${input.operatorId}, ${input.tenantId}, ${input.reason},
                ${input.ticketRef ?? null}, ${input.scope ?? 'read'},
                ${input.approvedBy ?? null},
                now() + (${String(minutes)} || ' minutes')::interval)
        RETURNING id`);
      return res.rows[0]!.id;
    },
  );
}
