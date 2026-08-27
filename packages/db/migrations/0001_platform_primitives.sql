-- =============================================================================
-- 0001  Platform primitives: security context, tenancy helpers, conventions.
--
-- The security model in one paragraph:
--   The application connects as `solvenda_app`, a role which is NOT the owner
--   of any table and has NOBYPASSRLS. Every tenant-scoped table FORCEs row
--   level security and carries `tenant_id uuid NOT NULL DEFAULT
--   app.current_tenant_id()`. The policy compares that column to the tenant id
--   stashed in the transaction-local GUC `app.tenant_id`. Consequently:
--     * a SELECT written without a tenant filter returns zero rows, and
--     * an INSERT/UPDATE that would place a row in another tenant fails.
--   Neither outcome depends on a developer remembering anything.
--
--   Cross-tenant reads exist for platform operators only, and require BOTH a
--   different database role (`solvenda_platform`) AND an explicit GUC. The
--   application role cannot escalate into that path by setting a variable.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Security context accessors
-- ---------------------------------------------------------------------------

-- Returns the tenant bound to the current transaction, or NULL when unbound.
-- NULL is deliberate: `tenant_id = NULL` is NULL, which RLS treats as false, so
-- an unbound transaction reads nothing and writes nothing. Fail closed.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_request_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.request_id', true), '')
$$;

-- Platform (cross-tenant) context. Requires the dedicated database role as well
-- as the GUC, so application code running as solvenda_app cannot reach it even
-- if it sets the variable.
CREATE OR REPLACE FUNCTION app.is_platform_context() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT current_user = 'solvenda_platform'
     AND coalesce(current_setting('app.platform_context', true), '') = 'on'
$$;

-- Actor description used by audit triggers and defaults.
CREATE OR REPLACE FUNCTION app.current_actor_type() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(NULLIF(current_setting('app.actor_type', true), ''), 'system')
$$;

-- ---------------------------------------------------------------------------
-- Conventions applied to every tenant-scoped table
-- ---------------------------------------------------------------------------

-- Marker table: records which tables are intentionally tenant-scoped and which
-- are intentionally global. The conformance test in packages/db asserts that
-- every table in `public` appears here, so a new table cannot be added without
-- an explicit, reviewed decision about its tenancy.
CREATE TABLE IF NOT EXISTS app.table_registry (
  table_name  text PRIMARY KEY,
  scope       text NOT NULL CHECK (scope IN ('tenant', 'global', 'platform')),
  append_only boolean NOT NULL DEFAULT false,
  note        text,
  registered_at timestamptz NOT NULL DEFAULT now()
);

-- Applies the full tenant-isolation convention to a table:
--   RLS enabled + FORCEd, isolation policy, grants for the app role.
CREATE OR REPLACE FUNCTION app.apply_tenant_rls(p_table text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_table || '_tenant_isolation', p_table);
  EXECUTE format($p$
    CREATE POLICY %I ON public.%I
      USING (tenant_id = app.current_tenant_id() OR app.is_platform_context())
      WITH CHECK (tenant_id = app.current_tenant_id() OR app.is_platform_context())
  $p$, p_table || '_tenant_isolation', p_table);

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO solvenda_app', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO solvenda_platform', p_table);

  INSERT INTO app.table_registry(table_name, scope)
       VALUES (p_table, 'tenant')
  ON CONFLICT (table_name) DO UPDATE SET scope = 'tenant';
END $$;

-- Global reference data: readable by everyone, writable only by platform.
CREATE OR REPLACE FUNCTION app.apply_global_rls(p_table text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_table || '_global_read', p_table);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (true)',
                 p_table || '_global_read', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_table || '_platform_write', p_table);
  EXECUTE format($p$
    CREATE POLICY %I ON public.%I FOR ALL
      USING (app.is_platform_context()) WITH CHECK (app.is_platform_context())
  $p$, p_table || '_platform_write', p_table);

  EXECUTE format('GRANT SELECT ON public.%I TO solvenda_app', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO solvenda_platform', p_table);

  INSERT INTO app.table_registry(table_name, scope)
       VALUES (p_table, 'global')
  ON CONFLICT (table_name) DO UPDATE SET scope = 'global';
END $$;

-- Platform-only tables (tenant directory, billing, operator accounts). Not
-- visible to the application role at all.
CREATE OR REPLACE FUNCTION app.apply_platform_rls(p_table text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p_table || '_platform_only', p_table);
  EXECUTE format($p$
    CREATE POLICY %I ON public.%I FOR ALL
      USING (app.is_platform_context()) WITH CHECK (app.is_platform_context())
  $p$, p_table || '_platform_only', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO solvenda_platform', p_table);

  INSERT INTO app.table_registry(table_name, scope)
       VALUES (p_table, 'platform')
  ON CONFLICT (table_name) DO UPDATE SET scope = 'platform';
END $$;

-- Append-only enforcement. Used by the audit ledger and any other table where
-- history must not be rewritten, including by the schema owner.
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is append-only; % is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;

CREATE OR REPLACE FUNCTION app.apply_append_only(p_table text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', p_table || '_append_only', p_table);
  EXECUTE format($p$
    CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()
  $p$, p_table || '_append_only', p_table);

  EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM solvenda_app', p_table);
  EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM solvenda_platform', p_table);

  UPDATE app.table_registry SET append_only = true WHERE table_name = p_table;
END $$;

-- Standard updated_at maintenance.
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.apply_touch_updated_at(p_table text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', p_table || '_touch', p_table);
  EXECUTE format($p$
    CREATE TRIGGER %I BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()
  $p$, p_table || '_touch', p_table);
END $$;

GRANT USAGE ON SCHEMA app TO solvenda_app, solvenda_platform;
GRANT SELECT ON app.table_registry TO solvenda_app, solvenda_platform;
