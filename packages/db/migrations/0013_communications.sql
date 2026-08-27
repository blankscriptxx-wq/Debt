-- =============================================================================
-- 0013  Communications.
--
-- One table for every channel. Email, SMS, WhatsApp, a phone call, a letter and
-- a portal message are the same kind of thing from the case's point of view -
-- an interaction with a person - and modelling them separately is why timelines
-- in this market are incomplete. A single table means "everything that has been
-- said to this client" is one query, and the case timeline cannot quietly omit
-- a channel someone added later.
-- =============================================================================

CREATE TABLE communication_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  key           text NOT NULL,
  name          text NOT NULL,
  channel       text NOT NULL CHECK (channel IN
                  ('email','sms','whatsapp','letter','portal')),
  subject       text,
  body          text NOT NULL,
  -- Placeholders the template expects, so a missing value is caught before
  -- something with a visible {{gap}} reaches a client.
  required_variables text[] NOT NULL DEFAULT '{}',
  -- Plain-English checks a firm can enforce on its own templates.
  reading_age_target int NOT NULL DEFAULT 12,
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);

CREATE TABLE communications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  case_id       uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,

  channel       text NOT NULL CHECK (channel IN
                  ('email','sms','whatsapp','call','letter','portal','internal-note')),
  direction     text NOT NULL CHECK (direction IN ('inbound','outbound','internal')),

  counterparty_type text NOT NULL DEFAULT 'client'
                CHECK (counterparty_type IN ('client','creditor','introducer','third-party','internal')),
  counterparty_id uuid,
  counterparty_label text,

  subject       text,
  body          text,
  -- Redacted rendering used for AI context and for exports, so the original is
  -- never the thing that leaves.
  body_redacted text,

  template_key  text,
  template_version int,

  status        text NOT NULL DEFAULT 'sent' CHECK (status IN
                  ('draft','queued','sent','delivered','read','failed','bounced','received')),
  failure_reason text,

  -- Telephony
  call_direction text CHECK (call_direction IN ('inbound','outbound')),
  call_duration_seconds int,
  call_recording_document_id uuid REFERENCES documents(id),
  transcript    text,
  transcript_confidence numeric(4,3),
  -- An AI-generated summary of the call, accepted or edited by the adviser.
  call_summary  text,
  call_summary_invocation_id uuid,
  call_summary_accepted_by uuid REFERENCES users(id),

  -- Consent and preference enforcement, recorded at the moment of sending so a
  -- later change of preference does not rewrite what was permissible then.
  consent_basis text,
  channel_permitted boolean NOT NULL DEFAULT true,

  sent_by       uuid REFERENCES users(id),
  sent_by_type  text NOT NULL DEFAULT 'user'
                CHECK (sent_by_type IN ('user','workflow','system','client','integration')),
  provider      text,
  provider_message_id text,
  -- True while channel adapters are sandbox simulators rather than live
  -- integrations. Surfaced in the console so nobody believes a message went out.
  simulated     boolean NOT NULL DEFAULT true,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communications_case ON communications (tenant_id, case_id, occurred_at DESC);
CREATE INDEX communications_client ON communications (tenant_id, client_id, occurred_at DESC);
CREATE INDEX communications_channel ON communications (tenant_id, channel, occurred_at DESC);
CREATE INDEX communications_unanswered ON communications (tenant_id, client_id, direction, occurred_at)
  WHERE direction = 'outbound';

-- Internal notes and mentions live alongside client communications so the
-- timeline is genuinely complete, but are never disclosable to a client.
CREATE TABLE communication_mentions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  communication_id uuid NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (communication_id, mentioned_user_id)
);

SELECT app.apply_tenant_rls('communication_templates');
SELECT app.apply_tenant_rls('communications');
SELECT app.apply_tenant_rls('communication_mentions');
SELECT app.apply_touch_updated_at('communication_templates');
