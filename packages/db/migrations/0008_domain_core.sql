-- =============================================================================
-- 0008  Domain core.
--
-- Two decisions run through this migration.
--
-- Money is stored as integer pence in bigint columns. Never floating point:
-- a penny of drift in a surplus calculation is a wrong DMP payment, and in an
-- IVA it is a wrong dividend.
--
-- Case types are data, not code. DMP, IVA, DRO, bankruptcy, Trust Deed,
-- sequestration and Breathing Space are rows in case_type_definitions, holding
-- their own stages, required evidence, eligibility rules and review cadence.
-- Adding a case type must not require a schema change - there is a test that
-- asserts exactly that.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Case type configuration
-- ---------------------------------------------------------------------------

-- Platform-published starting points, copied into a firm on provisioning.
CREATE TABLE case_type_templates (
  key           text PRIMARY KEY,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  category      text NOT NULL CHECK (category IN
                  ('debt-management','insolvency','statutory-moratorium','servicing','other')),
  jurisdictions text[] NOT NULL DEFAULT ARRAY['england-wales'],
  version       int NOT NULL DEFAULT 1,
  definition    jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE case_type_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  key           text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  category      text NOT NULL,
  jurisdictions text[] NOT NULL DEFAULT ARRAY['england-wales'],
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  template_key  text REFERENCES case_type_templates(key),
  -- Stages, required evidence, eligibility rules, documents, review cadence.
  -- Validated against a Zod schema in @solvenda/core before it is written.
  definition    jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);
CREATE INDEX case_type_definitions_active ON case_type_definitions (tenant_id, key, status);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  reference      text NOT NULL,
  title          text,
  first_name     text NOT NULL,
  middle_names   text,
  last_name      text NOT NULL,
  previous_names text[] NOT NULL DEFAULT '{}',
  date_of_birth  date,
  national_insurance_number text,
  email          citext,
  phone_mobile   text,
  phone_other    text,
  address_line1  text,
  address_line2  text,
  address_city   text,
  address_postcode text,
  address_country text NOT NULL DEFAULT 'GB',
  residency_status text,
  -- Which statutory regime applies to this person. Drives which case types and
  -- rules are available; Scotland is a different world, not a variation.
  jurisdiction   text NOT NULL DEFAULT 'england-wales'
                 CHECK (jurisdiction IN ('england-wales','scotland','northern-ireland')),
  household_adults int NOT NULL DEFAULT 1,
  household_children int NOT NULL DEFAULT 0,
  employment_status text,
  -- Channel and contact-time preferences, honoured by the communications layer.
  contact_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Accessibility and communication adjustments the firm has agreed to make.
  communication_adjustments jsonb NOT NULL DEFAULT '{}'::jsonb,
  portal_user_id uuid REFERENCES users(id),
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','inactive','deceased','closed')),
  introducer_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);
CREATE INDEX clients_name ON clients (tenant_id, last_name, first_name);
CREATE INDEX clients_postcode ON clients (tenant_id, address_postcode);

-- Joint applications and household links, without duplicating the person.
CREATE TABLE client_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  linked_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  relationship text NOT NULL CHECK (relationship IN
                 ('partner','spouse','joint-applicant','household-member','representative')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, linked_client_id, relationship),
  CHECK (client_id <> linked_client_id)
);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

CREATE TABLE cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  reference       text NOT NULL,
  client_id       uuid NOT NULL REFERENCES clients(id),
  -- The case type is resolved at creation and pinned to a version, so a
  -- configuration change tomorrow does not silently restate what happened today.
  case_type_key   text NOT NULL,
  case_type_version int NOT NULL,
  jurisdiction    text NOT NULL DEFAULT 'england-wales',
  stage           text NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','on-hold','closed','withdrawn','transferred')),
  owner_user_id   uuid REFERENCES users(id),
  team            text,
  source          text,
  introducer_id   uuid,
  -- Set when this case succeeded an earlier one, e.g. DMP converting to IVA.
  predecessor_case_id uuid REFERENCES cases(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  next_review_due date,
  closed_at       timestamptz,
  closure_reason  text,
  closure_outcome text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);
CREATE INDEX cases_client ON cases (tenant_id, client_id);
CREATE INDEX cases_owner_stage ON cases (tenant_id, owner_user_id, status, stage);
CREATE INDEX cases_review_due ON cases (tenant_id, next_review_due) WHERE status = 'open';

CREATE TABLE case_participants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id    uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES clients(id),
  role       text NOT NULL CHECK (role IN ('primary','joint','representative','appointee')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, client_id, role)
);

CREATE TABLE case_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_stage    text,
  to_stage      text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  duration_seconds bigint,
  moved_by      uuid REFERENCES users(id),
  reason        text
);
CREATE INDEX case_stage_history_case ON case_stage_history (tenant_id, case_id, entered_at);

-- ---------------------------------------------------------------------------
-- Creditors and debts
-- ---------------------------------------------------------------------------

-- Shared reference data: the canonical list of creditors, their known trading
-- names and correspondence routes. Maintained by the platform so every firm
-- benefits from a correction, and so debt matching has something to match on.
CREATE TABLE creditor_registry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL UNIQUE,
  trading_names  text[] NOT NULL DEFAULT '{}',
  creditor_type  text NOT NULL DEFAULT 'unknown',
  companies_house_number text,
  correspondence_email citext,
  correspondence_address jsonb,
  accepts_electronic_proposals boolean NOT NULL DEFAULT false,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creditor_registry_trading ON creditor_registry USING gin (trading_names);

CREATE TABLE tenant_creditors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  registry_id     uuid REFERENCES creditor_registry(id),
  name            text NOT NULL,
  creditor_type   text NOT NULL DEFAULT 'unknown',
  correspondence_email citext,
  correspondence_address jsonb,
  reference_format text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE debts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id),
  creditor_id     uuid REFERENCES tenant_creditors(id),
  creditor_name   text NOT NULL,
  account_reference text,
  debt_type       text NOT NULL DEFAULT 'unsecured' CHECK (debt_type IN
                    ('unsecured','secured','priority','student-loan','court-fine',
                     'benefit-overpayment','tax','child-maintenance','joint','business','other')),
  -- Priority debts cannot be included in most solutions and carry the harshest
  -- consequences for non-payment, so they are separated structurally rather
  -- than by a category label.
  is_priority     boolean NOT NULL DEFAULT false,
  balance_pence   bigint NOT NULL CHECK (balance_pence >= 0),
  original_balance_pence bigint,
  arrears_pence   bigint NOT NULL DEFAULT 0,
  contractual_payment_pence bigint,
  interest_rate_bps int,
  is_joint        boolean NOT NULL DEFAULT false,
  in_dispute      boolean NOT NULL DEFAULT false,
  is_statute_barred boolean NOT NULL DEFAULT false,
  included_in_solution boolean NOT NULL DEFAULT true,
  -- Where this figure came from, and how much weight it carries.
  provenance      text NOT NULL DEFAULT 'client-declared' CHECK (provenance IN
                    ('client-declared','credit-file','creditor-confirmed','document-extracted',
                     'open-banking','migrated','adviser-entered')),
  provenance_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at    timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN
                    ('active','settled','written-off','removed','duplicate','transferred')),
  duplicate_of_debt_id uuid REFERENCES debts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debts_case ON debts (tenant_id, case_id, status);
CREATE INDEX debts_creditor ON debts (tenant_id, creditor_id);

SELECT app.apply_global_rls('case_type_templates');
SELECT app.apply_global_rls('creditor_registry');
SELECT app.apply_tenant_rls('case_type_definitions');
SELECT app.apply_tenant_rls('clients');
SELECT app.apply_tenant_rls('client_links');
SELECT app.apply_tenant_rls('cases');
SELECT app.apply_tenant_rls('case_participants');
SELECT app.apply_tenant_rls('case_stage_history');
SELECT app.apply_tenant_rls('tenant_creditors');
SELECT app.apply_tenant_rls('debts');

SELECT app.apply_touch_updated_at('case_type_templates');
SELECT app.apply_touch_updated_at('case_type_definitions');
SELECT app.apply_touch_updated_at('clients');
SELECT app.apply_touch_updated_at('cases');
SELECT app.apply_touch_updated_at('creditor_registry');
SELECT app.apply_touch_updated_at('tenant_creditors');
SELECT app.apply_touch_updated_at('debts');
