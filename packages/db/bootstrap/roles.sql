-- Roles are created once per database cluster by an administrator, not by the
-- application. Passwords here are development defaults; production supplies
-- them through the secret manager.
--
--   solvenda_owner    owns the schema, runs migrations. NOBYPASSRLS so that
--                     even migration code cannot silently cross tenants.
--   solvenda_app      the application. No ownership, no BYPASSRLS.
--   solvenda_platform operator console only. Still NOBYPASSRLS: cross-tenant
--                     reads are granted by policy and require an explicit GUC.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_owner') THEN
    CREATE ROLE solvenda_owner LOGIN PASSWORD 'dev_owner_pw' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_app') THEN
    CREATE ROLE solvenda_app LOGIN PASSWORD 'dev_app_pw' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solvenda_platform') THEN
    CREATE ROLE solvenda_platform LOGIN PASSWORD 'dev_platform_pw' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
