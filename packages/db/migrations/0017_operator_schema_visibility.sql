-- =============================================================================
-- 0017  Let operators see the schema migration record.
--
-- Solvenda Control reports which migrations are applied so an operator can tie
-- a schema state to a release. The bookkeeping table was owner-only, which
-- meant the health page failed on a permission error rather than reporting
-- anything - the operator console failing to load is a worse outcome than an
-- operator knowing which migrations have run.
--
-- Read only: migrations are applied by the migration role, never from the
-- console.
-- =============================================================================

GRANT SELECT ON app.schema_migrations TO solvenda_platform;
