import { randomUUID } from 'node:crypto';
import { sql, withPlatform, withTenant, type Database, type TenantContext } from '@solvenda/db';

export interface TestTenant {
  id: string;
  slug: string;
  operatorId: string;
  /** A staff user inside the tenant, useful as an actor for audited writes. */
  userId: string;
  context: TenantContext;
  /** Run a query as this tenant. */
  as: <T>(fn: (db: Database) => Promise<T>) => Promise<T>;
}

let sharedOperatorId: string | null = null;

/** Creates (once) a platform operator used to provision test tenants. */
export async function ensureTestOperator(): Promise<string> {
  if (sharedOperatorId) return sharedOperatorId;
  const id = randomUUID();
  await withPlatform(
    { operatorId: id, reason: 'test harness bootstrap' },
    async (db) => {
      await db.execute(sql`
        INSERT INTO platform_operators (id, email, full_name, password_hash, operator_role)
        VALUES (${id}, ${`op-${id}@test.invalid`}, 'Test Operator', 'not-a-real-hash', 'admin')
      `);
    },
  );
  sharedOperatorId = id;
  return id;
}

/**
 * Provisions an isolated tenant with one staff user. Every test that touches
 * tenant data should use one of these rather than sharing fixtures, so a test
 * that leaks across tenants fails loudly instead of passing by accident.
 */
export async function createTestTenant(prefix = 'test'): Promise<TestTenant> {
  const operatorId = await ensureTestOperator();
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;

  const tenantId = await withPlatform(
    { operatorId, reason: 'provision tenant for automated test' },
    async (db) => {
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO tenants (slug, legal_name, status)
        VALUES (${slug}, ${`${slug} Ltd`}, 'active')
        RETURNING id
      `);
      return rows.rows[0]!.id;
    },
  );

  const context: TenantContext = {
    tenantId,
    actorType: 'user',
    actorLabel: 'test',
    requestId: `test-${randomUUID().slice(0, 8)}`,
  };

  const userId = await withTenant(context, async (db) => {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, full_name, user_type, status)
      VALUES (${`staff@${slug}.test`}, 'Test Adviser', 'staff', 'active')
      RETURNING id
    `);
    return rows.rows[0]!.id;
  });

  const boundContext: TenantContext = { ...context, userId };

  return {
    id: tenantId,
    slug,
    operatorId,
    userId,
    context: boundContext,
    as: <T>(fn: (db: Database) => Promise<T>) => withTenant(boundContext, fn),
  };
}

/** Asserts that a promise rejects with a Postgres error matching `pattern`. */
export async function expectDbError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const err = error as Error;
    if (!pattern.test(err.message)) {
      throw new Error(`Expected error matching ${pattern}, got: ${err.message}`);
    }
    return err;
  }
  throw new Error(`Expected the operation to be rejected by the database, but it succeeded`);
}
