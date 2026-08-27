-- =============================================================================
-- 0004  Let a tenant read its own directory row.
--
-- A firm legitimately needs its own name, branding, jurisdictions and settings
-- on every page. The first attempt used a SECURITY DEFINER accessor, which
-- failed for an instructive reason: FORCE ROW LEVEL SECURITY applies to the
-- table owner too, so running as the owner grants no extra visibility. That is
-- the isolation model working correctly, so the fix is a narrower policy rather
-- than a privileged escape hatch.
--
-- `tenants` stays platform-scoped for writes. Read access is exactly one row.
-- =============================================================================

ALTER TABLE app.table_registry
  ADD COLUMN IF NOT EXISTS self_readable boolean NOT NULL DEFAULT false;

DROP POLICY IF EXISTS tenants_self_read ON tenants;
CREATE POLICY tenants_self_read ON tenants
  FOR SELECT USING (id = app.current_tenant_id());

GRANT SELECT ON tenants TO solvenda_app;

UPDATE app.table_registry SET self_readable = true WHERE table_name = 'tenants';

-- Now that the policy exists, the accessor is an ordinary view over the table:
-- the application sees its own row and nothing else.
CREATE OR REPLACE FUNCTION app.current_tenant()
  RETURNS TABLE (id uuid, slug citext, legal_name text, trading_name text,
                 status text, data_region text, plan_key text,
                 jurisdictions text[], settings jsonb, branding jsonb)
  LANGUAGE sql STABLE AS $$
  SELECT t.id, t.slug, t.legal_name, t.trading_name, t.status, t.data_region,
         t.plan_key, t.jurisdictions, t.settings, t.branding
    FROM public.tenants t
   WHERE t.id = app.current_tenant_id()
$$;
GRANT EXECUTE ON FUNCTION app.current_tenant() TO solvenda_app;
