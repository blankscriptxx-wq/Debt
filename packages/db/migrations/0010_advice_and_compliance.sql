-- =============================================================================
-- 0010  Eligibility, affordability, advice decisions, compliance checks.
--
-- The advice decision is the most consequential record in the platform. It is
-- append-only: superseding advice creates a new row and marks the old one,
-- because "what were they told, when, and on what basis" must survive both a
-- change of adviser and a change of mind.
--
-- A decision cannot be recorded without naming the human who made it, the
-- financial statement it rested on, the options considered, and why the
-- alternatives were rejected. Those are columns, not conventions.
-- =============================================================================

CREATE TABLE eligibility_evaluations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  statement_id   uuid REFERENCES financial_statements(id),
  -- The full fact set the rules were evaluated against, stored so an evaluation
  -- can be re-read and re-explained without recomputing from a case that has
  -- since moved on.
  facts          jsonb NOT NULL,
  -- One entry per case type considered, with each rule's outcome.
  results        jsonb NOT NULL,
  ruleset_fingerprint text NOT NULL,
  evaluated_at   timestamptz NOT NULL DEFAULT now(),
  evaluated_by   uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_case ON eligibility_evaluations (tenant_id, case_id, evaluated_at DESC);

CREATE TABLE affordability_assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  statement_id   uuid NOT NULL REFERENCES financial_statements(id),
  surplus_pence  bigint NOT NULL,
  -- What the client can sustainably pay, which is not always the surplus: an
  -- adviser may hold back a contingency for a vulnerable or volatile household.
  sustainable_payment_pence bigint NOT NULL,
  contingency_pence bigint NOT NULL DEFAULT 0,
  rationale      text,
  -- Where declared and observed expenditure diverge materially.
  discrepancies  jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessed_by    uuid REFERENCES users(id),
  assessed_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX affordability_case ON affordability_assessments (tenant_id, case_id, assessed_at DESC);

CREATE TABLE advice_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id),

  -- WHO. Always a person, never a service account. The competency they held at
  -- the time is copied in, because an adviser's sign-off can change later and
  -- the record must reflect the moment.
  decided_by     uuid NOT NULL REFERENCES users(id),
  decided_by_competencies text[] NOT NULL,
  decided_at     timestamptz NOT NULL DEFAULT now(),

  -- WHAT was advised, and what else was considered.
  recommended_case_type text NOT NULL,
  options_considered jsonb NOT NULL,
  rejected_options   jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale      text NOT NULL,
  risks_explained text[] NOT NULL DEFAULT '{}',
  client_response text CHECK (client_response IN
                   ('accepted','declined','deferred','considering','no-response')),
  client_responded_at timestamptz,

  -- The evidence the decision rested on.
  statement_id   uuid REFERENCES financial_statements(id),
  eligibility_evaluation_id uuid REFERENCES eligibility_evaluations(id),
  affordability_assessment_id uuid REFERENCES affordability_assessments(id),

  -- If an AI capability drafted the rationale, the invocation and what the
  -- adviser did with it. Never a substitute for the decision itself.
  ai_invocation_id uuid,
  ai_contribution text CHECK (ai_contribution IN ('none','drafted','suggested-options','summarised')),
  ai_output_accepted text CHECK (ai_output_accepted IN ('accepted','modified','rejected')),

  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','superseded','withdrawn')),
  superseded_by  uuid REFERENCES advice_decisions(id),
  supersede_reason text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advice_case ON advice_decisions (tenant_id, case_id, decided_at DESC);
CREATE UNIQUE INDEX advice_one_active ON advice_decisions (case_id) WHERE status = 'active';

CREATE TABLE compliance_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  rule_key       text NOT NULL,
  rule_version   int NOT NULL DEFAULT 1,
  severity       text NOT NULL DEFAULT 'blocking'
                 CHECK (severity IN ('blocking','warning','advisory')),
  outcome        text NOT NULL CHECK (outcome IN ('pass','fail','not-applicable','overridden')),
  detail         text,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  -- An override is a regulated act: a named person, a reason, and it is visible
  -- in reporting rather than quietly clearing the flag.
  overridden_by  uuid REFERENCES users(id),
  overridden_at  timestamptz,
  override_reason text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_case ON compliance_checks (tenant_id, case_id, checked_at DESC);
CREATE INDEX compliance_failures ON compliance_checks (tenant_id, outcome, severity)
  WHERE outcome = 'fail';

CREATE TABLE case_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  title         text NOT NULL,
  detail        text,
  task_type     text NOT NULL DEFAULT 'general',
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to   uuid REFERENCES users(id),
  assigned_team text,
  due_at        timestamptz,
  sla_breached  boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in-progress','blocked','done','cancelled')),
  -- Where the task came from: an adviser, a workflow, or an AI observation.
  created_via   text NOT NULL DEFAULT 'user'
                CHECK (created_via IN ('user','workflow','ai','system','integration')),
  source_reference text,
  completed_by  uuid REFERENCES users(id),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_tasks_assignee ON case_tasks (tenant_id, assigned_to, status, due_at);
CREATE INDEX case_tasks_case ON case_tasks (tenant_id, case_id, status);

SELECT app.apply_tenant_rls('eligibility_evaluations');
SELECT app.apply_tenant_rls('affordability_assessments');
SELECT app.apply_tenant_rls('advice_decisions');
SELECT app.apply_tenant_rls('compliance_checks');
SELECT app.apply_tenant_rls('case_tasks');

SELECT app.apply_touch_updated_at('case_tasks');

-- Advice decisions are never edited in place. Superseding is an INSERT plus a
-- narrow status update on the predecessor, so the trigger permits only that.
CREATE OR REPLACE FUNCTION app.advice_decisions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'advice decisions cannot be deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.rationale IS DISTINCT FROM OLD.rationale
     OR NEW.recommended_case_type IS DISTINCT FROM OLD.recommended_case_type
     OR NEW.options_considered IS DISTINCT FROM OLD.options_considered
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.statement_id IS DISTINCT FROM OLD.statement_id THEN
    RAISE EXCEPTION
      'the substance of an advice decision is immutable; record a superseding decision instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER advice_decisions_immutable
  BEFORE UPDATE OR DELETE ON advice_decisions
  FOR EACH ROW EXECUTE FUNCTION app.advice_decisions_guard();
