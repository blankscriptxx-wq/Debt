import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { loadDbConfig, type DbConfig, type DbRole } from './config.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActorType =
  | 'user'
  | 'system'
  | 'workflow'
  | 'ai'
  | 'api_key'
  | 'platform_operator'
  | 'client'
  | 'integration';

/** Everything the database needs to know about who is asking. */
export interface TenantContext {
  tenantId: string;
  userId?: string | null;
  actorType?: ActorType;
  actorLabel?: string;
  requestId?: string;
}

export interface PlatformContext {
  operatorId: string;
  /** Present when the operator is acting inside a specific tenant. */
  tenantId?: string;
  requestId?: string;
  /** Free-text reason recorded against every cross-tenant action. */
  reason: string;
}

const pools = new Map<string, pg.Pool>();

function poolFor(role: DbRole, config: DbConfig): pg.Pool {
  const key = `${role}:${config.database}`;
  let pool = pools.get(key);
  if (!pool) {
    const creds = config.users[role];
    pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: creds.user,
      password: creds.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      max: config.maxConnections,
      application_name: `solvenda-${role}`,
    });
    pools.set(key, pool);
  }
  return pool;
}

let cachedConfig: DbConfig | null = null;
function config(): DbConfig {
  cachedConfig ??= loadDbConfig();
  return cachedConfig;
}

/** Test hook: point the pools at a different database. */
export function configureDatabase(overrides: Partial<DbConfig>): void {
  cachedConfig = { ...loadDbConfig(), ...overrides };
  pools.clear();
}

export async function closeDatabase(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${field} must be a UUID, received ${JSON.stringify(value)}`);
  }
}

/**
 * Run `fn` inside a transaction bound to one tenant.
 *
 * This is the only way application code reaches the database. The binding is
 * transaction-local (`set_config(..., true)`), so a connection returned to the
 * pool carries no residue of the previous request, and every tenant table's
 * RLS policy is evaluated against it.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.tenantId, 'tenantId');
  if (ctx.userId) assertUuid(ctx.userId, 'userId');

  const client = await poolFor('app', config()).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${config().statementTimeoutMs}`);
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.actor_type', $3, true),
              set_config('app.actor_label', $4, true),
              set_config('app.request_id', $5, true)`,
      [
        ctx.tenantId,
        ctx.userId ?? '',
        ctx.actorType ?? 'user',
        ctx.actorLabel ?? '',
        ctx.requestId ?? '',
      ],
    );
    const db = drizzle(client, { schema });
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Cross-tenant access for platform operators.
 *
 * Requires the `solvenda_platform` role *and* the GUC; the application pool
 * cannot satisfy the first condition, so no amount of application-level
 * mischief reaches this path. Callers are expected to have already validated a
 * live, unexpired `platform_access_grants` row - `assertActiveGrant` in
 * @solvenda/auth does that and is exercised by tests.
 */
export async function withPlatform<T>(
  ctx: PlatformContext,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.operatorId, 'operatorId');
  if (ctx.tenantId) assertUuid(ctx.tenantId, 'tenantId');
  if (!ctx.reason || ctx.reason.trim().length < 3) {
    throw new Error('withPlatform requires a reason describing why cross-tenant access is needed');
  }

  const client = await poolFor('platform', config()).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${config().statementTimeoutMs}`);
    await client.query(
      `SELECT set_config('app.platform_context', 'on', true),
              set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.actor_type', 'platform_operator', true),
              set_config('app.actor_label', $3, true),
              set_config('app.request_id', $4, true)`,
      [ctx.tenantId ?? '', ctx.operatorId, `operator:${ctx.operatorId}`, ctx.requestId ?? ''],
    );
    const db = drizzle(client, { schema });
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The unauthenticated path, for the public contact form and nothing else.
 *
 * Connects as the ordinary application role but binds no tenant, so
 * `app.current_tenant_id()` is NULL and every tenant table returns zero rows
 * and refuses every write - the same fail-closed behaviour a developer gets
 * for forgetting to open a tenant transaction. The only thing this connection
 * can do is insert into `platform_enquiries`, because that is the only table
 * the application role holds an unauthenticated grant on.
 */
export async function withPublic<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const client = await poolFor('app', config()).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${config().statementTimeoutMs}`);
    // No GUCs are set at all: no tenant, no user, no platform context. There
    // is nothing to bind, and binding nothing is exactly the point.
    const result = await fn(drizzle(client, { schema }));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Owner-role access, for migrations and schema conformance checks only.
 * Deliberately not exported from the package index.
 */
export async function withOwner<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await poolFor('owner', config()).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export { sql };
