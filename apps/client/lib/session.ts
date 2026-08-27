import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql, withTenant, type Database, type TenantContext } from '@solvenda/db';
import { resolveSession } from '@solvenda/auth';

export const SESSION_COOKIE = 'solvenda_client_session';
export const TENANT_COOKIE = 'solvenda_client_tenant';

export interface ClientSession {
  context: TenantContext;
  userId: string;
  clientId: string;
  firstName: string;
  firmName: string;
}

/**
 * Client sessions resolve the same way staff sessions do, with one extra
 * constraint: the account must be a client account and must be linked to a
 * client record. A staff token presented here does not become a client session.
 */
export async function currentClient(): Promise<ClientSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const tenantId = jar.get(TENANT_COOKIE)?.value;
  if (!token || !tenantId) return null;

  return withTenant({ tenantId }, async (db) => {
    const resolved = await resolveSession(db, token);
    if (!resolved) return null;

    const res = await db.execute<{
      user_type: string; client_id: string; first_name: string; firm: string;
    }>(sql`
      SELECT u.user_type, c.id AS client_id, c.first_name,
             coalesce(t.trading_name, t.legal_name) AS firm
        FROM users u
        JOIN clients c ON c.portal_user_id = u.id
        CROSS JOIN app.current_tenant() t
       WHERE u.id = ${resolved.userId} AND u.user_type = 'client' AND u.status = 'active'`);

    const row = res.rows[0];
    if (!row) return null;

    return {
      context: {
        tenantId, userId: resolved.userId,
        actorType: 'client' as const, actorLabel: `client:${row.client_id}`,
      },
      userId: resolved.userId,
      clientId: row.client_id,
      firstName: row.first_name,
      firmName: row.firm,
    };
  });
}

export async function requireClient(): Promise<ClientSession> {
  const session = await currentClient();
  if (!session) redirect('/sign-in');
  return session;
}

export async function query<T>(
  session: ClientSession,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return withTenant(session.context, fn);
}
