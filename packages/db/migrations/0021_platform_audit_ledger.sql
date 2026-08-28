-- =============================================================================
-- 0021  Platform audit ledger.
--
-- Operator sign-in has to be auditable, and it cannot go in `audit_events`:
-- that table is tenant-scoped (tenant_id NOT NULL) and its hash chain is per
-- tenant, because that is what makes "show me everything that happened to this
-- firm's files" a complete answer. An operator signing in belongs to no firm.
--
-- So platform activity gets its own ledger with the same guarantees rather than
-- weaker ones: append-only at the trigger level, hash-chained, and verifiable.
-- The only structural difference is that there is one chain instead of one per
-- tenant, so the head table holds a single row.
--
-- Until now `platform.impersonation.started` and its siblings existed in the
-- audit vocabulary with nothing able to write them. This is where they land.
-- =============================================================================

CREATE TABLE platform_audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),

  -- WHO
  actor_operator_id uuid REFERENCES platform_operators(id),
  actor_label   text NOT NULL,
  -- WHAT
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid,
  -- WHY
  reason        text,
  -- WHERE FROM
  source        text NOT NULL,
  ip            inet,
  user_agent    text,
  -- The firm concerned, when there is one. Nullable by design: a sign-in has
  -- no tenant, an impersonation grant does.
  tenant_id     uuid REFERENCES tenants(id),
  severity      text NOT NULL DEFAULT 'security'
                CHECK (severity IN ('info','notable','security','regulated')),

  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  UNIQUE (seq)
);
CREATE INDEX platform_audit_events_recent ON platform_audit_events (occurred_at DESC);
CREATE INDEX platform_audit_events_actor
  ON platform_audit_events (actor_operator_id, occurred_at DESC);

-- One chain, so one row. Lives in the `app` schema for the same reason the
-- tenant chain head does: a table in `public` carries a policy the trigger
-- cannot satisfy, which blocks every audit write.
CREATE TABLE app.platform_audit_chain_head (
  only_row   boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.platform_audit_canonical_payload(e platform_audit_events)
  RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'seq',            e.seq,
    'occurred_at',    e.occurred_at,
    'actor_operator_id', e.actor_operator_id,
    'actor_label',    e.actor_label,
    'action',         e.action,
    'resource_type',  e.resource_type,
    'resource_id',    e.resource_id,
    'reason',         e.reason,
    'source',         e.source,
    'tenant_id',      e.tenant_id,
    'severity',       e.severity
  )::text
$$;

CREATE OR REPLACE FUNCTION app.platform_audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_prev_hash text;
  v_prev_seq  bigint;
BEGIN
  -- Serialise writers so two concurrent inserts cannot fork the chain.
  PERFORM pg_advisory_xact_lock(hashtext('platform_audit_chain'));

  SELECT last_hash, last_seq INTO v_prev_hash, v_prev_seq
    FROM app.platform_audit_chain_head WHERE only_row FOR UPDATE;

  IF NOT FOUND THEN
    v_prev_hash := repeat('0', 64);
    v_prev_seq  := 0;
  END IF;

  NEW.seq := v_prev_seq + 1;
  NEW.prev_hash := v_prev_hash;
  NEW.hash := encode(
    digest(convert_to(v_prev_hash || app.platform_audit_canonical_payload(NEW), 'UTF8'),
           'sha256'),
    'hex');

  INSERT INTO app.platform_audit_chain_head(only_row, last_seq, last_hash)
       VALUES (true, NEW.seq, NEW.hash)
  ON CONFLICT (only_row)
  DO UPDATE SET last_seq = EXCLUDED.last_seq,
                last_hash = EXCLUDED.last_hash,
                updated_at = now();

  RETURN NEW;
END $$;

CREATE TRIGGER platform_audit_events_chain
  BEFORE INSERT ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.platform_audit_chain_link();

-- Recompute and report the first divergence. Runs as its caller, not as the
-- owner: under FORCE RLS the owner sees nothing, and a verifier that silently
-- reports zero rows checked is worse than none.
CREATE OR REPLACE FUNCTION app.verify_platform_audit_chain()
  RETURNS TABLE (checked bigint, ok boolean, first_bad_seq bigint, detail text)
  LANGUAGE plpgsql AS $$
DECLARE
  r        platform_audit_events%ROWTYPE;
  expect   text;
  prev     text := repeat('0', 64);
  n        bigint := 0;
  bad      bigint := NULL;
  msg      text := NULL;
BEGIN
  FOR r IN SELECT * FROM platform_audit_events ORDER BY seq LOOP
    n := n + 1;
    IF r.prev_hash IS DISTINCT FROM prev THEN
      bad := r.seq; msg := 'previous hash does not match the preceding row';
      EXIT;
    END IF;
    expect := encode(
      digest(convert_to(r.prev_hash || app.platform_audit_canonical_payload(r), 'UTF8'),
             'sha256'), 'hex');
    IF r.hash IS DISTINCT FROM expect THEN
      bad := r.seq; msg := 'row hash does not match its contents';
      EXIT;
    END IF;
    prev := r.hash;
  END LOOP;

  checked := n; ok := (bad IS NULL); first_bad_seq := bad;
  detail := coalesce(msg, 'chain intact');
  RETURN NEXT;
END $$;

SELECT app.apply_platform_rls('platform_audit_events');
SELECT app.apply_append_only('platform_audit_events');
