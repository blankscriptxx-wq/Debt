import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { sql, withTenant, withPlatform } from '@solvenda/db';
import { login } from '@solvenda/auth';
import { SESSION_COOKIE, TENANT_COOKIE, currentSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData) {
  'use server';

  const firmSlug = String(formData.get('firm') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totp') ?? '').trim() || undefined;

  if (!firmSlug || !email || !password) {
    redirect('/login?error=missing');
  }

  // Resolving a firm slug to a tenant is a platform lookup: the application
  // role cannot see the tenant directory, and the sign-in page has no tenant
  // context yet. The lookup returns an identifier and nothing else.
  const tenantId = await withPlatform(
    { operatorId: process.env['SOLVENDA_SIGNIN_OPERATOR_ID'] ?? ZERO_UUID,
      reason: 'resolve firm slug at sign-in' },
    async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        SELECT id FROM tenants WHERE slug = ${firmSlug} AND status IN ('trial','active')`);
      return res.rows[0]?.id ?? null;
    },
  ).catch(() => null);

  if (!tenantId) redirect('/login?error=credentials');

  const outcome = await withTenant({ tenantId, actorType: 'system', actorLabel: 'sign-in' },
    (db) => login(db, { tenantId, actorType: 'system', actorLabel: 'sign-in' }, {
      email, password, totpCode,
    }));

  if (!outcome.ok) {
    redirect(`/login?error=${outcome.reason === 'locked' ? 'locked' : 'credentials'}`);
  }

  const jar = await cookies();
  const secure = process.env['NODE_ENV'] === 'production';
  jar.set(SESSION_COOKIE, outcome.session.token, {
    httpOnly: true, secure, sameSite: 'lax', path: '/',
    expires: outcome.session.expiresAt,
  });
  jar.set(TENANT_COOKIE, tenantId, {
    httpOnly: true, secure, sameSite: 'lax', path: '/',
    expires: outcome.session.expiresAt,
  });

  redirect(outcome.session.mfaRequired ? '/login/verify' : '/');
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const MESSAGES: Record<string, string> = {
  missing: 'Please complete every field.',
  credentials: 'Those details were not recognised.',
  locked: 'This account is temporarily locked after repeated failed attempts. Try again shortly.',
};

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/');
  const { error } = await searchParams;

  return (
    <div className="sv-login">
      <div className="sv-login__card">
        <h1 className="sv-login__title">Sign in to Solvenda</h1>
        <p className="sv-login__lede">
          Case management and intelligence for regulated financial-difficulty services.
        </p>

        {error && <p className="sv-error">{MESSAGES[error] ?? MESSAGES['credentials']}</p>}

        <form action={signIn}>
          <label className="sv-field">
            <span className="sv-field__label">Firm</span>
            <input className="sv-input" name="firm" autoComplete="organization"
                   placeholder="your-firm" required />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Email address</span>
            <input className="sv-input" name="email" type="email"
                   autoComplete="username" required />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Password</span>
            <input className="sv-input" name="password" type="password"
                   autoComplete="current-password" required />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Authentication code</span>
            <span className="sv-field__hint">
              From your authenticator app. Leave blank if you have not set one up yet.
            </span>
            <input className="sv-input" name="totp" inputMode="numeric"
                   autoComplete="one-time-code" pattern="\d{6}" />
          </label>

          <button className="sv-btn sv-btn--primary sv-btn--md" type="submit"
                  style={{ width: '100%', justifyContent: 'center' }}>
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
