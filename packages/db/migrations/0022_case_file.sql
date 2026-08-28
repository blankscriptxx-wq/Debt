-- =============================================================================
-- 0022  The case file.
--
-- Until now the platform could read a case and not work one. The domain model
-- was complete enough for Case Intelligence, eligibility and advice to run, but
-- every figure in it arrived from the seed script: there was no adviser-facing
-- write path anywhere. This adds the structure the missing tabs need.
--
-- Most of what an adviser enters already had somewhere to go - debts, income,
-- expenditure, consents, vulnerability. What was genuinely absent is the detail
-- around a household: who else lives there, where the money comes from, what
-- the client owns, and the diary and verification work that surrounds a case.
-- =============================================================================

-- --- client detail -----------------------------------------------------------
-- Fields an adviser is asked for on first contact. Marital status and household
-- composition are not decoration: the Standard Financial Statement's trigger
-- figures are banded by household size, so these change what the client is
-- allowed to spend before an explanation is required.
ALTER TABLE clients
  ADD COLUMN marital_status text CHECK (marital_status IS NULL OR marital_status IN
    ('single','married','civil-partnership','cohabiting','separated','divorced','widowed')),
  -- Free text rather than an enum. A closed list here would be a decision about
  -- people's identities that a debt adviser has no business making, and nothing
  -- downstream computes on it.
  ADD COLUMN gender text,
  ADD COLUMN place_of_birth text,
  -- Asked when a client telephones. The question is stored plainly because the
  -- adviser has to read it out; the answer is a shared secret and is hashed
  -- with the same Argon2id parameters as a password.
  ADD COLUMN security_question text,
  ADD COLUMN security_answer_hash text,
  ADD COLUMN occupancy_status text CHECK (occupancy_status IS NULL OR occupancy_status IN
    ('owner-occupier','mortgaged','private-tenant','social-tenant','living-with-family',
     'lodger','supported-housing','temporary-accommodation','no-fixed-abode','other'));

-- --- debts -------------------------------------------------------------------
ALTER TABLE debts
  -- Distinct from account_reference: creditors commonly quote a customer number
  -- that differs from the account number, and correspondence is rejected when
  -- the wrong one is used.
  ADD COLUMN customer_number text,
  -- Hire purchase and conditional sale are not ordinary unsecured debt: the
  -- goods can be repossessed, which changes both the advice and the priority
  -- of the payment.
  ADD COLUMN is_credit_agreement boolean NOT NULL DEFAULT false;

-- --- income and expenditure --------------------------------------------------
-- What backs each figure. Separate from `source`, which records where the
-- number came from: a client can declare a figure that a payslip then proves,
-- and both facts matter at a file review.
ALTER TABLE financial_statement_lines
  ADD COLUMN evidence_status text NOT NULL DEFAULT 'none' CHECK (evidence_status IN
    ('none','verbal','document','open-banking','waived'));

-- --- household ---------------------------------------------------------------
CREATE TABLE household_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  full_name     text,
  relationship  text NOT NULL DEFAULT 'other' CHECK (relationship IN
                  ('partner','child','parent','sibling','other-relative','friend',
                   'lodger','carer','other')),
  date_of_birth date,
  -- Held when the date of birth is unknown, which is common for adult children
  -- and lodgers. One of the two is enough to band the trigger figures.
  age_years     int CHECK (age_years IS NULL OR (age_years >= 0 AND age_years < 130)),
  is_dependant  boolean NOT NULL DEFAULT false,
  -- A dependant who contributes to the household budget changes the figures,
  -- so it is recorded rather than assumed either way.
  contributes_to_household boolean NOT NULL DEFAULT false,
  contribution_pence bigint NOT NULL DEFAULT 0 CHECK (contribution_pence >= 0),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX household_members_client ON household_members (tenant_id, client_id);

-- --- employment --------------------------------------------------------------
CREATE TABLE employment_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Whose income this is. A partner's employment belongs on the file because
  -- the statement is a household one, but it is not the client's record.
  belongs_to    text NOT NULL DEFAULT 'client' CHECK (belongs_to IN ('client','partner')),
  status        text NOT NULL CHECK (status IN
                  ('employed','self-employed','unemployed','retired','student',
                   'carer','unable-to-work','homemaker','other')),
  employer_name text,
  job_title     text,
  contract_type text CHECK (contract_type IS NULL OR contract_type IN
                  ('permanent','fixed-term','zero-hours','agency','casual','contractor')),
  started_on    date,
  ended_on      date,
  is_current    boolean NOT NULL DEFAULT true,
  -- Take-home rather than gross, at the frequency the client is actually paid,
  -- because that is what they can tell you without looking anything up.
  net_pay_pence bigint CHECK (net_pay_pence IS NULL OR net_pay_pence >= 0),
  pay_frequency text NOT NULL DEFAULT 'monthly' CHECK (pay_frequency IN
                  ('weekly','fortnightly','four-weekly','monthly','quarterly','annually')),
  -- Variable pay is the single most common reason an income figure is wrong.
  -- Flagging it lets Case Intelligence ask for more than one payslip.
  income_varies boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX employment_records_client ON employment_records (tenant_id, client_id, is_current);

-- --- assets ------------------------------------------------------------------
-- A register rather than statement lines. Assets outlive any one statement, and
-- what matters for a DRO or a bankruptcy is the equity in a specific thing -
-- a vehicle over the value limit, or a property with a charge on it.
CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  asset_type    text NOT NULL CHECK (asset_type IN
                  ('property','vehicle','savings','investment','pension','business',
                   'insurance-policy','valuable-item','other')),
  description   text NOT NULL,
  estimated_value_pence bigint NOT NULL DEFAULT 0 CHECK (estimated_value_pence >= 0),
  -- What is owed against it. Equity is derived rather than stored so the two
  -- can never disagree.
  secured_debt_pence bigint NOT NULL DEFAULT 0 CHECK (secured_debt_pence >= 0),
  ownership     text NOT NULL DEFAULT 'sole' CHECK (ownership IN ('sole','joint','beneficial','none')),
  ownership_share_bps int NOT NULL DEFAULT 10000
                CHECK (ownership_share_bps BETWEEN 0 AND 10000),
  -- A vehicle needed to get to work, or adapted for a disability, is treated
  -- differently by the DRO rules. The exemption claimed is recorded with its
  -- reason so a file review can see the argument, not just the conclusion.
  exemption_claimed text,
  exemption_reason  text,
  valuation_basis text NOT NULL DEFAULT 'client-estimate' CHECK (valuation_basis IN
                  ('client-estimate','professional-valuation','trade-guide','statement','migrated')),
  valued_on     date,
  disposed_on   date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_client ON assets (tenant_id, client_id);
CREATE INDEX assets_case ON assets (tenant_id, case_id);

-- --- appointments ------------------------------------------------------------
CREATE TABLE appointments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  adviser_id    uuid REFERENCES users(id),
  purpose       text NOT NULL DEFAULT 'fact-find' CHECK (purpose IN
                  ('fact-find','advice','review','signing','follow-up','callback','other')),
  channel       text NOT NULL DEFAULT 'call' CHECK (channel IN
                  ('call','video','in-person','home-visit')),
  scheduled_for timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 30 CHECK (duration_minutes > 0),
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                  ('scheduled','completed','no-show','cancelled','rescheduled')),
  -- A missed appointment is an engagement signal, and a repeatedly missed one
  -- may be a vulnerability indicator. Recording the outcome rather than
  -- deleting the row is what makes that visible.
  outcome_note  text,
  rescheduled_to uuid REFERENCES appointments(id),
  cancelled_reason text,
  reminder_sent_at timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_diary ON appointments (tenant_id, scheduled_for, status);
CREATE INDEX appointments_case ON appointments (tenant_id, case_id);

-- --- verification ------------------------------------------------------------
-- The identity, address and income checks a firm must complete, tracked
-- individually. The requirements themselves come from the case type definition;
-- this records what was actually done about each one.
CREATE TABLE verification_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  requirement_key text NOT NULL,
  category      text NOT NULL DEFAULT 'identity' CHECK (category IN
                  ('identity','address','income','expenditure','debt','vulnerability','other')),
  status        text NOT NULL DEFAULT 'outstanding' CHECK (status IN
                  ('outstanding','received','verified','rejected','waived','not-applicable')),
  method        text CHECK (method IS NULL OR method IN
                  ('document','open-banking','credit-file','electronic-check','verbal','other')),
  document_id   uuid REFERENCES documents(id),
  -- Which integration call produced this, when one did, so an electronic check
  -- can be traced back to the request that made it.
  integration_call_id uuid REFERENCES integration_calls(id),
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  -- A waiver is a decision someone owns. It cannot be recorded without a
  -- reason, the same rule the audit ledger applies to regulated actions.
  waived_reason text,
  expires_on    date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'waived' OR waived_reason IS NOT NULL),
  UNIQUE (case_id, requirement_key)
);
CREATE INDEX verification_items_case ON verification_items (tenant_id, case_id, status);

-- --- policies ----------------------------------------------------------------
SELECT app.apply_tenant_rls('household_members');
SELECT app.apply_tenant_rls('employment_records');
SELECT app.apply_tenant_rls('assets');
SELECT app.apply_tenant_rls('appointments');
SELECT app.apply_tenant_rls('verification_items');

SELECT app.apply_touch_updated_at('household_members');
SELECT app.apply_touch_updated_at('employment_records');
SELECT app.apply_touch_updated_at('assets');
SELECT app.apply_touch_updated_at('appointments');
SELECT app.apply_touch_updated_at('verification_items');
