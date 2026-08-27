import { createHash, randomBytes } from 'node:crypto';
import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { verifyPassword } from './password.js';
import { verifyTotp } from './totp.js';

/**
 * Session lifetimes. Two clocks: an idle timeout that keeps an unattended
 * console from staying open, and an absolute cap that forces reauthentication
 * regardless of activity.
 */
export const SESSION_IDLE_MINUTES = 30;
export const SESSION_ABSOLUTE_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface SessionToken {
  /** Returned to the caller once and never stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
  mfaRequired: boolean;
}

export type LoginOutcome =
  | { ok: true; session: SessionToken; userId: string }
  | { ok: false; reason: 'invalid_credentials' | 'locked' | 'not_active' | 'mfa_invalid' };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface UserRow {
  [key: string]: unknown;
  id: string;
  status: string;
  password_hash: string | null;
  mfa_secret: string | null;
  mfa_required: boolean;
  failed_login_count: number;
  is_locked: boolean;
}

/**
 * Authenticates a person and opens a session.
 *
 * Failure is deliberately uniform: an unknown email, a wrong password and a
 * disabled account all take a comparable amount of work and return the same
 * shape, so the endpoint cannot be used to enumerate a firm's staff.
 */
export async function login(
  db: Database,
  ctx: TenantContext,
  input: {
    email: string;
    password: string;
    totpCode?: string;
    ip?: string | null;
    userAgent?: string | null;
    deviceLabel?: string | null;
  },
): Promise<LoginOutcome> {
  // The lockout comparison is evaluated by Postgres rather than in JavaScript:
  // the driver returns timestamptz as a string, so a `> new Date()` check here
  // would compare a string to a Date lexicographically and quietly never fire.
  // Keeping it in SQL also removes any dependence on app/database clock skew.
  const found = await db.execute<UserRow>(sql`
    SELECT id, status, password_hash, mfa_secret, mfa_required, failed_login_count,
           (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
      FROM users WHERE email = ${input.email} AND user_type IN ('staff','client','creditor','introducer')`);
  const user = found.rows[0] ?? null;

  if (user?.is_locked) {
    await audit(db, ctx, 'auth.login.locked', user.id, input, 'Login attempted while locked out');
    return { ok: false, reason: 'locked' };
  }

  const passwordOk = await verifyPassword(input.password, user?.password_hash ?? null);

  if (!user || !passwordOk) {
    if (user) await registerFailure(db, ctx, user, input);
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (user.status !== 'active') {
    await audit(db, ctx, 'auth.login.failed', user.id, input, `Account status is ${user.status}`);
    return { ok: false, reason: 'not_active' };
  }

  // Second factor, when the account is enrolled or the firm requires it.
  const mfaEnrolled = Boolean(user.mfa_secret);
  let mfaSatisfied = false;
  if (mfaEnrolled) {
    if (!input.totpCode) {
      // Password verified but the factor is outstanding; the caller collects it
      // and calls completeMfa() against the returned session.
      const session = await createSession(db, user.id, false, input);
      return { ok: true, session: { ...session, mfaRequired: true }, userId: user.id };
    }
    if (!verifyTotp(user.mfa_secret!, input.totpCode)) {
      await registerFailure(db, ctx, user, input, 'auth.mfa.failed');
      return { ok: false, reason: 'mfa_invalid' };
    }
    mfaSatisfied = true;
  } else if (user.mfa_required) {
    // Enrolment is enforced at the next step rather than blocking sign-in, so a
    // new starter can complete setup.
    const session = await createSession(db, user.id, false, input);
    return { ok: true, session: { ...session, mfaRequired: true }, userId: user.id };
  }

  await db.execute(sql`
    UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
     WHERE id = ${user.id}`);

  const session = await createSession(db, user.id, mfaSatisfied, input);
  await audit(db, { ...ctx, userId: user.id }, 'auth.login.succeeded', user.id, input,
    mfaSatisfied ? 'Password and second factor verified' : 'Password verified');

  return { ok: true, session: { ...session, mfaRequired: false }, userId: user.id };
}

async function createSession(
  db: Database,
  userId: string,
  mfaSatisfied: boolean,
  input: { ip?: string | null; userAgent?: string | null; deviceLabel?: string | null },
): Promise<Omit<SessionToken, 'mfaRequired'>> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const idle = new Date(now + SESSION_IDLE_MINUTES * 60_000);
  const absolute = new Date(now + SESSION_ABSOLUTE_HOURS * 3_600_000);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO sessions (user_id, token_hash, mfa_satisfied, ip, user_agent, device_label,
                          absolute_expires_at, idle_expires_at)
    VALUES (${userId}, ${hashToken(token)}, ${mfaSatisfied}, ${input.ip ?? null}::inet,
            ${input.userAgent ?? null}, ${input.deviceLabel ?? null},
            ${absolute.toISOString()}, ${idle.toISOString()})
    RETURNING id`);

  return { token, sessionId: res.rows[0]!.id, expiresAt: idle };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  tenantId: string;
  mfaSatisfied: boolean;
}

/**
 * Validates a bearer token and slides the idle window. Returns null for a
 * token that is unknown, revoked or past either expiry, so callers treat all
 * failure modes identically.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<ResolvedSession | null> {
  const res = await db.execute<{
    id: string; user_id: string; tenant_id: string; mfa_satisfied: boolean;
  }>(sql`
    UPDATE sessions SET last_seen_at = now(),
           idle_expires_at = now() + (${String(SESSION_IDLE_MINUTES)} || ' minutes')::interval
     WHERE token_hash = ${hashToken(token)}
       AND revoked_at IS NULL
       AND idle_expires_at > now()
       AND absolute_expires_at > now()
    RETURNING id, user_id, tenant_id, mfa_satisfied`);

  const row = res.rows[0];
  if (!row) return null;
  return {
    sessionId: row.id, userId: row.user_id,
    tenantId: row.tenant_id, mfaSatisfied: row.mfa_satisfied,
  };
}

/** Completes the second factor against an already-authenticated session. */
export async function completeMfa(
  db: Database,
  ctx: TenantContext,
  input: { token: string; totpCode: string },
): Promise<boolean> {
  const session = await resolveSession(db, input.token);
  if (!session) return false;

  const res = await db.execute<{ mfa_secret: string | null }>(sql`
    SELECT mfa_secret FROM users WHERE id = ${session.userId}`);
  const secret = res.rows[0]?.mfa_secret;
  if (!secret || !verifyTotp(secret, input.totpCode)) {
    await audit(db, { ...ctx, userId: session.userId }, 'auth.mfa.failed',
      session.userId, {}, 'Second factor rejected');
    return false;
  }

  await db.execute(sql`UPDATE sessions SET mfa_satisfied = true WHERE id = ${session.sessionId}`);
  return true;
}

export async function revokeSession(
  db: Database,
  ctx: TenantContext,
  sessionId: string,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
     WHERE id = ${sessionId} AND revoked_at IS NULL`);
  await audit(db, ctx, 'auth.session.revoked', sessionId, {}, reason);
}

/** Revokes every other session for a user, used after a password change. */
export async function revokeOtherSessions(
  db: Database,
  ctx: TenantContext,
  userId: string,
  keepSessionId: string | null,
  reason: string,
): Promise<number> {
  const res = await db.execute(sql`
    UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
     WHERE user_id = ${userId} AND revoked_at IS NULL
       AND (${keepSessionId}::uuid IS NULL OR id <> ${keepSessionId}::uuid)
    RETURNING id`);
  return res.rows.length;
}

async function registerFailure(
  db: Database,
  ctx: TenantContext,
  user: UserRow,
  input: { ip?: string | null; userAgent?: string | null },
  action: 'auth.login.failed' | 'auth.mfa.failed' = 'auth.login.failed',
): Promise<void> {
  // Increment in the database rather than from the value we read, so
  // concurrent attempts cannot each write the same count and defeat the lock.
  const res = await db.execute<{ failed_login_count: number }>(sql`
    UPDATE users SET failed_login_count = failed_login_count + 1
     WHERE id = ${user.id}
    RETURNING failed_login_count`);
  const attempts = Number(res.rows[0]?.failed_login_count ?? 0);

  const locked = attempts >= MAX_FAILED_LOGINS;
  if (locked) {
    await db.execute(sql`
      UPDATE users
         SET locked_until = now() + (${String(LOCKOUT_MINUTES)} || ' minutes')::interval
       WHERE id = ${user.id}`);
  }

  await audit(db, ctx, locked ? 'auth.login.locked' : action, user.id, input,
    locked ? `Locked after ${attempts} failed attempts` : `Failed attempt ${attempts}`);
}

async function audit(
  db: Database,
  ctx: TenantContext,
  action: 'auth.login.succeeded' | 'auth.login.failed' | 'auth.login.locked'
        | 'auth.mfa.failed' | 'auth.session.revoked',
  resourceId: string,
  input: { ip?: string | null; userAgent?: string | null },
  reason: string,
): Promise<void> {
  await recordAudit(db, ctx, {
    action, resourceType: 'user', resourceId, reason, source: 'auth',
    ip: input.ip ?? null, userAgent: input.userAgent ?? null,
  });
}
