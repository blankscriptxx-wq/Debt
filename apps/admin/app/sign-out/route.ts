import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { OPERATOR_COOKIE } from '@/lib/session';

export async function POST(request: Request) {
  (await cookies()).delete(OPERATOR_COOKIE);
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
