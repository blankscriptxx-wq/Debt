-- =============================================================================
-- 0014  Integration framework, API keys, webhooks.
--
-- Providers are not hard-coded. A category (Open Banking, credit reference,
-- KYC, e-signature, payments, telephony) has a contract; a provider implements
-- it; a firm installs the one it has a commercial relationship with. Changing
-- Open Banking provider should be a configuration change for the firm, not a
-- release for us - which is also what makes a marketplace possible later.
--
-- Credentials are encrypted with a per-tenant key derived from the platform
-- master key, so a database dump without the master key yields nothing usable.
-- =============================================================================

CREATE TABLE integration_providers (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN (
                   'open-banking','credit-reference','identity-verification','e-signature',
                   'payments','email','sms','whatsapp','telephony','accounting',
                   'document-storage','creditor-data','insolvency-service','companies-house','other')),
  description    text NOT NULL DEFAULT '',
  -- Configuration the firm supplies, as a JSON Schema the console renders.
  config_schema  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Named secrets the firm must provide. Never their values.
  required_secrets text[] NOT NULL DEFAULT '{}',
  scopes         text[] NOT NULL DEFAULT '{}',
  documentation_url text,
  -- True while the adapter is a sandbox simulator rather than a live
  -- integration. Surfaced everywhere it appears.
  simulated      boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','beta','deprecated','unavailable')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_installs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  provider_key   text NOT NULL REFERENCES integration_providers(key),
  status         text NOT NULL DEFAULT 'configuring'
                 CHECK (status IN ('configuring','active','paused','failed','removed')),
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Encrypted with pgcrypto using a per-tenant derived key; the plaintext never
  -- exists in a column and is never returned to the application.
  secrets_encrypted bytea,
  installed_by   uuid REFERENCES users(id),
  installed_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_key)
);

-- Every outbound call to a third party, recorded. A firm asked "what did you
-- send to the credit reference agency about me" must have an answer.
CREATE TABLE integration_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  install_id     uuid REFERENCES integration_installs(id) ON DELETE SET NULL,
  provider_key   text NOT NULL,
  operation      text NOT NULL,
  case_id        uuid REFERENCES cases(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE CASCADE,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb,
  status         text NOT NULL CHECK (status IN ('succeeded','failed','timed-out','declined')),
  error_detail   text,
  duration_ms    int,
  simulated      boolean NOT NULL DEFAULT true,
  requested_by   uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_calls_case ON integration_calls (tenant_id, case_id, created_at DESC);
CREATE INDEX integration_calls_provider ON integration_calls (tenant_id, provider_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  name           text NOT NULL,
  -- Only the hash is stored. The key is shown once, at creation.
  key_hash       text NOT NULL UNIQUE,
  key_prefix     text NOT NULL,
  -- Scopes are permission keys. A regulated permission here is refused at
  -- authorisation time regardless, but it is also rejected on creation so the
  -- mistake surfaces immediately rather than at 3am.
  scopes         text[] NOT NULL DEFAULT '{}',
  environment    text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','live')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  rate_limit_per_minute int NOT NULL DEFAULT 120
);
CREATE INDEX api_keys_active ON api_keys (tenant_id, revoked_at);

CREATE TABLE api_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  api_key_id     uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  method         text NOT NULL,
  path           text NOT NULL,
  status_code    int NOT NULL,
  duration_ms    int,
  ip             inet,
  idempotency_key text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_requests_key ON api_requests (tenant_id, api_key_id, created_at DESC);

CREATE TABLE webhook_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  url            text NOT NULL,
  description    text NOT NULL DEFAULT '',
  event_types    text[] NOT NULL DEFAULT '{}',
  -- Used to sign every delivery so the receiver can verify it came from us.
  signing_secret text NOT NULL,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','failing','disabled')),
  consecutive_failures int NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  endpoint_id    uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id       uuid NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  signature      text NOT NULL,
  attempt        int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','delivered','failed','abandoned')),
  response_status int,
  response_body  text,
  next_attempt_at timestamptz,
  delivered_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_pending
  ON webhook_deliveries (tenant_id, status, next_attempt_at) WHERE status = 'pending';

SELECT app.apply_global_rls('integration_providers');
SELECT app.apply_tenant_rls('integration_installs');
SELECT app.apply_tenant_rls('integration_calls');
SELECT app.apply_tenant_rls('api_keys');
SELECT app.apply_tenant_rls('api_requests');
SELECT app.apply_tenant_rls('webhook_endpoints');
SELECT app.apply_tenant_rls('webhook_deliveries');
SELECT app.apply_append_only('integration_calls');
SELECT app.apply_append_only('api_requests');
SELECT app.apply_touch_updated_at('integration_providers');
SELECT app.apply_touch_updated_at('integration_installs');
SELECT app.apply_touch_updated_at('webhook_endpoints');

-- Secrets never leave the database in plaintext. Encryption and decryption run
-- inside SECURITY DEFINER functions owned by the schema owner, using a
-- per-tenant key derived from the platform master key, so a stolen dump without
-- the master key is inert.
CREATE OR REPLACE FUNCTION app.tenant_secret_key(p_tenant_id uuid) RETURNS bytea
  LANGUAGE sql STABLE AS $$
  SELECT hmac(p_tenant_id::text,
              coalesce(current_setting('app.master_key', true), 'development-master-key'),
              'sha256')
$$;

CREATE OR REPLACE FUNCTION app.store_integration_secrets(p_install_id uuid, p_secrets jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM integration_installs WHERE id = p_install_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No such integration install'; END IF;
  IF v_tenant <> app.current_tenant_id() AND NOT app.is_platform_context() THEN
    RAISE EXCEPTION 'Cannot store secrets for another firm' USING ERRCODE = '42501';
  END IF;

  UPDATE integration_installs
     SET secrets_encrypted = pgp_sym_encrypt(p_secrets::text,
                               encode(app.tenant_secret_key(v_tenant), 'hex'))
   WHERE id = p_install_id;
END $$;

-- Deliberately no read-back accessor for the application: an adapter asks the
-- platform to make a call on its behalf rather than being handed a key. The
-- only reader is the integration runner, which runs as the owner.
CREATE OR REPLACE FUNCTION app.integration_secret(p_install_id uuid, p_name text)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app AS $$
DECLARE v_tenant uuid; v_blob bytea; v_json jsonb;
BEGIN
  SELECT tenant_id, secrets_encrypted INTO v_tenant, v_blob
    FROM integration_installs WHERE id = p_install_id;
  IF v_blob IS NULL THEN RETURN NULL; END IF;
  IF v_tenant <> app.current_tenant_id() AND NOT app.is_platform_context() THEN
    RAISE EXCEPTION 'Cannot read secrets for another firm' USING ERRCODE = '42501';
  END IF;
  v_json := pgp_sym_decrypt(v_blob, encode(app.tenant_secret_key(v_tenant), 'hex'))::jsonb;
  RETURN v_json ->> p_name;
END $$;

REVOKE EXECUTE ON FUNCTION app.integration_secret(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_integration_secrets(uuid, jsonb) TO solvenda_app;
