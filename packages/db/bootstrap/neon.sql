-- =============================================================================
-- Neon bootstrap.
--
-- Run this ONCE, in the Neon SQL editor, as the database owner the Vercel
-- integration created (usually `neondb_owner`), BEFORE the first migration.
--
-- The Vercel-Neon integration provisions one role. This platform needs three,
-- because the separation between them is the security control rather than a
-- convention: the application role owns nothing and cannot bypass row-level
-- security, so a query that forgets a tenant filter returns nothing instead of
-- another firm's clients. Collapsing them into a single owner role removes that
-- guarantee entirely, which is why this file exists rather than the app simply
-- using the connection string Neon hands out.
--
-- Two things here need the Neon owner and cannot be done by the migrations:
-- creating roles, and creating extensions.
--
-- Replace the three passwords before running. They must match PGPASSWORD_APP,
-- PGPASSWORD_PLATFORM and PGPASSWORD_OWNER in the deployment environment.
-- =============================================================================

-- Extensions. Migration 0001 also asks for these, but a non-superuser role
-- cannot create them on Neon, so they are established here first and the
-- migration's IF NOT EXISTS then finds them already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $bootstrap$
DECLARE
  app_pw      text := 'REPLACE_APP_PASSWORD';
  platform_pw text := 'REPLACE_PLATFORM_PASSWORD';
  owner_pw    text := 'REPLACE_OWNER_PASSWORD';
BEGIN
  -- NOBYPASSRLS on all three, the schema owner included. Under FORCE ROW LEVEL
  -- SECURITY, ownership grants no exemption, and that is deliberate.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_owner') THEN
    EXECUTE format('CREATE ROLE solvenda_owner LOGIN PASSWORD %L NOBYPASSRLS', owner_pw);
  ELSE
    EXECUTE format('ALTER ROLE solvenda_owner PASSWORD %L', owner_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_app') THEN
    EXECUTE format(
      'CREATE ROLE solvenda_app LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE',
      app_pw);
  ELSE
    EXECUTE format('ALTER ROLE solvenda_app PASSWORD %L', app_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_platform') THEN
    EXECUTE format(
      'CREATE ROLE solvenda_platform LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE',
      platform_pw);
  ELSE
    EXECUTE format('ALTER ROLE solvenda_platform PASSWORD %L', platform_pw);
  END IF;

  -- The migration runner connects as solvenda_owner and creates the schema, so
  -- it needs to be able to create objects. The other two get connect and usage
  -- only; every table-level grant they hold is issued by a migration.
  EXECUTE format('GRANT CREATE, CONNECT ON DATABASE %I TO solvenda_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO solvenda_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO solvenda_platform', current_database());

  GRANT CREATE, USAGE ON SCHEMA public TO solvenda_owner;
  GRANT USAGE ON SCHEMA public TO solvenda_app, solvenda_platform;

  -- Neon's own owner role should be able to inspect what the migrations create.
  EXECUTE format('GRANT solvenda_owner TO %I', current_user);
END
$bootstrap$;
