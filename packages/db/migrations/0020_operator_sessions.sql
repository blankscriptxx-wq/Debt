-- =============================================================================
-- 0020  Operator sessions.
--
-- Solvenda Control had its own session handling, and it was the weakest in the
-- codebase on the most privileged surface: the cookie carried the operator's
-- own UUID, unsigned, with no server-side record. Anyone holding an operator id
-- - and they appear in audit_events.actor_id, in environment variables and in
-- the seed's own output - could set that cookie and be an operator. There was
-- nothing to expire and nothing to revoke, so signing out cleared the browser's
-- copy and left the value working.
--
-- This table is the `sessions` table from 0002 with the tenant column removed:
-- a random bearer token whose hash alone is stored, an absolute expiry, a
-- sliding idle expiry, and revocation that happens in the database rather than
-- in the browser.
--
-- The failed-attempt columns close the second half of the same gap. Tenant
-- sign-in counts failures and locks; operator sign-in did neither, so the one
-- account that can reach every firm was also the one that could be guessed at
-- indefinitely without leaving a trace.
-- =============================================================================

CREATE TABLE platform_operator_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES platform_operators(id) ON DELETE CASCADE,
  -- Only the hash is stored; the bearer value never lands in the database.
  token_hash     text NOT NULL UNIQUE,
  -- Recorded for the audit trail. Operator sign-in refuses to issue a session
  -- at all without a verified second factor, so this is always true today; it
  -- exists so that a future enrolment flow has somewhere to say otherwise.
  mfa_satisfied  boolean NOT NULL DEFAULT false,
  ip             inet,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX platform_operator_sessions_operator
  ON platform_operator_sessions (operator_id, revoked_at);

SELECT app.apply_platform_rls('platform_operator_sessions');

-- Lockout state, counted and compared in SQL. Doing this comparison in
-- JavaScript is how tenant lockout silently never engaged during W1: the driver
-- returns timestamptz as a string, so `locked_until > new Date()` compared a
-- string to a Date lexicographically and was always false.
ALTER TABLE platform_operators
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_login_at timestamptz;
