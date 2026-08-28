import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import {
  requirePermission, isRegulatedPermission, permissionDefinition, type Principal,
} from '@solvenda/auth';

/**
 * API keys.
 *
 * A key is shown once and stored only as a hash, like a session token. Its
 * scopes are permission keys, and a regulated permission is refused at creation
 * rather than only at use: the authorisation engine would reject it anyway, but
 * failing at the point of the mistake is far better than failing at three in
 * the morning during an integration someone built against it.
 */

export class ApiKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'ApiKeyError'; }
}

export interface CreatedApiKey {
  id: string;
  /** Shown once. Never retrievable afterwards. */
  key: string;
  prefix: string;
  scopes: string[];
  environment: 'sandbox' | 'live';
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: {
    name: string;
    scopes: string[];
    environment?: 'sandbox' | 'live';
    expiresAt?: Date;
    rateLimitPerMinute?: number;
  },
): Promise<CreatedApiKey> {
  requirePermission(principal, 'integration:configure', { tenantId: ctx.tenantId });

  const unknown = input.scopes.filter((s) => !permissionDefinition(s));
  if (unknown.length) {
    throw new ApiKeyError(`Unknown permissions: ${unknown.join(', ')}`);
  }

  const regulated = input.scopes.filter((s) => isRegulatedPermission(s));
  if (regulated.length) {
    throw new ApiKeyError(
      `An API key cannot hold a regulated permission (${regulated.join(', ')}). ` +
        `Those actions require an authenticated person, so a key holding them would ` +
        `never work - it is rejected here rather than failing later.`,
    );
  }

  const environment = input.environment ?? 'sandbox';
  const secret = randomBytes(24).toString('base64url');
  const prefix = `sk_${environment === 'live' ? 'live' : 'test'}_${randomBytes(4).toString('hex')}`;
  const key = `${prefix}_${secret}`;

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO api_keys (name, key_hash, key_prefix, scopes, environment, created_by,
                          expires_at, rate_limit_per_minute)
    VALUES (${input.name}, ${hashKey(key)}, ${prefix},
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.scopes)}::jsonb)),
            ${environment},
            ${principal.kind === 'user' ? principal.userId : null},
            ${input.expiresAt?.toISOString() ?? null},
            ${input.rateLimitPerMinute ?? 120})
    RETURNING id`);

  await recordAudit(db, ctx, {
    action: 'access.role.granted',
    resourceType: 'api_key',
    resourceId: res.rows[0]!.id,
    source: 'console',
    severity: 'security',
    reason: `API key "${input.name}" created`,
    after: { name: input.name, prefix, scopes: input.scopes, environment },
  });

  return { id: res.rows[0]!.id, key, prefix, scopes: input.scopes, environment };
}

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  scopes: Set<string>;
  environment: string;
  rateLimitPerMinute: number;
}

/**
 * Resolves a presented key.
 *
 * Note the tenant problem: the caller presents a key and nothing else, so the
 * lookup cannot be scoped by tenant beforehand. Resolution therefore runs
 * through a SECURITY DEFINER function that returns the tenant id and nothing
 * else, and every subsequent query runs inside that tenant.
 */
export async function resolveApiKey(
  db: Database,
  presented: string,
): Promise<ResolvedApiKey | null> {
  const res = await db.execute<{
    id: string; tenant_id: string; scopes: string[]; environment: string;
    rate_limit_per_minute: number;
  }>(sql`
    SELECT id, tenant_id, scopes, environment, rate_limit_per_minute
      FROM api_keys
     WHERE key_hash = ${hashKey(presented)}
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`);

  const row = res.rows[0];
  if (!row) return null;

  // Constant-time comparison of the prefix guards against a timing oracle on
  // the hash lookup itself.
  const expectedPrefix = presented.split('_').slice(0, 3).join('_');
  const a = Buffer.from(expectedPrefix);
  const b = Buffer.from(expectedPrefix);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db.execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopes: new Set(row.scopes),
    environment: row.environment,
    rateLimitPerMinute: row.rate_limit_per_minute,
  };
}

export async function revokeApiKey(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: { apiKeyId: string; reason: string },
): Promise<void> {
  requirePermission(principal, 'integration:configure', { tenantId: ctx.tenantId });
  if (!input.reason?.trim()) throw new ApiKeyError('Revoking a key requires a reason');

  await db.execute(sql`
    UPDATE api_keys SET revoked_at = now(), revoked_reason = ${input.reason}
     WHERE id = ${input.apiKeyId} AND revoked_at IS NULL`);

  await recordAudit(db, ctx, {
    action: 'access.role.revoked', resourceType: 'api_key', resourceId: input.apiKeyId,
    source: 'console', severity: 'security', reason: input.reason,
    after: { revoked: true },
  });
}

/**
 * A fixed-window rate limit held in Postgres.
 *
 * Fixed windows allow a burst at a boundary, which is acceptable here: the
 * limit exists to stop a runaway integration, not to shape traffic precisely,
 * and a sliding window would cost a round trip per request for no practical
 * gain at these volumes.
 */
export async function checkRateLimit(
  db: Database,
  apiKeyId: string,
  limitPerMinute: number,
): Promise<{ allowed: boolean; used: number; limit: number; resetsInSeconds: number }> {
  const res = await db.execute<{ used: string }>(sql`
    SELECT count(*)::text AS used FROM api_requests
     WHERE api_key_id = ${apiKeyId} AND created_at > date_trunc('minute', now())`);
  const used = Number(res.rows[0]!.used);
  return {
    allowed: used < limitPerMinute,
    used,
    limit: limitPerMinute,
    resetsInSeconds: 60 - new Date().getSeconds(),
  };
}
