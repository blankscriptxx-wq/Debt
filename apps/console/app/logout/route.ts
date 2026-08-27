import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { sql } from '@solvenda/db';
import { revokeSession } from '@solvenda/auth';
import { SESSION_COOKIE, TENANT_COOKIE, currentSession, query } from '@/lib/session';

/**
 * Signing out is a POST, never a GET.
 *
 * This was originally a GET behind a sidebar link, which Next prefetches - so
 * merely rendering any page containing the navigation revoked the session and
 * bounced the user back to sign-in. The general rule is the fix: a GET must not
 * change anything.
 */
export async function POST(request: Request) {
  const session = await currentSession().catch(() => null);
  if (session) {
    // Revoked server-side, not merely forgotten by the browser.
    await query(session, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        SELECT id FROM sessions WHERE user_id = ${session.user.id}
          AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`);
      if (res.rows[0]) {
        await revokeSession(db, session.context, res.rows[0].id, 'signed out');
      }
    });
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(TENANT_COOKIE);
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
