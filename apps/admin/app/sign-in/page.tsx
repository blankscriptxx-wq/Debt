import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { DEMO_OPERATOR_ACCOUNT, demoLoginEnabled } from '@solvenda/auth';
import { DemoSignIn } from '@solvenda/ui';
import {
  authenticateOperator, currentOperator, demoSignInOperator,
  OPERATOR_ABSOLUTE_HOURS, OPERATOR_COOKIE,
} from '@/lib/session';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const totp = String(formData.get('totp') ?? '').trim() || undefined;

  const outcome = await authenticateOperator(email, password, totp);
  if (!outcome.ok) redirect(`/sign-in?error=${outcome.reason}`);

  // The cookie carries an opaque bearer token, not the operator's id. Its
  // maxAge is only a hint to the browser; the session's real lifetime and its
  // revocation live in the database.
  const jar = await cookies();
  jar.set(OPERATOR_COOKIE, outcome.token, {
    httpOnly: true, secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict', path: '/', maxAge: OPERATOR_ABSOLUTE_HOURS * 3600,
  });
  redirect('/');
}

/**
 * One-click operator sign-in for development.
 *
 * The riskiest of the three, because an operator sees every firm's
 * configuration. `demoSignInOperator` refuses unless the demo switch is on, and
 * that switch refuses in production unless a second one is also set.
 */
async function signInAsDemo(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '');
  if (email !== DEMO_OPERATOR_ACCOUNT.email) redirect('/sign-in?error=invalid_credentials');

  const outcome = await demoSignInOperator(email);
  if (!outcome.ok) redirect(`/sign-in?error=${outcome.reason}`);

  const jar = await cookies();
  jar.set(OPERATOR_COOKIE, outcome.token, {
    httpOnly: true, secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'strict', path: '/', maxAge: OPERATOR_ABSOLUTE_HOURS * 3600,
  });
  redirect('/');
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Those details were not recognised.',
  locked: 'Too many failed attempts. Try again in a few minutes.',
  mfa_required: 'An authentication code is required for operator access.',
  mfa_not_enrolled:
    'This operator account has no second factor enrolled, so it cannot be used. '
    + 'Enrol one before signing in.',
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

        {demoLoginEnabled() && (
          <DemoSignIn accounts={[DEMO_OPERATOR_ACCOUNT]} action={signInAsDemo}
                      note="One click, no password and no second factor. This account administers every firm on the platform." />
        )}
      </div>
    </div>
  );
}
