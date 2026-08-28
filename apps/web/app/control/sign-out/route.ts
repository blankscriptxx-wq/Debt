import { NextResponse } from 'next/server';
import { signOutOperator } from '@/lib/control/session';

/**
 * POST, not GET: Next prefetches links, so a sign-out behind an anchor revoked
 * the session simply by rendering the navigation.
 *
 * The revocation happens in the database before the cookie is cleared. Deleting
 * the browser's copy alone would leave the token working for anyone who had
 * captured it.
 */
export async function POST(request: Request) {
  await signOutOperator();
  return NextResponse.redirect(new URL('/control/sign-in', request.url), { status: 303 });
}
