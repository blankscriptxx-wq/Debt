/**
 * Development sign-in shortcuts.
 *
 * These let a portal offer "sign in as an adviser" as a button, with no
 * password and no second factor. That is a deliberate hole, so it is one hole
 * in one place with one switch, rather than a special case scattered through
 * three sign-in pages.
 *
 * Two rules make it safe to have in the tree at all:
 *
 *   1. It is off unless `SOLVENDA_DEMO_LOGIN=1` is set. Absent, unset or any
 *      other value means off. There is no "default on in development", because
 *      the thing that decides whether an environment is production is not
 *      something this module can know.
 *
 *   2. It refuses outright when `NODE_ENV === 'production'` unless
 *      `SOLVENDA_DEMO_LOGIN_ALLOW_PRODUCTION=1` is *also* set. Two switches,
 *      because a deployed instance with one-click operator access is open to
 *      anyone who has the URL.
 *
 * Nothing here bypasses the session mechanism. A demo sign-in mints a real
 * session through the same code path as a password sign-in, so it expires, it
 * can be revoked, and it is audited. What it skips is proving who you are.
 */

export function demoLoginEnabled(): boolean {
  if (process.env['SOLVENDA_DEMO_LOGIN'] !== '1') return false;
  if (process.env['NODE_ENV'] === 'production'
      && process.env['SOLVENDA_DEMO_LOGIN_ALLOW_PRODUCTION'] !== '1') {
    return false;
  }
  return true;
}

/** Throws rather than returning false, for use at the top of a server action. */
export function assertDemoLoginEnabled(): void {
  if (!demoLoginEnabled()) {
    throw new Error(
      'Demo sign-in is disabled. Set SOLVENDA_DEMO_LOGIN=1 (and, in production, '
      + 'SOLVENDA_DEMO_LOGIN_ALLOW_PRODUCTION=1) to enable it.',
    );
  }
}

export interface DemoAccount {
  /** Stable key used by the button that selects this account. */
  key: string;
  label: string;
  /** What this account is for, shown under the button. */
  detail: string;
  email: string;
}

/** Staff accounts in the seeded firm, one per role. */
export const DEMO_STAFF_ACCOUNTS: readonly DemoAccount[] = [
  { key: 'adviser', label: 'Debt Adviser', email: 'adviser@northgate.test',
    detail: 'Ruth Ellery. Owns the seeded cases; holds every role, so she sees everything.' },
  { key: 'team-leader', label: 'Team Leader', email: 'leader@northgate.test',
    detail: 'Dominic Ashworth. Approvals and workload, without compliance tooling.' },
  { key: 'compliance', label: 'Compliance Officer', email: 'compliance@northgate.test',
    detail: 'Yewande Balogun. QA, file review and outcome monitoring.' },
  { key: 'administrator', label: 'Firm Administrator', email: 'administrator@northgate.test',
    detail: 'Priya Chandran. Configuration and users; no advice permissions.' },
  { key: 'case-admin', label: 'Case Administrator', email: 'caseadmin@northgate.test',
    detail: 'Tom Reilly. Case handling support, deliberately without advice rights.' },
  { key: 'ip', label: 'Insolvency Practitioner', email: 'ip@northgate.test',
    detail: 'Alastair Menzies. Insolvency competencies for IVA and trust deed work.' },
] as const;

/** Client portal accounts, chosen because their cases differ in useful ways. */
export const DEMO_CLIENT_ACCOUNTS: readonly DemoAccount[] = [
  { key: 'joanne', label: 'Joanne Whitfield', email: 'joanne.whitfield@example.test',
    detail: 'A live DMP with an overdue review and no reply to the last three contacts.' },
  { key: 'elaine', label: 'Elaine Crozier', email: 'elaine.crozier@example.test',
    detail: 'A Scottish DAS case with a recorded vulnerability and a deficit budget.' },
] as const;

export const DEMO_OPERATOR_ACCOUNT: DemoAccount = {
  key: 'operator', label: 'Platform Operator', email: 'operator@solvenda.test',
  detail: 'Solvenda Control. Holds no permissions inside any firm.',
};

export const DEMO_FIRM_SLUG = 'northgate';
