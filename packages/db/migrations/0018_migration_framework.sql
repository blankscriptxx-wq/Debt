-- =============================================================================
-- 0018  Migration framework.
--
-- The single largest barrier to switching platform in this market is not price
-- or features - it is that a firm has fifteen years of case history in a system
-- it cannot leave. A migration that loses a note, a consent record or a
-- historic advice decision is not a migration; it is a compliance incident.
--
-- Hence: every run is recorded, every row is reconciled, and a firm can dry-run
-- as many times as it likes before anything is written.
-- =============================================================================

CREATE TABLE migration_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  source_system  text NOT NULL,
  source_version text,
  mode           text NOT NULL DEFAULT 'dry-run' CHECK (mode IN ('dry-run','live')),
  status         text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','rolled-back')),
  -- The field mapping in force for this run, stored so a later reconciliation
  -- can be interpreted even after the mapping has been edited.
  mapping        jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by     uuid REFERENCES users(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  error_detail   text
);
CREATE INDEX migration_runs_tenant ON migration_runs (tenant_id, started_at DESC);

-- One row per source record, whatever happened to it. This is what makes
-- reconciliation possible: a firm can ask "where did this client go" and get an
-- answer, including for records that were deliberately skipped.
CREATE TABLE migration_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  run_id         uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  entity         text NOT NULL,
  source_id      text NOT NULL,
  source_payload jsonb,
  target_table   text,
  target_id      uuid,
  outcome        text NOT NULL CHECK (outcome IN
                   ('created','updated','skipped','failed','deferred')),
  reason         text,
  -- Fields the source had that the mapping did not consume. Reported rather
  -- than dropped silently: unmapped data is how history gets lost.
  unmapped_fields text[] NOT NULL DEFAULT '{}',
  warnings       text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, entity, source_id)
);
CREATE INDEX migration_records_run ON migration_records (tenant_id, run_id, entity, outcome);

SELECT app.apply_tenant_rls('migration_runs');
SELECT app.apply_tenant_rls('migration_records');
SELECT app.apply_append_only('migration_records');
