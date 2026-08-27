-- =============================================================================
-- 0009  Financial position: SFS statements, consents, vulnerability, documents.
--
-- Financial statements are immutable snapshots. Correcting a figure supersedes
-- the statement rather than editing it, so the question "what did this file
-- look like when that advice was given?" always has an answer. That question is
-- the one an FOS complaint or an FCA file review actually asks.
-- =============================================================================

-- Spending guideline rulesets. The trigger figures themselves are licensed
-- content a firm supplies under its own SFS membership; the platform ships the
-- structure and a clearly-labelled placeholder set.
CREATE TABLE sfs_rulesets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version         text NOT NULL UNIQUE,
  source          text NOT NULL DEFAULT 'placeholder'
                  CHECK (source IN ('placeholder','firm-supplied')),
  effective_from  date NOT NULL,
  effective_to    date,
  -- Category trigger figures keyed by household composition.
  trigger_figures jsonb NOT NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financial_statements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id),
  version        int NOT NULL,
  format         text NOT NULL DEFAULT 'sfs' CHECK (format IN ('sfs','cfs','custom')),
  ruleset_id     uuid REFERENCES sfs_rulesets(id),
  ruleset_version text,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','current','superseded')),
  -- Computed totals, stored so a statement reads identically years later even
  -- if the calculation changes.
  total_income_pence      bigint NOT NULL DEFAULT 0,
  total_expenditure_pence bigint NOT NULL DEFAULT 0,
  surplus_pence           bigint NOT NULL DEFAULT 0,
  total_debt_pence        bigint NOT NULL DEFAULT 0,
  total_assets_pence      bigint NOT NULL DEFAULT 0,
  -- Categories exceeding their trigger figure, with the explanation the adviser
  -- recorded. The SFS expects an explanation, not a silent override.
  trigger_exceedances jsonb NOT NULL DEFAULT '[]'::jsonb,
  household_composition jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_by   uuid REFERENCES users(id),
  completed_at   timestamptz,
  superseded_by  uuid REFERENCES financial_statements(id),
  superseded_at  timestamptz,
  supersede_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, version)
);
CREATE UNIQUE INDEX financial_statements_one_current
  ON financial_statements (case_id) WHERE status = 'current';
CREATE INDEX financial_statements_case ON financial_statements (tenant_id, case_id, version DESC);

CREATE TABLE financial_statement_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  statement_id   uuid NOT NULL REFERENCES financial_statements(id) ON DELETE CASCADE,
  section        text NOT NULL CHECK (section IN ('income','expenditure','asset')),
  category       text NOT NULL,
  subcategory    text,
  label          text,
  -- Always normalised to a monthly amount on write; the entered frequency is
  -- retained so the client sees the figure they actually gave.
  amount_pence   bigint NOT NULL,
  entered_amount_pence bigint,
  entered_frequency text NOT NULL DEFAULT 'monthly' CHECK (entered_frequency IN
                   ('weekly','fortnightly','four-weekly','monthly','quarterly','annually','one-off')),
  -- Declared by the client, observed in bank data, or extracted from a
  -- document. Keeping these distinct is what makes discrepancy detection
  -- possible without ever overwriting what the client actually said.
  source         text NOT NULL DEFAULT 'declared' CHECK (source IN
                   ('declared','observed','document-extracted','adviser-adjusted','migrated')),
  observed_amount_pence bigint,
  observed_confidence numeric(4,3),
  trigger_figure_pence  bigint,
  exceeds_trigger boolean NOT NULL DEFAULT false,
  explanation    text,
  evidence_document_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fsl_statement ON financial_statement_lines (tenant_id, statement_id, section);

-- ---------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------

CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  purpose       text NOT NULL,
  -- Article 6 basis, and where relevant the Article 9 condition. Recorded
  -- explicitly because vulnerability and health information routinely needs
  -- both, and "we had consent" is not by itself an answer.
  lawful_basis  text NOT NULL CHECK (lawful_basis IN
                  ('consent','contract','legal-obligation','vital-interests',
                   'public-task','legitimate-interests')),
  special_category_condition text,
  -- The exact wording the client saw, so the record survives a copy change.
  statement_version text NOT NULL,
  statement_text    text NOT NULL,
  granted       boolean NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  captured_via  text NOT NULL CHECK (captured_via IN
                  ('client-portal','telephone','in-person','document','e-signature','api','migrated')),
  captured_by   uuid REFERENCES users(id),
  evidence_reference text,
  expires_at    timestamptz,
  withdrawn_at  timestamptz,
  withdrawn_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_client_purpose ON consents (tenant_id, client_id, purpose, granted_at DESC);

-- ---------------------------------------------------------------------------
-- Vulnerability
-- ---------------------------------------------------------------------------

CREATE TABLE vulnerability_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  -- FG21/1 frames vulnerability through four drivers. Modelling them
  -- explicitly is what allows outcome monitoring by driver later.
  driver        text NOT NULL CHECK (driver IN ('health','life-event','resilience','capability')),
  indicators    text[] NOT NULL DEFAULT '{}',
  severity      text NOT NULL DEFAULT 'possible'
                CHECK (severity IN ('possible','present','significant')),
  -- Health-related detail is special category data. It is only stored when a
  -- consent row explicitly permits it, enforced in @solvenda/core.
  is_special_category boolean NOT NULL DEFAULT false,
  consent_id    uuid REFERENCES consents(id),
  detail        text,
  support_needs text[] NOT NULL DEFAULT '{}',
  adjustments_agreed text[] NOT NULL DEFAULT '{}',
  -- What may be disclosed to a creditor is a deliberate decision, never a side
  -- effect of exporting the case.
  disclosable_to_creditors boolean NOT NULL DEFAULT false,
  disclosure_wording text,
  identified_by uuid REFERENCES users(id),
  identified_via text NOT NULL DEFAULT 'adviser-assessment' CHECK (identified_via IN
                  ('adviser-assessment','client-disclosure','third-party','ai-indicator','migrated')),
  -- When an AI capability surfaced the signal, the invocation that did so.
  ai_invocation_id uuid,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','resolved','superseded','withdrawn')),
  reviewed_at   timestamptz,
  review_due    date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vulnerability_client ON vulnerability_records (tenant_id, client_id, status);
CREATE INDEX vulnerability_case ON vulnerability_records (tenant_id, case_id, status);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  storage_key   text NOT NULL,
  storage_provider text NOT NULL DEFAULT 'local',
  document_type text,
  classification_confidence numeric(4,3),
  classified_by text CHECK (classified_by IN ('user','ai','integration','migration')),
  extracted_data jsonb,
  direction     text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound','internal')),
  uploaded_by   uuid REFERENCES users(id),
  uploaded_via  text NOT NULL DEFAULT 'console',
  -- Signature state, when the document is part of an e-signature flow.
  signature_status text CHECK (signature_status IN
                  ('not-required','pending','signed','declined','expired')),
  signed_at     timestamptz,
  signature_evidence jsonb,
  retention_class text NOT NULL DEFAULT 'case-file',
  delete_after  date,
  legal_hold    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_case ON documents (tenant_id, case_id, status);
CREATE INDEX documents_retention ON documents (tenant_id, delete_after)
  WHERE legal_hold = false AND status = 'active';

SELECT app.apply_global_rls('sfs_rulesets');
SELECT app.apply_tenant_rls('financial_statements');
SELECT app.apply_tenant_rls('financial_statement_lines');
SELECT app.apply_tenant_rls('consents');
SELECT app.apply_tenant_rls('vulnerability_records');
SELECT app.apply_tenant_rls('documents');

SELECT app.apply_touch_updated_at('financial_statements');
SELECT app.apply_touch_updated_at('vulnerability_records');
SELECT app.apply_touch_updated_at('documents');
