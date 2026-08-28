import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { authenticateOperator, currentOperator, OPERATOR_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const totp = String(formData.get('totp') ?? '').trim() || undefined;

  const outcome = await authenticateOperator(email, password, totp);
  if (!outcome.ok) redirect(`/sign-in?error=${outcome.reason}`);

  const jar = await cookies();
  jar.set(OPERATOR_COOKIE, outcome.operatorId, {
    httpOnly: true, secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict', path: '/', maxAge: 60 * 60 * 8,
  });
  redirect('/');
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Those details were not recognised.',
  mfa_required: 'An authentication code is required for operator access.',
};

export default async function SignInPage({
  searchParams,
}: { searchParams: Promise<{ error?: string }> }) {
  if (await currentOperator()) redirect('/');
  const { error } = await searchParams;

  return (
    <div className="sv-login">
      <div className="sv-login__card">
        <h1 className="sv-login__title">Solvenda Control</h1>
        <p className="sv-login__lede">
          Platform administration. Operator accounts hold no permissions inside any firm;
          looking at a firm&rsquo;s data requires a time-boxed, reason-coded grant that is
          recorded.
        </p>
        {error && <p className="sv-error">{MESSAGES[error] ?? MESSAGES['invalid_credentials']}</p>}
        <form action={signIn}>
          <label className="sv-field">
            <span className="sv-field__label">Email address</span>
            <input className="sv-input" name="email" type="email" required
                   autoComplete="username" />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Password</span>
            <input className="sv-input" name="password" type="password" required
                   autoComplete="current-password" />
          </label>
          <label className="sv-field">
            <span className="sv-field__label">Authentication code</span>
            <input className="sv-input" name="totp" inputMode="numeric" pattern="\d{6}"
                   autoComplete="one-time-code" />
          </label>
          <button className="sv-btn sv-btn--primary sv-btn--md" type="submit"
                  style={{ width: '100%', justifyContent: 'center' }}>Sign in</button>
        </form>
      </div>
    </div>
  );
}
