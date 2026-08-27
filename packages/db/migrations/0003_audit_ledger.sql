-- =============================================================================
-- 0003  Audit ledger.
--
-- Answers WHO / WHAT / WHEN / WHY / SOURCE / BEFORE / AFTER for every
-- consequential action, and does so in a form that cannot be quietly edited:
-- the table is append-only (trigger + revoked grants) and each row is chained
-- to its predecessor by SHA-256, per tenant. Deleting or altering history
-- breaks the chain and `app.verify_audit_chain()` reports exactly where.
-- =============================================================================

CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  seq           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  -- WHO
  actor_user_id uuid,
  actor_type    text NOT NULL
                CHECK (actor_type IN ('user','system','workflow','ai','api_key',
                                      'platform_operator','client','integration')),
  actor_label   text NOT NULL,

  -- WHAT
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid,
  case_id       uuid,

  -- WHY
  reason        text,
  -- SOURCE: where the instruction came from, e.g. 'console', 'client_portal',
  -- 'api:key_7f...', 'workflow:run_123', 'ai:ie_discrepancy@v3', 'migration:run_4'.
  source        text NOT NULL,

  -- BEFORE / AFTER
  before_state  jsonb,
  after_state   jsonb,
  -- Only the fields that actually changed, for fast review.
  changed_fields text[],

  request_id    text,
  ip            inet,
  user_agent    text,
  -- Set when the action was proposed by AI and confirmed by a human, linking
  -- the record to the invocation that suggested it.
  ai_invocation_id uuid,
  severity      text NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info','notable','regulated','security')),

  prev_hash     text NOT NULL,
  hash          text NOT NULL,

  UNIQUE (tenant_id, seq),
  UNIQUE (tenant_id, hash)
);

CREATE INDEX audit_events_case      ON audit_events (tenant_id, case_id, occurred_at DESC);
CREATE INDEX audit_events_resource  ON audit_events (tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_events_actor     ON audit_events (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX audit_events_action    ON audit_events (tenant_id, action, occurred_at DESC);
CREATE INDEX audit_events_severity  ON audit_events (tenant_id, severity, occurred_at DESC)
  WHERE severity IN ('regulated','security');

-- Chain heads. Not writable by the application or platform roles: only the
-- SECURITY DEFINER trigger below touches it.
CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  last_seq  bigint NOT NULL,
  last_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.audit_canonical_payload(e audit_events) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  -- jsonb renders object keys in a deterministic order, so this text form is
  -- stable across servers and versions.
  SELECT jsonb_build_object(
    'tenant_id',      e.tenant_id,
    'seq',            e.seq,
    'occurred_at',    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USZ'),
    'actor_user_id',  e.actor_user_id,
    'actor_type',     e.actor_type,
    'actor_label',    e.actor_label,
    'action',         e.action,
    'resource_type',  e.resource_type,
    'resource_id',    e.resource_id,
    'case_id',        e.case_id,
    'reason',         e.reason,
    'source',         e.source,
    'before_state',   e.before_state,
    'after_state',    e.after_state,
    'changed_fields', to_jsonb(e.changed_fields),
    'request_id',     e.request_id,
    'ai_invocation_id', e.ai_invocation_id,
    'severity',       e.severity
  )::text
$$;

CREATE OR REPLACE FUNCTION app.audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_prev_hash text;
  v_prev_seq  bigint;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'audit_events.tenant_id cannot be null' USING ERRCODE = '42501';
  END IF;

  -- Serialise chain construction per tenant. Concurrent writers to different
  -- tenants never contend.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  SELECT last_hash, last_seq INTO v_prev_hash, v_prev_seq
    FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  IF NOT FOUND THEN
    v_prev_hash := repeat('0', 64);
    v_prev_seq  := 0;
  END IF;

  NEW.seq       := v_prev_seq + 1;
  NEW.prev_hash := v_prev_hash;
  NEW.hash      := encode(
    digest(convert_to(v_prev_hash || app.audit_canonical_payload(NEW), 'UTF8'), 'sha256'),
    'hex');

  INSERT INTO audit_chain_heads(tenant_id, last_seq, last_hash)
       VALUES (NEW.tenant_id, NEW.seq, NEW.hash)
  ON CONFLICT (tenant_id)
  DO UPDATE SET last_seq = EXCLUDED.last_seq,
                last_hash = EXCLUDED.last_hash,
                updated_at = now();

  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_chain_link();

-- Recompute the chain and report the first divergence. Runs as a scheduled job
-- and on demand from the compliance console.
CREATE OR REPLACE FUNCTION app.verify_audit_chain(p_tenant_id uuid DEFAULT NULL)
  RETURNS TABLE (tenant_id uuid, checked bigint, ok boolean,
                 first_bad_seq bigint, detail text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  t uuid;
  r record;
  expect text;
  n bigint;
  bad bigint;
  msg text;
BEGIN
  FOR t IN
    SELECT DISTINCT e.tenant_id FROM audit_events e
     WHERE p_tenant_id IS NULL OR e.tenant_id = p_tenant_id
  LOOP
    expect := repeat('0', 64);
    n := 0; bad := NULL; msg := NULL;
    FOR r IN SELECT * FROM audit_events e WHERE e.tenant_id = t ORDER BY e.seq LOOP
      n := n + 1;
      IF r.prev_hash IS DISTINCT FROM expect THEN
        bad := r.seq; msg := 'prev_hash does not match preceding row';
        EXIT;
      END IF;
      IF r.seq <> n THEN
        bad := r.seq; msg := format('sequence gap: expected %s', n);
        EXIT;
      END IF;
      expect := encode(digest(convert_to(r.prev_hash || app.audit_canonical_payload(r), 'UTF8'), 'sha256'), 'hex');
      IF r.hash IS DISTINCT FROM expect THEN
        bad := r.seq; msg := 'row hash does not match its contents';
        EXIT;
      END IF;
    END LOOP;
    tenant_id := t; checked := n; ok := (bad IS NULL);
    first_bad_seq := bad; detail := msg;
    RETURN NEXT;
  END LOOP;
END $$;

SELECT app.apply_tenant_rls('audit_events');
SELECT app.apply_append_only('audit_events');
SELECT app.apply_platform_rls('audit_chain_heads');

-- Chain heads are maintained solely by the trigger.
REVOKE ALL ON audit_chain_heads FROM solvenda_app, solvenda_platform;
GRANT SELECT ON audit_chain_heads TO solvenda_platform;
GRANT EXECUTE ON FUNCTION app.verify_audit_chain(uuid) TO solvenda_app, solvenda_platform;
