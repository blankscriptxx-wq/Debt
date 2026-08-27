-- =============================================================================
-- 0011  The AI layer.
--
-- Three tables carry the entire safety model.
--
-- ai_invocations is the ledger: every call, what prompt version, which model,
-- which records it was permitted to see, what it cost, and what came back.
-- "Which records" is stored as identifiers rather than as the assembled text,
-- so a reviewer can reconstruct exactly what the model had access to without
-- the platform keeping a second copy of the client's personal data.
--
-- ai_proposals is the gate. AI output that would change anything on a case
-- lands here as a proposal, never as a write. A proposal touching a regulated
-- field can only be resolved by a person - enforced in @solvenda/auth, which
-- refuses `ai:accept_proposal` to any non-human principal.
--
-- ai_capabilities is the per-firm control surface: what is switched on, which
-- model, what the daily ceiling is.
-- =============================================================================

CREATE TABLE ai_capability_catalogue (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  description    text NOT NULL,
  category       text NOT NULL,
  -- The case fields this capability is permitted to see. Data minimisation is
  -- a property of the capability definition, not of the prompt.
  permitted_fields text[] NOT NULL DEFAULT '{}',
  -- Whether the capability may produce proposals, and whether any of those
  -- proposals can touch regulated information.
  produces_proposals boolean NOT NULL DEFAULT false,
  touches_regulated_fields boolean NOT NULL DEFAULT false,
  default_enabled boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_prompts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL REFERENCES ai_capability_catalogue(key),
  version       int NOT NULL,
  system_prompt text NOT NULL,
  user_template text NOT NULL,
  output_schema jsonb NOT NULL,
  notes         text,
  published_at  timestamptz NOT NULL DEFAULT now(),
  retired_at    timestamptz,
  UNIQUE (capability_key, version)
);

CREATE TABLE ai_capabilities (
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  capability_key text NOT NULL REFERENCES ai_capability_catalogue(key),
  enabled        boolean NOT NULL DEFAULT false,
  model          text,
  -- A firm can pin a prompt version so a platform change does not alter the
  -- behaviour of a capability it has already tested and signed off.
  pinned_prompt_version int,
  daily_invocation_limit int,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_key)
);

CREATE TABLE ai_invocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  capability_key text NOT NULL,
  prompt_version int NOT NULL,
  provider       text NOT NULL,
  model          text NOT NULL,

  case_id        uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE CASCADE,

  -- Who asked for it. A person, a workflow, or a scheduled job.
  requested_by   uuid REFERENCES users(id),
  requested_by_type text NOT NULL DEFAULT 'user'
                 CHECK (requested_by_type IN ('user','workflow','system','api_key')),
  source         text NOT NULL,

  -- Identifiers of the records the capability was permitted to read, so a
  -- reviewer can reconstruct the context without a second copy of the data.
  input_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_fingerprint text NOT NULL,
  redactions_applied text[] NOT NULL DEFAULT '{}',

  output         jsonb,
  output_valid   boolean NOT NULL DEFAULT false,
  confidence     numeric(4,3),

  status         text NOT NULL DEFAULT 'completed'
                 CHECK (status IN ('completed','failed','rejected-by-policy','timed-out')),
  error_detail   text,

  input_tokens   int,
  output_tokens  int,
  cost_pence     bigint,
  latency_ms     int,

  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_invocations_case ON ai_invocations (tenant_id, case_id, created_at DESC);
CREATE INDEX ai_invocations_capability ON ai_invocations (tenant_id, capability_key, created_at DESC);

CREATE TABLE ai_proposals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  invocation_id  uuid NOT NULL REFERENCES ai_invocations(id) ON DELETE CASCADE,
  case_id        uuid REFERENCES cases(id) ON DELETE CASCADE,

  proposal_type  text NOT NULL,
  target_table   text NOT NULL,
  target_id      uuid,
  target_field   text,

  current_value  jsonb,
  proposed_value jsonb NOT NULL,
  -- Why the model thinks so, in words an adviser can weigh. Never presented as
  -- a finding, always as something to check.
  reasoning      text NOT NULL,
  confidence     numeric(4,3),
  -- True when accepting this would change information carrying regulatory
  -- weight. Those proposals require a person holding ai:accept_proposal.
  touches_regulated_field boolean NOT NULL DEFAULT false,

  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','modified','rejected','expired','superseded')),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  -- What the person actually applied, when they changed the suggestion.
  applied_value  jsonb,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_proposals_case ON ai_proposals (tenant_id, case_id, status);
CREATE INDEX ai_proposals_pending ON ai_proposals (tenant_id, status, created_at)
  WHERE status = 'pending';

-- A proposal's substance is fixed once written: the model said what it said.
-- Only the decision fields may change, and only once.
CREATE OR REPLACE FUNCTION app.ai_proposals_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI proposals cannot be deleted; reject them instead' USING ERRCODE = '42501';
  END IF;

  IF NEW.proposed_value IS DISTINCT FROM OLD.proposed_value
     OR NEW.reasoning IS DISTINCT FROM OLD.reasoning
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.touches_regulated_field IS DISTINCT FROM OLD.touches_regulated_field THEN
    RAISE EXCEPTION 'the substance of an AI proposal is immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'proposal has already been decided (%)', OLD.status USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER ai_proposals_immutable
  BEFORE UPDATE OR DELETE ON ai_proposals
  FOR EACH ROW EXECUTE FUNCTION app.ai_proposals_guard();

-- Invocations are the audit record of what the model was asked and answered.
SELECT app.apply_global_rls('ai_capability_catalogue');
SELECT app.apply_global_rls('ai_prompts');
SELECT app.apply_tenant_rls('ai_capabilities');
SELECT app.apply_tenant_rls('ai_invocations');
SELECT app.apply_tenant_rls('ai_proposals');
SELECT app.apply_append_only('ai_invocations');
SELECT app.apply_touch_updated_at('ai_capability_catalogue');
