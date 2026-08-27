-- =============================================================================
-- 0005  Move the audit chain head out of tenant space.
--
-- The chain head is infrastructure for the ledger, not tenant data. Leaving it
-- in `public` meant it carried a platform-only RLS policy, which the
-- SECURITY DEFINER chain trigger (running as the schema owner) could not
-- satisfy - so no audit row could be written at all. Relocating it to the `app`
-- schema, with no grants to either application role, is both correct and
-- stricter: nothing outside the trigger can touch it.
-- =============================================================================

CREATE TABLE app.audit_chain_heads (
  tenant_id  uuid PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app.audit_chain_heads (tenant_id, last_seq, last_hash, updated_at)
SELECT tenant_id, last_seq, last_hash, updated_at FROM public.audit_chain_heads;

DROP TABLE public.audit_chain_heads;
DELETE FROM app.table_registry WHERE table_name = 'audit_chain_heads';

CREATE OR REPLACE FUNCTION app.audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_prev_hash text;
  v_prev_seq  bigint;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'audit_events.tenant_id cannot be null' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  SELECT last_hash, last_seq INTO v_prev_hash, v_prev_seq
    FROM app.audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  IF NOT FOUND THEN
    v_prev_hash := repeat('0', 64);
    v_prev_seq  := 0;
  END IF;

  NEW.seq       := v_prev_seq + 1;
  NEW.prev_hash := v_prev_hash;
  NEW.hash      := encode(
    digest(convert_to(v_prev_hash || app.audit_canonical_payload(NEW), 'UTF8'), 'sha256'),
    'hex');

  INSERT INTO app.audit_chain_heads(tenant_id, last_seq, last_hash)
       VALUES (NEW.tenant_id, NEW.seq, NEW.hash)
  ON CONFLICT (tenant_id)
  DO UPDATE SET last_seq = EXCLUDED.last_seq,
                last_hash = EXCLUDED.last_hash,
                updated_at = now();

  RETURN NEW;
END $$;

-- Readable for diagnostics; never writable outside the trigger.
GRANT SELECT ON app.audit_chain_heads TO solvenda_platform;
