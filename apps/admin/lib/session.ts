import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql, withPlatform, type Database } from '@solvenda/db';
import {
  assertDemoLoginEnabled, hashSessionToken, mintSessionToken, verifyPassword, verifyTotp,
} from '@solvenda/auth';

/**
 * Operator sessions.
 *
 * Kept separate from tenant sessions on purpose. An operator is not a user of
 * any firm, holds no tenant permissions, and cannot become one: the
 * authorisation engine refuses every tenant permission to a platform operator
 * principal. What an operator can do is administer the platform, and - with a
 * time-boxed, reason-coded, audited grant - look at a firm's data to support
 * them.
 *
 * Separate does not mean weaker, and for a while it was. This module stored the
 * operator's own UUID in the cookie and looked it up, which made the cookie a
 * bearer token anyone holding an operator id could forge - and operator ids are
 * not secret, appearing in audit rows, environment variables and the seed's own
 * output. Nothing expired it and signing out did not revoke it. It now follows
 * the shape `packages/auth` already uses for tenant users: a random token, only
 * its hash stored, two clocks, and revocation in the database.
 */

export const OPERATOR_COOKIE = 'solvenda_operator';

/**
 * Shorter windows than the tenant console. An operator session reaches every
 * firm's configuration, so an unattended one is worth more than an adviser's.
 */
export const OPERATOR_IDLE_MINUTES = 20;
export const OPERATOR_ABSOLUTE_HOURS = 8;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

/** Platform context for work done before any operator is known. */
const ANONYMOUS = '00000000-0000-0000-0000-000000000000';

export interface OperatorSession {
  operatorId: string;
  sessionId: string;
  email: string;
  fullName: string;
  role: 'support' | 'engineering' | 'compliance' | 'admin';
}

export type OperatorAuthOutcome =
  | { ok: true; token: string; operatorId: string }
  | {
      ok: false;
      reason: 'invalid_credentials' | 'locked' | 'mfa_required' | 'mfa_not_enrolled';
    };

interface RequestMeta { ip: string | null; userAgent: string | null }

async function requestMeta(): Promise<RequestMeta> {
  const head = await headers();
  return {
    ip: head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: head.get('user-agent'),
  };
}

/**
 * Resolves the bearer token and slides the idle window.
 *
 * Both expiries, the revocation check and the operator's status are evaluated
 * in SQL. That is not a style preference: comparing a timestamptz in JavaScript
 * is how tenant lockout silently never engaged during W1, because the driver
 * returns it as a string and the comparison was lexicographic.
 */
export async function currentOperator(): Promise<OperatorSession | null> {
  const jar = await cookies();
  const token = jar.get(OPERATOR_COOKIE)?.value;
  if (!token) return null;

  return withPlatform(
    { operatorId: ANONYMOUS, reason: 'resolve operator session' },
    async (db) => {
      const res = await db.execute<{
        id: string; operator_id: string; email: string;
        full_name: string; operator_role: string;
      }>(sql`
        UPDATE platform_operator_sessions s
           SET last_seen_at = now(),
               idle_expires_at =
                 now() + (${String(OPERATOR_IDLE_MINUTES)} || ' minutes')::interval
          FROM platform_operators o
         WHERE s.token_hash = ${hashSessionToken(token)}
           AND s.operator_id = o.id
           AND s.revoked_at IS NULL
           AND s.idle_expires_at > now()
           AND s.absolute_expires_at > now()
           AND o.status = 'active'
        RETURNING s.id, s.operator_id, o.email, o.full_name, o.operator_role`);

      const row = res.rows[0];
      if (!row) return null;
      return {
        operatorId: row.operator_id, sessionId: row.id, email: row.email,
        fullName: row.full_name, role: row.operator_role as OperatorSession['role'],
      };
    },
  ).catch(() => null);
}

export async function requireOperator(): Promise<OperatorSession> {
  const session = await currentOperator();
  if (!session) redirect('/sign-in');
  return session;
}

/** Operators with these roles may change configuration rather than only read it. */
export function canConfigure(session: OperatorSession): boolean {
  return session.role === 'admin' || session.role === 'engineering';
}

/**
 * Authenticates an operator and opens a session.
 *
 * Failure is uniform where it can be: an unknown email, a wrong password and a
 * suspended account return the same shape, so the page cannot be used to
 * enumerate operators. `mfa_not_enrolled` is the exception, and only because it
 * is reached after the password has already been verified.
 */
export async function authenticateOperator(
  email: string, password: string, totpCode?: string,
): Promise<OperatorAuthOutcome> {
  const meta = await requestMeta();

  return withPlatform(
    { operatorId: ANONYMOUS, reason: 'operator sign-in' },
    async (db): Promise<OperatorAuthOutcome> => {
      const res = await db.execute<{
        id: string; password_hash: string; mfa_secret: string | null;
        status: string; is_locked: boolean;
      }>(sql`
        SELECT id, password_hash, mfa_secret, status,
               (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
          FROM platform_operators WHERE email = ${email}`);
      const found = res.rows[0] ?? null;

      if (found?.is_locked) {
        await note(db, 'platform.login.locked', found.id,
          'Sign-in attempted while the account was locked', meta);
        return { ok: false, reason: 'locked' };
      }

      // Verified even when no operator matched, so an unknown email costs the
      // same work as a known one and cannot be told apart by timing.
      const passwordOk = await verifyPassword(password, found?.password_hash ?? null);
      if (!found || !passwordOk || found.status !== 'active') {
        if (found) {
          await registerFailure(db, found.id,
            passwordOk ? `Account status is ${found.status}` : 'Password rejected', meta);
        }
        return { ok: false, reason: 'invalid_credentials' };
      }

      // An operator can reach every firm through a grant, so a second factor is
      // required rather than encouraged - and "required" has to mean an
      // operator without one cannot sign in at all. Making the check
      // conditional on a secret existing makes it optional, and the account
      // with no secret is exactly the one worth protecting.
      if (!found.mfa_secret) {
        await note(db, 'platform.login.failed', found.id,
          'Refused: no second factor is enrolled on this operator', meta);
        return { ok: false, reason: 'mfa_not_enrolled' };
      }
      if (!totpCode || !verifyTotp(found.mfa_secret, totpCode)) {
        await registerFailure(db, found.id, 'Second factor rejected', meta);
        return { ok: false, reason: 'mfa_required' };
      }

      const token = mintSessionToken();
      const now = Date.now();
      await db.execute(sql`
        INSERT INTO platform_operator_sessions
          (operator_id, token_hash, mfa_satisfied, ip, user_agent,
           absolute_expires_at, idle_expires_at)
        VALUES (${found.id}, ${hashSessionToken(token)}, true, ${meta.ip}::inet,
                ${meta.userAgent},
                ${new Date(now + OPERATOR_ABSOLUTE_HOURS * 3_600_000).toISOString()},
                ${new Date(now + OPERATOR_IDLE_MINUTES * 60_000).toISOString()})`);

      await db.execute(sql`
        UPDATE platform_operators
           SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
         WHERE id = ${found.id}`);

      await note(db, 'platform.login.succeeded', found.id, 'Operator signed in', meta);
      return { ok: true, token, operatorId: found.id };
    },
  );
}

/** Revokes the session in the database, then clears the browser's copy. */
export async function signOutOperator(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(OPERATOR_COOKIE)?.value;
  jar.delete(OPERATOR_COOKIE);
  if (!token) return;

  await withPlatform(
    { operatorId: ANONYMOUS, reason: 'operator sign-out' },
    async (db) => {
      const res = await db.execute<{ operator_id: string }>(sql`
        UPDATE platform_operator_sessions
           SET revoked_at = now(), revoked_reason = 'signed out'
         WHERE token_hash = ${hashSessionToken(token)} AND revoked_at IS NULL
        RETURNING operator_id`);
      const operatorId = res.rows[0]?.operator_id;
      if (operatorId) {
        await note(db, 'platform.session.revoked', operatorId, 'Operator signed out',
          { ip: null, userAgent: null });
      }
    },
  ).catch(() => undefined);
}

/**
 * Counts the failure and locks, in the database.
 *
 * The increment happens in SQL rather than read-then-write, so two concurrent
 * attempts cannot both read the same count and write the same value back - the
 * bug the tenant login path had and had to be fixed for in W1.
 */
async function registerFailure(
  db: Database, operatorId: string, reason: string, meta: RequestMeta,
): Promise<void> {
  const res = await db.execute<{ locked: boolean }>(sql`
    UPDATE platform_operators
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= ${MAX_FAILED_LOGINS}
             THEN now() + (${String(LOCKOUT_MINUTES)} || ' minutes')::interval
             ELSE locked_until END
     WHERE id = ${operatorId}
    RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`);

  await note(db, 'platform.login.failed', operatorId, reason, meta);
  if (res.rows[0]?.locked) {
    await note(db, 'platform.login.locked', operatorId,
      `Locked for ${LOCKOUT_MINUTES} minutes after ${MAX_FAILED_LOGINS} failed attempts`,
      meta);
  }
}

/**
 * Writes to the platform ledger.
 *
 * Not `audit_events`: that table is tenant-scoped and its hash chain is per
 * firm, and an operator signing in belongs to no firm. `platform_audit_events`
 * carries the same guarantees - append-only, hash-chained, verifiable - over
 * one chain instead of one per tenant.
 */
async function note(
  db: Database,
  action: 'platform.login.succeeded' | 'platform.login.failed'
        | 'platform.login.locked' | 'platform.session.revoked',
  operatorId: string,
  reason: string,
  meta: RequestMeta,
): Promise<void> {
  const severity = action === 'platform.login.succeeded' ? 'notable' : 'security';
  await db.execute(sql`
    INSERT INTO platform_audit_events
      (actor_operator_id, actor_label, action, resource_type, resource_id,
       reason, source, ip, user_agent, severity)
    VALUES (${operatorId}, ${`operator:${operatorId}`}, ${action}, 'platform_operator',
            ${operatorId}, ${reason}, 'admin-console', ${meta.ip}::inet,
            ${meta.userAgent}, ${severity})`);
}

/**
 * Opens an operator session without a password or a second factor.
 *
 * For the development sign-in button only. Everything after identification is
 * the real path: a random token, only its hash stored, both clocks, revocable,
 * and audited - with the audit row saying plainly that nothing was verified.
 */
export async function demoSignInOperator(email: string): Promise<OperatorAuthOutcome> {
  assertDemoLoginEnabled();
  const meta = await requestMeta();

  return withPlatform(
    { operatorId: ANONYMOUS, reason: 'operator demo sign-in' },
    async (db): Promise<OperatorAuthOutcome> => {
      const res = await db.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM platform_operators WHERE email = ${email}`);
      const found = res.rows[0];
      if (!found || found.status !== 'active') {
        return { ok: false, reason: 'invalid_credentials' };
      }

      const token = mintSessionToken();
      const now = Date.now();
      await db.execute(sql`
        INSERT INTO platform_operator_sessions
          (operator_id, token_hash, mfa_satisfied, ip, user_agent,
           absolute_expires_at, idle_expires_at)
        VALUES (${found.id}, ${hashSessionToken(token)}, false, ${meta.ip}::inet,
                ${meta.userAgent},
                ${new Date(now + OPERATOR_ABSOLUTE_HOURS * 3_600_000).toISOString()},
                ${new Date(now + OPERATOR_IDLE_MINUTES * 60_000).toISOString()})`);

      await note(db, 'platform.login.succeeded', found.id,
        'Demo sign-in: no password or second factor was checked', meta);
      return { ok: true, token, operatorId: found.id };
    },
  );
}
