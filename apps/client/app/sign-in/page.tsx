import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { sql, withTenant, withPlatform } from '@solvenda/db';
import { login } from '@solvenda/auth';
import { SESSION_COOKIE, TENANT_COOKIE, currentClient } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function signIn(formData: FormData) {
  'use server';

  const firmSlug = String(formData.get('firm') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!firmSlug || !email || !password) redirect('/sign-in?error=missing');

  const tenantId = await withPlatform(
    { operatorId: process.env['SOLVENDA_SIGNIN_OPERATOR_ID'] ?? ZERO_UUID,
      reason: 'resolve firm at client portal sign-in' },
    async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        SELECT id FROM tenants WHERE slug = ${firmSlug} AND status IN ('trial','active')`);
      return res.rows[0]?.id ?? null;
    },
  ).catch(() => null);

  if (!tenantId) redirect('/sign-in?error=credentials');

  const context = { tenantId, actorType: 'system' as const, actorLabel: 'client sign-in' };
  const outcome = await withTenant(context, (db) => login(db, context, { email, password }));

  if (!outcome.ok) {
    redirect(`/sign-in?error=${outcome.reason === 'locked' ? 'locked' : 'credentials'}`);
  }

  const jar = await cookies();
  const secure = process.env['NODE_ENV'] === 'production';
  jar.set(SESSION_COOKIE, outcome.session.token, {
    httpOnly: true, secure, sameSite: 'lax', path: '/', expires: outcome.session.expiresAt,
  });
  jar.set(TENANT_COOKIE, tenantId, {
    httpOnly: true, secure, sameSite: 'lax', path: '/', expires: outcome.session.expiresAt,
  });
  redirect('/');
}

const MESSAGES: Record<string, string> = {
  missing: 'Please fill in all three boxes.',
  credentials: 'We could not sign you in with those details. Check them and try again.',
  locked: 'For your security we have paused sign-in for a few minutes after several ' +
          'attempts. Please try again shortly, or call us.',
};

export default async function SignInPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  if (await currentClient()) redirect('/');
  const { error } = await searchParams;

  return (
    <div className="cp-shell">
      <div className="cp-login">
        <h1 className="cp-h1">Sign in to your account</h1>
        <p className="cp-lede">
          See where your case has got to, send us what we need, and message your adviser.
        </p>

        {error && <p className="sv-error">{MESSAGES[error] ?? MESSAGES['credentials']}</p>}

        <form action={signIn}>
          <label className="sv-field">
            <span className="sv-field__label">Who is helping you</span>
            <span className="sv-field__hint">
              The short name on the letter or email we sent you.
            </span>
            <input className="sv-input" name="firm" required autoComplete="organization"
                   autoCapitalize="none" />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Your email address</span>
            <input className="sv-input" name="email" type="email" required
                   autoComplete="username" autoCapitalize="none" inputMode="email" />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Your password</span>
            <input className="sv-input" name="password" type="password" required
                   autoComplete="current-password" />
          </label>
          <button className="cp-btn cp-btn--primary" type="submit">Sign in</button>
        </form>

        <p style={{ marginTop: 'var(--space-6)', color: 'var(--ink-muted)',
                    fontSize: 'var(--text-base)', lineHeight: 'var(--leading-relaxed)' }}>
          Cannot get in? Call the number on your letter and we will help. You will not be
          charged for calling us, and nothing bad happens because you could not sign in.
        </p>
      </div>
    </div>
  );
}
