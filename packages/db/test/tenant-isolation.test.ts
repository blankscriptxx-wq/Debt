import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform, withTenant } from '@solvenda/db';
import { createTestTenant, expectDbError, type TestTenant } from '@solvenda/testing';

/**
 * Behavioural proof that one tenant cannot reach another's data, across the
 * shapes that actually appear in application code: plain reads, joins,
 * aggregates, CTEs, RETURNING clauses, updates and deletes.
 */

let alpha: TestTenant;
let beta: TestTenant;

beforeAll(async () => {
  alpha = await createTestTenant('alpha');
  beta = await createTestTenant('beta');

  await alpha.as(async (db) => {
    await db.execute(sql`
      INSERT INTO users (email, full_name, user_type, status)
      VALUES ('alpha-secret@alpha.test', 'Alpha Secret Person', 'client', 'active')`);
    await db.execute(sql`
      INSERT INTO roles (key, name, description) VALUES ('alpha-role', 'Alpha Role', '')`);
  });
});

afterAll(async () => { await closeDatabase(); });

describe('tenant isolation', () => {
  it('hides other tenants rows from a plain select', async () => {
    const seen = await beta.as(async (db) => {
      const r = await db.execute<{ email: string }>(sql`SELECT email FROM users`);
      return r.rows.map((x) => x.email);
    });
    expect(seen).not.toContain('alpha-secret@alpha.test');
    expect(seen).toEqual([`staff@${beta.slug}.test`]);
  });

  it('hides other tenants rows from aggregates', async () => {
    const count = await beta.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM users`);
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(1);
  });

  it('hides other tenants rows from joins and CTEs', async () => {
    const rows = await beta.as(async (db) => {
      const r = await db.execute<{ email: string }>(sql`
        WITH everything AS (SELECT u.email FROM users u LEFT JOIN roles r ON r.tenant_id = u.tenant_id)
        SELECT email FROM everything`);
      return r.rows.map((x) => x.email);
    });
    expect(rows.every((e) => e.endsWith(`@${beta.slug}.test`))).toBe(true);
  });

  it('refuses an insert that names another tenant', async () => {
    await expectDbError(
      beta.as((db) =>
        db.execute(sql`
          INSERT INTO users (tenant_id, email, full_name)
          VALUES (${alpha.id}, 'forged@evil.test', 'Forged')`),
      ),
      /row-level security/i,
    );
  });

  it('refuses to move a row into another tenant', async () => {
    await expectDbError(
      beta.as((db) => db.execute(sql`UPDATE users SET tenant_id = ${alpha.id}`)),
      /row-level security/i,
    );
  });

  it('silently matches nothing when updating another tenants rows', async () => {
    const updated = await beta.as(async (db) => {
      const r = await db.execute(sql`
        UPDATE users SET full_name = 'Hijacked'
         WHERE email = 'alpha-secret@alpha.test' RETURNING id`);
      return r.rows.length;
    });
    expect(updated).toBe(0);

    const stillIntact = await alpha.as(async (db) => {
      const r = await db.execute<{ full_name: string }>(sql`
        SELECT full_name FROM users WHERE email = 'alpha-secret@alpha.test'`);
      return r.rows[0]!.full_name;
    });
    expect(stillIntact).toBe('Alpha Secret Person');
  });

  it('deletes nothing when targeting another tenants rows', async () => {
    const deleted = await beta.as(async (db) => {
      const r = await db.execute(sql`DELETE FROM users WHERE email = 'alpha-secret@alpha.test' RETURNING id`);
      return r.rows.length;
    });
    expect(deleted).toBe(0);
  });

  it('defaults tenant_id without the caller supplying it', async () => {
    const tenantOfNewRow = await alpha.as(async (db) => {
      const r = await db.execute<{ tenant_id: string }>(sql`
        INSERT INTO roles (key, name) VALUES ('defaulted', 'Defaulted') RETURNING tenant_id`);
      return r.rows[0]!.tenant_id;
    });
    expect(tenantOfNewRow).toBe(alpha.id);
  });

  it('reads nothing and writes nothing without a tenant binding', async () => {
    // Simulates a code path that reached the database outside withTenant().
    await expect(
      withTenant({ tenantId: '00000000-0000-0000-0000-000000000000' }, async (db) => {
        const r = await db.execute(sql`SELECT * FROM users`);
        return r.rows.length;
      }),
    ).resolves.toBe(0);
  });

  it('rejects a non-uuid tenant id before it reaches the database', async () => {
    await expect(
      withTenant({ tenantId: "' OR '1'='1" }, async () => 1),
    ).rejects.toThrow(/must be a UUID/);
  });

  it('shows a tenant exactly one row of the tenant directory - its own', async () => {
    const visible = await beta.as(async (db) => {
      const r = await db.execute<{ slug: string }>(sql`SELECT slug FROM tenants`);
      return r.rows.map((x) => x.slug);
    });
    expect(visible).toEqual([beta.slug]);
  });

  it('refuses to let a tenant modify the tenant directory', async () => {
    await expectDbError(
      beta.as((db) => db.execute(sql`UPDATE tenants SET legal_name = 'Renamed'`)),
      /permission denied/i,
    );
  });

  it('lets a tenant read its own record through the scoped accessor only', async () => {
    const own = await alpha.as(async (db) => {
      const r = await db.execute<{ slug: string }>(sql`SELECT slug FROM app.current_tenant()`);
      return r.rows;
    });
    expect(own).toHaveLength(1);
    expect(own[0]!.slug).toBe(alpha.slug);
  });

  it('requires a stated reason for cross-tenant platform access', async () => {
    await expect(
      withPlatform({ operatorId: alpha.operatorId, reason: '' }, async () => 1),
    ).rejects.toThrow(/requires a reason/);
  });

  it('allows platform context to see across tenants, by design', async () => {
    const total = await withPlatform(
      { operatorId: alpha.operatorId, reason: 'verifying operator visibility in tests' },
      async (db) => {
        const r = await db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM users WHERE tenant_id IN (${alpha.id}, ${beta.id})`);
        return Number(r.rows[0]!.n);
      },
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
