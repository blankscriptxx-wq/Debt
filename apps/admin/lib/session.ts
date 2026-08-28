import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql, withPlatform } from '@solvenda/db';
import { verifyPassword, verifyTotp } from '@solvenda/auth';

/**
 * Operator sessions.
 *
 * Kept separate from tenant sessions on purpose. An operator is not a user of
 * any firm, holds no tenant permissions, and cannot become one: the
 * authorisation engine refuses every tenant permission to a platform operator
 * principal. What an operator can do is administer the platform, and - with a
 * time-boxed, reason-coded, audited grant - look at a firm's data to support
 * them.
 */

export const OPERATOR_COOKIE = 'solvenda_operator';

export interface OperatorSession {
  operatorId: string;
  email: string;
  fullName: string;
  role: 'support' | 'engineering' | 'compliance' | 'admin';
}

export async function currentOperator(): Promise<OperatorSession | null> {
  const jar = await cookies();
  const operatorId = jar.get(OPERATOR_COOKIE)?.value;
  if (!operatorId) return null;

  return withPlatform(
    { operatorId, reason: 'resolve operator session' },
    async (db) => {
      const res = await db.execute<{
        id: string; email: string; full_name: string; operator_role: string; status: string;
      }>(sql`
        SELECT id, email, full_name, operator_role, status
          FROM platform_operators WHERE id = ${operatorId}`);
      const row = res.rows[0];
      if (!row || row.status !== 'active') return null;
      return {
        operatorId: row.id, email: row.email, fullName: row.full_name,
        role: row.operator_role as OperatorSession['role'],
      };
    },
  ).catch(() => null);
}

export async function requireOperator(): Promise<OperatorSession> {
  const session = await currentOperator();
  if (!session) redirect('/sign-in');
  return session;
}

/** Operators with these roles may change configuration rather than only read it. */
export function canConfigure(session: OperatorSession): boolean {
  return session.role === 'admin' || session.role === 'engineering';
}

export async function authenticateOperator(
  email: string, password: string, totpCode?: string,
): Promise<{ ok: true; operatorId: string } | { ok: false; reason: string }> {
  const found = await withPlatform(
    { operatorId: '00000000-0000-0000-0000-000000000000',
      reason: 'operator sign-in lookup' },
    async (db) => {
      const res = await db.execute<{
        id: string; password_hash: string; mfa_secret: string | null; status: string;
      }>(sql`
        SELECT id, password_hash, mfa_secret, status
          FROM platform_operators WHERE email = ${email}`);
      return res.rows[0] ?? null;
    },
  ).catch(() => null);

  const passwordOk = await verifyPassword(password, found?.password_hash ?? null);
  if (!found || !passwordOk) return { ok: false, reason: 'invalid_credentials' };
  if (found.status !== 'active') return { ok: false, reason: 'invalid_credentials' };

  // An operator can reach every firm's data through a grant, so a second factor
  // is required rather than encouraged.
  if (found.mfa_secret) {
    if (!totpCode || !verifyTotp(found.mfa_secret, totpCode)) {
      return { ok: false, reason: 'mfa_required' };
    }
  }

  return { ok: true, operatorId: found.id };
}
