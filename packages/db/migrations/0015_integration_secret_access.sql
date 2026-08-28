-- =============================================================================
-- 0015  Grant the application access to its own integration secrets.
--
-- 0014 revoked EXECUTE on app.integration_secret from everyone, with a comment
-- claiming the application never reads secrets back. That was aspirational
-- rather than true: an adapter making an outbound call needs the credential,
-- and there is no way around that short of proxying every third-party request
-- through a separate service, which is not what this platform does today.
--
-- What the design actually buys is worth stating accurately:
--
--   * The plaintext never exists in a column. A database dump without the
--     master key yields ciphertext.
--   * The function refuses to decrypt another firm's secret, so a bug in an
--     adapter cannot read across tenants even with a valid install id.
--   * Decryption is a SECURITY DEFINER call, so the key derivation never runs
--     in application code and the master key is never handed to Node.
--
-- The remaining exposure - application code can obtain a credential belonging
-- to its own tenant - is inherent to making the call at all, and is recorded as
-- a limitation rather than papered over.
-- =============================================================================

GRANT EXECUTE ON FUNCTION app.integration_secret(uuid, text) TO solvenda_app;
GRANT EXECUTE ON FUNCTION app.integration_secret(uuid, text) TO solvenda_platform;
