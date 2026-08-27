import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql, withTenant, type Database, type TenantContext } from '@solvenda/db';
import { resolveSession, loadUserPrincipal, type Principal } from '@solvenda/auth';

/**
 * Server-side session resolution.
 *
 * Note the shape: resolving the session needs a tenant-bound connection, but
 * the tenant is what the session tells us. The cookie therefore carries the
 * tenant id alongside the opaque token, and the token is still validated
 * against that tenant - a cookie naming the wrong tenant simply resolves to
 * nothing, because the session row is not visible from there.
 */

export const SESSION_COOKIE = 'solvenda_session';
export const TENANT_COOKIE = 'solvenda_tenant';

export interface ConsoleSession {
  principal: Principal & { kind: 'user' };
  context: TenantContext;
  tenant: { id: string; name: string; slug: string };
  user: { id: string; fullName: string; email: string };
  mfaRequired: boolean;
}

export async function currentSession(): Promise<ConsoleSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const tenantId = jar.get(TENANT_COOKIE)?.value;
  if (!token || !tenantId) return null;

  try {
    return await withTenant({ tenantId }, async (db) => {
      const resolved = await resolveSession(db, token);
      if (!resolved) return null;

      const principal = await loadUserPrincipal(db, resolved.userId, resolved.mfaSatisfied);
      if (!principal || principal.kind !== 'user') return null;

      const details = await db.execute<{
        full_name: string; email: string; mfa_secret: string | null; mfa_required: boolean;
      }>(sql`SELECT full_name, email, mfa_secret, mfa_required FROM users WHERE id = ${resolved.userId}`);
      const tenant = await db.execute<{ legal_name: string; trading_name: string | null; slug: string }>(
        sql`SELECT legal_name, trading_name, slug FROM app.current_tenant()`);

      const user = details.rows[0];
      const firm = tenant.rows[0];
      if (!user || !firm) return null;

      return {
        principal,
        context: {
          tenantId,
          userId: resolved.userId,
          actorType: 'user' as const,
          actorLabel: user.full_name,
        },
        tenant: { id: tenantId, name: firm.trading_name ?? firm.legal_name, slug: firm.slug },
        user: { id: resolved.userId, fullName: user.full_name, email: user.email },
        mfaRequired: Boolean(user.mfa_secret || user.mfa_required) && !resolved.mfaSatisfied,
      };
    });
  } catch (error) {
    // Swallowing every error here would report a database problem as "not
    // signed in", which sends someone round a login loop while the real fault
    // goes unlogged. Only an unresolvable session is null; anything else throws.
    console.error('[session] failed to resolve session', error);
    throw error;
  }
}

/** Use in any page that requires a signed-in adviser. */
export async function requireSession(): Promise<ConsoleSession> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

/** Runs a query inside the caller's tenant. */
export async function query<T>(
  session: ConsoleSession,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return withTenant(session.context, fn);
}
