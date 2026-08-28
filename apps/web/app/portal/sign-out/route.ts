import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { sql } from '@solvenda/db';
import { revokeSession } from '@solvenda/auth';
import { SESSION_COOKIE, TENANT_COOKIE, currentClient, query } from '@/lib/portal/session';

/** POST only: a prefetched GET would sign people out on page render. */
export async function POST(request: Request) {
  const session = await currentClient().catch(() => null);
  if (session) {
    await query(session, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        SELECT id FROM sessions WHERE user_id = ${session.userId} AND revoked_at IS NULL
         ORDER BY last_seen_at DESC LIMIT 1`);
      if (res.rows[0]) await revokeSession(db, session.context, res.rows[0].id, 'signed out');
    });
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(TENANT_COOKIE);
  return NextResponse.redirect(new URL('/portal/sign-in', request.url), { status: 303 });
}
