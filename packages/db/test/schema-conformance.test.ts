import { describe, expect, it, afterAll } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { ensureTestOperator } from '@solvenda/testing';

/**
 * Structural guarantees that must hold for every table, now and for every
 * table added later. These are the checks that make tenant safety a property
 * of the schema rather than of developer discipline.
 */

interface Row { [k: string]: unknown }

async function query<T extends Row>(text: string): Promise<T[]> {
  const operatorId = await ensureTestOperator();
  return withPlatform({ operatorId, reason: 'schema conformance verification' }, async (db) => {
    const res = await db.execute<T>(sql.raw(text));
    return res.rows as T[];
  });
}

afterAll(async () => { await closeDatabase(); });

describe('schema conformance', () => {
  it('registers every public table with an explicit tenancy scope', async () => {
    const unregistered = await query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname NOT IN (SELECT table_name FROM app.table_registry)
       ORDER BY 1`);
    expect(
      unregistered.map((r) => r.table_name),
      'every table must be declared tenant, global or platform scoped via app.apply_*_rls()',
    ).toEqual([]);
  });

  it('forces row level security on every table', async () => {
    const unprotected = await query<{ table_name: string; rls: boolean; forced: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)
       ORDER BY 1`);
    // FORCE matters as much as ENABLE: without it the table owner bypasses the
    // policy, which would make migrations and any owner-role code unsafe.
    expect(unprotected.map((r) => r.table_name)).toEqual([]);
  });

  it('gives every tenant-scoped table a defaulted, non-null tenant_id', async () => {
    const bad = await query<{ table_name: string; problem: string }>(`
      SELECT r.table_name,
             CASE WHEN a.attname IS NULL THEN 'missing tenant_id column'
                  WHEN a.attnotnull = false THEN 'tenant_id is nullable'
                  WHEN pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'app.current_tenant_id()'
                       THEN 'tenant_id default is not app.current_tenant_id()'
             END AS problem
        FROM app.table_registry r
        JOIN pg_class c ON c.relname = r.table_name
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE r.scope = 'tenant'
         AND (a.attname IS NULL OR a.attnotnull = false
              OR pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'app.current_tenant_id()')
       ORDER BY 1`);
    expect(bad).toEqual([]);
  });

  it('attaches an isolation policy to every tenant-scoped table', async () => {
    const missing = await query<{ table_name: string }>(`
      SELECT r.table_name FROM app.table_registry r
       WHERE r.scope = 'tenant'
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = r.table_name
              AND p.policyname = r.table_name || '_tenant_isolation')
       ORDER BY 1`);
    expect(missing.map((r) => r.table_name)).toEqual([]);
  });

  it('never lets the application role write to platform-scoped tables', async () => {
    const leaked = await query<{ table_name: string; privilege_type: string }>(`
      SELECT r.table_name, g.privilege_type
        FROM app.table_registry r
        JOIN information_schema.role_table_grants g
          ON g.table_name = r.table_name AND g.table_schema = 'public'
       WHERE r.scope = 'platform' AND g.grantee = 'solvenda_app'
         AND g.privilege_type <> 'SELECT'
       ORDER BY 1, 2`);
    expect(leaked).toEqual([]);
  });

  it('only grants the application role SELECT on platform tables marked self-readable', async () => {
    // `tenants` is the one table a firm reads about itself; the row filter is a
    // policy, not a convention. Any other SELECT grant here is a mistake.
    const unexpected = await query<{ table_name: string }>(`
      SELECT DISTINCT r.table_name
        FROM app.table_registry r
        JOIN information_schema.role_table_grants g
          ON g.table_name = r.table_name AND g.table_schema = 'public'
       WHERE r.scope = 'platform' AND g.grantee = 'solvenda_app'
         AND g.privilege_type = 'SELECT' AND r.self_readable = false
       ORDER BY 1`);
    expect(unexpected.map((r) => r.table_name)).toEqual([]);

    const missingPolicy = await query<{ table_name: string }>(`
      SELECT r.table_name FROM app.table_registry r
       WHERE r.self_readable
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = r.table_name
              AND p.policyname = r.table_name || '_self_read')
       ORDER BY 1`);
    expect(missingPolicy.map((r) => r.table_name)).toEqual([]);
  });

  it('keeps every database role free of BYPASSRLS', async () => {
    const bypassers = await query<{ rolname: string }>(`
      SELECT rolname FROM pg_roles
       WHERE rolname LIKE 'solvenda%' AND (rolbypassrls OR rolsuper)
       ORDER BY 1`);
    // A single BYPASSRLS grant would silently void every policy above.
    expect(bypassers.map((r) => r.rolname)).toEqual([]);
  });

  it('makes append-only tables genuinely append-only', async () => {
    const writable = await query<{ table_name: string; privilege_type: string }>(`
      SELECT r.table_name, g.privilege_type
        FROM app.table_registry r
        JOIN information_schema.role_table_grants g
          ON g.table_name = r.table_name AND g.table_schema = 'public'
       WHERE r.append_only
         AND g.grantee IN ('solvenda_app','solvenda_platform')
         AND g.privilege_type IN ('UPDATE','DELETE')
       ORDER BY 1, 2`);
    expect(writable).toEqual([]);

    const untriggered = await query<{ table_name: string }>(`
      SELECT r.table_name FROM app.table_registry r
       WHERE r.append_only
         AND NOT EXISTS (
           SELECT 1 FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relname = r.table_name AND t.tgname = r.table_name || '_append_only')
       ORDER BY 1`);
    expect(untriggered.map((r) => r.table_name)).toEqual([]);
  });
});
