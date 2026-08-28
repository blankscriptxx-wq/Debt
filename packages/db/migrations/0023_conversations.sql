-- =============================================================================
-- 0023  Conversations.
--
-- 0013 modelled a message: one table for every channel, which is what makes a
-- complete timeline possible. What it did not model is a *conversation* — the
-- thread an adviser actually works in, with an owner, an unread state and a
-- place to put something the client sent. Without it there is a message log and
-- no inbox, which is the difference between a CRM and somewhere to work.
--
-- Four ideas here, and the third is the one that keeps clients apart.
--
--   channel_accounts    the firm's own numbers and addresses
--   conversations       a thread on one of them, with an owner
--   channel_identities  which identifier belongs to which client, and who said so
--   message_attachments what arrived, and whether we have it yet
--
-- A conversation deliberately does not require a client. A message from an
-- unrecognised number is a real conversation that a person has to resolve; the
-- alternative is guessing, and guessing attaches one client's bank statement to
-- another client's file.
-- =============================================================================

-- --- the firm's own channels -------------------------------------------------
-- One row per number or address the firm receives on. A firm with one WhatsApp
-- number and a firm with one per department are the same shape, so neither
-- needs a schema change or a special case.
CREATE TABLE channel_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  channel       text NOT NULL CHECK (channel IN
                  ('email','sms','whatsapp','call','portal')),
  -- The address as the outside world sees it: an E.164 number, a mailbox.
  identifier    text NOT NULL,
  display_name  text NOT NULL,
  -- Which provider carries it, and what it is called on their side. For
  -- WhatsApp this is the phone number id, which is what webhooks arrive with.
  provider_key  text,
  provider_account_id text,
  -- The queue conversations land in when nobody is assigned. A firm without
  -- departments leaves this null and everything lands in one place.
  queue         text,
  -- Outside these hours the out-of-office reply is offered to the adviser
  -- rather than sent automatically: an auto-reply that goes out while someone
  -- is mid-crisis is worse than silence.
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  out_of_office_message text,
  -- WhatsApp will not carry a business-initiated message without a recorded
  -- opt-in. Which consent purpose satisfies that is the firm's decision.
  requires_opt_in boolean NOT NULL DEFAULT true,
  opt_in_consent_purpose text,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','disconnected')),
  -- True while the channel is a sandbox simulator. Surfaced everywhere it
  -- matters, so nobody believes a message left the building.
  simulated     boolean NOT NULL DEFAULT true,
  connected_by  uuid REFERENCES users(id),
  connected_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, identifier)
);
CREATE INDEX channel_accounts_provider
  ON channel_accounts (provider_account_id) WHERE provider_account_id IS NOT NULL;

-- --- who an identifier belongs to --------------------------------------------
-- The whole safety of inbound routing rests on this table. A verified row is a
-- match; anything less is a suggestion for a person to confirm. Mobile numbers
-- are shared within a household and recycled between strangers, so "the number
-- matches a client record" is evidence, not proof.
CREATE TABLE channel_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email','sms','whatsapp','call','portal')),
  -- Normalised on write: E.164 for numbers, lowercased for addresses. Matching
  -- on a raw string is how "07700 900123" and "+447700900123" become two people.
  identifier    text NOT NULL,
  -- Null until a person has confirmed it. An unverified row is a candidate.
  verified_at   timestamptz,
  verified_by   uuid REFERENCES users(id),
  source        text NOT NULL DEFAULT 'adviser'
                CHECK (source IN ('adviser','client-portal','import','api','inferred')),
  -- Set when the client asks not to be contacted this way. Kept rather than
  -- deleted, so a later message is recognised and still refused.
  opted_out_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, identifier, client_id)
);
CREATE INDEX channel_identities_lookup
  ON channel_identities (tenant_id, channel, identifier);

-- --- the thread --------------------------------------------------------------
CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN
                  ('email','sms','whatsapp','call','portal','internal-note')),
  -- Who is on the other end, as they appear on the wire. Retained even after
  -- the conversation is linked, because it is what the next message arrives on.
  counterparty_identifier text NOT NULL,
  counterparty_label text,

  -- Both nullable, and that is the point: an unmatched conversation exists and
  -- is worked, rather than being guessed at or dropped.
  client_id     uuid REFERENCES clients(id) ON DELETE SET NULL,
  case_id       uuid REFERENCES cases(id) ON DELETE SET NULL,
  -- How the link was made, so a wrong one can be found again later.
  matched_by    text CHECK (matched_by IN ('verified-identity','adviser','portal','api')),
  matched_at    timestamptz,
  matched_by_user uuid REFERENCES users(id),

  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','pending','snoozed','closed')),
  -- Unassigned is a legitimate state, not a missing value: it is what the
  -- shared queue is made of.
  assigned_to   uuid REFERENCES users(id),
  assigned_at   timestamptz,
  queue         text,
  tags          text[] NOT NULL DEFAULT '{}',

  -- Unread is per conversation rather than per adviser: a shared inbox where
  -- everyone has their own unread count tells nobody whether the client has
  -- been answered, which is the only question that matters.
  first_unread_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  -- When a reply is owed by. Derived from the firm's own target, and null once
  -- the client has been answered.
  reply_due_at  timestamptz,

  snoozed_until timestamptz,
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One open thread per person per number. A second message from the same
  -- client is the same conversation, not a new one to be triaged again.
  UNIQUE (tenant_id, channel_account_id, counterparty_identifier)
);
CREATE INDEX conversations_inbox
  ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX conversations_assigned
  ON conversations (tenant_id, assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX conversations_unmatched
  ON conversations (tenant_id, last_message_at DESC) WHERE client_id IS NULL;
CREATE INDEX conversations_client
  ON conversations (tenant_id, client_id, last_message_at DESC);
CREATE INDEX conversations_due
  ON conversations (tenant_id, reply_due_at) WHERE reply_due_at IS NOT NULL;

-- Messages join a thread. Nullable because a letter or a recorded call is a
-- communication without a conversation, and forcing one would invent threads
-- nobody works in.
ALTER TABLE communications
  ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
CREATE INDEX communications_conversation
  ON communications (tenant_id, conversation_id, occurred_at);

-- --- what arrived ------------------------------------------------------------
-- An attachment exists before we hold it. WhatsApp media ids in a webhook stop
-- working after seven days and the download URL lasts about five minutes, so
-- fetching lazily when an adviser clicks "save" is a design that loses files.
-- The row is written on receipt, the bytes are fetched immediately after, and
-- `ingest_status` is the difference.
CREATE TABLE message_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  communication_id uuid NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,

  provider_media_id text,
  -- When the provider's copy stops being fetchable. After this, a failed
  -- ingest cannot be retried and has to be asked for again.
  provider_expires_at timestamptz,

  filename      text,
  content_type  text,
  byte_size     bigint,
  -- The provider supplies this; comparing it to what we stored is how we know
  -- the file did not change in transit.
  provider_sha256 text,
  -- Voice notes are their own thing: a client explaining their circumstances in
  -- speech is evidence, and it is not a document to be filed under payslips.
  media_kind    text CHECK (media_kind IN
                  ('image','document','audio','voice','video','sticker','contact','location')),

  ingest_status text NOT NULL DEFAULT 'pending' CHECK (ingest_status IN
                  ('pending','stored','quarantined','infected','failed','expired','skipped')),
  ingest_error  text,
  ingested_at   timestamptz,
  -- Null until the bytes are ours and scanned.
  document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_attachments_message
  ON message_attachments (tenant_id, communication_id);
CREATE INDEX message_attachments_pending
  ON message_attachments (ingest_status, created_at) WHERE ingest_status = 'pending';
CREATE INDEX message_attachments_unfiled
  ON message_attachments (tenant_id, conversation_id) WHERE document_id IS NOT NULL;

-- --- provenance --------------------------------------------------------------
-- Where a document came from, kept on the document rather than inferred from a
-- join, because "how did this get here" is the first question at a file review
-- and the answer must survive the conversation being closed.
ALTER TABLE documents
  ADD COLUMN source_communication_id uuid REFERENCES communications(id) ON DELETE SET NULL,
  ADD COLUMN source_channel text,
  -- Set when a person accepted a suggested classification unchanged, so
  -- "the AI chose this and nobody looked" is distinguishable from
  -- "someone read it and agreed".
  ADD COLUMN classification_accepted_by uuid REFERENCES users(id),
  ADD COLUMN classification_accepted_at timestamptz;

-- Documents arriving from a conversation are not yet part of a case file. They
-- are held, scanned, and filed by a person; until then they belong to nothing.
ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('active','superseded','deleted','quarantined','unfiled'));

-- --- templates ---------------------------------------------------------------
-- Approval belongs to the provider, not to us. A template can be active here
-- and rejected by Meta, and pretending otherwise means discovering it at the
-- moment somebody tries to answer a client.
ALTER TABLE communication_templates
  ADD COLUMN provider_key text,
  ADD COLUMN provider_template_id text,
  ADD COLUMN provider_status text CHECK (provider_status IN
    ('not-submitted','pending','approved','rejected','paused','disabled')),
  ADD COLUMN provider_rejection_reason text,
  -- Meta's category decides what a message costs and whether it may be sent at
  -- all outside the service window.
  ADD COLUMN provider_category text CHECK (provider_category IN
    ('marketing','utility','authentication','service')),
  ADD COLUMN language_code text NOT NULL DEFAULT 'en_GB';

SELECT app.apply_tenant_rls('channel_accounts');
SELECT app.apply_tenant_rls('channel_identities');
SELECT app.apply_tenant_rls('conversations');
SELECT app.apply_tenant_rls('message_attachments');

SELECT app.apply_touch_updated_at('channel_accounts');
SELECT app.apply_touch_updated_at('channel_identities');
SELECT app.apply_touch_updated_at('conversations');
SELECT app.apply_touch_updated_at('message_attachments');
