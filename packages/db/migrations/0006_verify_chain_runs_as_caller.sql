-- =============================================================================
-- 0006  Chain verification runs as its caller, not as the schema owner.
--
-- SECURITY DEFINER gave the function the owner's identity, which under FORCE
-- ROW LEVEL SECURITY sees nothing at all - so verification silently reported
-- zero rows checked, the worst possible failure mode for an integrity check.
--
-- Running as the caller is also the behaviour we want: a platform operator
-- verifies every tenant, and a firm verifies its own ledger and only its own.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.verify_audit_chain(p_tenant_id uuid DEFAULT NULL)
  RETURNS TABLE (tenant_id uuid, checked bigint, ok boolean,
                 first_bad_seq bigint, detail text)
  LANGUAGE plpgsql STABLE SET search_path = public, app AS $$
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
        bad := r.seq; msg := 'prev_hash does not match preceding row'; EXIT;
      END IF;
      IF r.seq <> n THEN
        bad := r.seq; msg := format('sequence gap: expected %s', n); EXIT;
      END IF;
      expect := encode(digest(convert_to(r.prev_hash || app.audit_canonical_payload(r), 'UTF8'), 'sha256'), 'hex');
      IF r.hash IS DISTINCT FROM expect THEN
        bad := r.seq; msg := 'row hash does not match its contents'; EXIT;
      END IF;
    END LOOP;
    tenant_id := t; checked := n; ok := (bad IS NULL);
    first_bad_seq := bad; detail := msg;
    RETURN NEXT;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION app.verify_audit_chain(uuid) TO solvenda_app, solvenda_platform;
