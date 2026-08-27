-- =============================================================================
-- 0012  Workflow engine.
--
-- Durable execution on Postgres rather than an in-memory scheduler, because the
-- deployment target is serverless and because a workflow that quietly stops
-- halfway through a regulated process is worse than one that never ran.
--
-- Every run, every step, every retry and every approval is a row. A run that
-- dies mid-flight is picked up by the next drain; a step that has already
-- succeeded is never re-executed, because the idempotency key is unique.
-- =============================================================================

CREATE TABLE workflow_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  key           text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','active','paused','retired')),
  -- The event that starts it, plus the conditions under which it applies.
  trigger_event text NOT NULL,
  -- Steps, branches, delays, approvals. Validated in @solvenda/workflow.
  definition    jsonb NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);
CREATE INDEX workflow_definitions_trigger
  ON workflow_definitions (tenant_id, trigger_event, status) WHERE status = 'active';

CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  definition_id uuid NOT NULL REFERENCES workflow_definitions(id),
  definition_key text NOT NULL,
  definition_version int NOT NULL,

  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,

  trigger_event text NOT NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Prevents the same event starting the same workflow twice, whatever the
  -- delivery guarantees of whatever emitted it.
  idempotency_key text NOT NULL,

  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','waiting','awaiting-approval','completed','failed','cancelled')),
  current_step  text,
  -- Accumulated step outputs, readable by later steps and by conditions.
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- A dry run evaluates every branch and records what it would have done,
  -- without performing a single action.
  dry_run       boolean NOT NULL DEFAULT false,

  started_at    timestamptz NOT NULL DEFAULT now(),
  resume_at     timestamptz,
  completed_at  timestamptz,
  error_detail  text,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX workflow_runs_resumable ON workflow_runs (tenant_id, status, resume_at)
  WHERE status IN ('running','waiting');
CREATE INDEX workflow_runs_case ON workflow_runs (tenant_id, case_id, started_at DESC);

CREATE TABLE workflow_step_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  run_id        uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key      text NOT NULL,
  step_type     text NOT NULL,
  sequence      int NOT NULL,
  status        text NOT NULL
                CHECK (status IN ('pending','running','succeeded','failed','skipped','waiting')),
  input         jsonb,
  output        jsonb,
  attempts      int NOT NULL DEFAULT 0,
  error_detail  text,
  -- What this step would have done, recorded on a dry run instead of doing it.
  simulated_effect jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (run_id, step_key, sequence)
);
CREATE INDEX workflow_step_runs_run ON workflow_step_runs (tenant_id, run_id, sequence);

CREATE TABLE workflow_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  run_id        uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key      text NOT NULL,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,

  title         text NOT NULL,
  detail        text NOT NULL,
  -- The permission an approver must hold. Where the workflow would touch
  -- regulated information this names a regulated permission, which the
  -- authorisation engine grants only to people.
  required_permission text NOT NULL,
  proposed_effect jsonb NOT NULL,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  assigned_to   uuid REFERENCES users(id),
  assigned_team text,
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  due_at        timestamptz,
  escalated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key)
);
CREATE INDEX workflow_approvals_pending
  ON workflow_approvals (tenant_id, status, due_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Job queue
--
-- Postgres-backed rather than Redis-backed: the deployment target is
-- serverless, the volumes here are modest, and keeping the queue in the same
-- transaction as the work means a job is never enqueued for a change that
-- rolled back.
-- ---------------------------------------------------------------------------

CREATE TABLE job_queue (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  job_type      text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','dead')),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE UNIQUE INDEX job_queue_idempotent
  ON job_queue (tenant_id, job_type, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX job_queue_claimable
  ON job_queue (status, run_after) WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Domain events
--
-- Workflows subscribe to events; the event log is also what feeds webhooks and
-- the case timeline, so an event emitted once reaches everything that cares.
-- ---------------------------------------------------------------------------

CREATE TABLE domain_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  event_type    text NOT NULL,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  resource_type text,
  resource_id   uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  emitted_by    uuid REFERENCES users(id),
  emitted_by_type text NOT NULL DEFAULT 'system',
  source        text NOT NULL DEFAULT 'system',
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_type ON domain_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX domain_events_case ON domain_events (tenant_id, case_id, occurred_at DESC);

SELECT app.apply_tenant_rls('workflow_definitions');
SELECT app.apply_tenant_rls('workflow_runs');
SELECT app.apply_tenant_rls('workflow_step_runs');
SELECT app.apply_tenant_rls('workflow_approvals');
SELECT app.apply_tenant_rls('job_queue');
SELECT app.apply_tenant_rls('domain_events');
SELECT app.apply_append_only('domain_events');
SELECT app.apply_touch_updated_at('workflow_definitions');
