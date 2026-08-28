import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { hashSessionToken, mintSessionToken } from '@solvenda/auth';

/**
 * Operator authentication.
 *
 * These exist because the operator console originally put the operator's own
 * UUID in the session cookie and looked it up. Anyone holding an id - and they
 * appear in audit rows and environment variables - was authenticated. The
 * assertions below are the properties that were missing, expressed as
 * behaviour: a random id is not a session, a revoked session is over, an
 * expired one is over, and each is enforced by the query rather than by the
 * caller remembering to check.
 *
 * The resolution query is duplicated here rather than imported: the app's
 * version reads a cookie through next/headers, which has no meaning in a test.
 * It is kept identical to `apps/admin/lib/session.ts`.
 */

const ANON = '00000000-0000-0000-0000-000000000000';
const IDLE_MINUTES = 20;

afterAll(async () => { await closeDatabase(); });

/**
 * A fresh operator per test.
 *
 * The shared harness operator is not usable here: one of these tests suspends
 * the account, and sharing it made a later test fail for a reason that had
 * nothing to do with what it was checking.
 */
async function operator(): Promise<string> {
  const id = randomUUID();
  await withPlatform({ operatorId: ANON, reason: 'test operator provisioning' }, async (db) => {
    await db.execute(sql`
      INSERT INTO platform_operators (id, email, full_name, password_hash, operator_role)
      VALUES (${id}, ${`op-${id}@test.invalid`}, 'Test Operator', 'not-a-real-hash', 'admin')`);
  });
  return id;
}

async function resolve(token: string): Promise<string | null> {
  return withPlatform({ operatorId: ANON, reason: 'test session resolution' }, async (db) => {
    const res = await db.execute<{ operator_id: string }>(sql`
      UPDATE platform_operator_sessions s
         SET last_seen_at = now(),
             idle_expires_at = now() + (${String(IDLE_MINUTES)} || ' minutes')::interval
        FROM platform_operators o
       WHERE s.token_hash = ${hashSessionToken(token)}
         AND s.operator_id = o.id
         AND s.revoked_at IS NULL
         AND s.idle_expires_at > now()
         AND s.absolute_expires_at > now()
         AND o.status = 'active'
      RETURNING s.operator_id`);
    return res.rows[0]?.operator_id ?? null;
  });
}

/**
 * Offsets are minutes from now, bound as numbers and turned into intervals by
 * Postgres. Passing `now() + interval '8 hours'` as a parameter does not work:
 * a bound value is a literal, not an expression.
 */
async function openSession(
  operatorId: string,
  offsets: { absoluteMinutes?: number; idleMinutes?: number } = {},
): Promise<string> {
  const token = mintSessionToken();
  const absolute = offsets.absoluteMinutes ?? 8 * 60;
  const idle = offsets.idleMinutes ?? IDLE_MINUTES;
  await withPlatform({ operatorId: ANON, reason: 'test session creation' }, async (db) => {
    await db.execute(sql`
      INSERT INTO platform_operator_sessions
        (operator_id, token_hash, mfa_satisfied, absolute_expires_at, idle_expires_at)
      VALUES (${operatorId}, ${hashSessionToken(token)}, true,
              now() + (${String(absolute)} || ' minutes')::interval,
              now() + (${String(idle)} || ' minutes')::interval)`);
  });
  return token;
}

describe('operator sessions', () => {
  it('resolves a freshly issued token', async () => {
    const id = await operator();
    expect(await resolve(await openSession(id))).toBe(id);
  });

  it('refuses an operator id presented as a token', async () => {
    // The original defect, stated as a test: the cookie used to be this value.
    const id = await operator();
    await openSession(id);
    expect(await resolve(id)).toBeNull();
  });

  it('refuses a random token', async () => {
    await operator();
    expect(await resolve(mintSessionToken())).toBeNull();
    expect(await resolve(randomUUID())).toBeNull();
  });

  it('refuses a revoked token, so signing out ends the session everywhere', async () => {
    const id = await operator();
    const token = await openSession(id);
    await withPlatform({ operatorId: ANON, reason: 'test revocation' }, async (db) => {
      await db.execute(sql`
        UPDATE platform_operator_sessions SET revoked_at = now(), revoked_reason = 'test'
         WHERE token_hash = ${hashSessionToken(token)}`);
    });
    expect(await resolve(token)).toBeNull();
  });

  it('refuses a token past its idle window', async () => {
    const id = await operator();
    const token = await openSession(id, { idleMinutes: -1 });
    expect(await resolve(token)).toBeNull();
  });

  it('refuses a token past its absolute expiry, however recently it was used', async () => {
    const id = await operator();
    const token = await openSession(id, { absoluteMinutes: -1, idleMinutes: 20 });
    expect(await resolve(token)).toBeNull();
  });

  it('refuses a session belonging to a suspended operator', async () => {
    const id = await operator();
    const token = await openSession(id);
    await withPlatform({ operatorId: ANON, reason: 'test suspension' }, async (db) => {
      await db.execute(sql`
        UPDATE platform_operators SET status = 'suspended' WHERE id = ${id}`);
    });
    expect(await resolve(token)).toBeNull();
  });

  it('slides the idle window on use', async () => {
    const id = await operator();
    const token = await openSession(id, { idleMinutes: 2 });
    await resolve(token);
    const idle = await withPlatform(
      { operatorId: ANON, reason: 'test idle window' },
      async (db) => {
        const res = await db.execute<{ minutes: string }>(sql`
          SELECT extract(epoch FROM (idle_expires_at - now())) / 60 AS minutes
            FROM platform_operator_sessions WHERE token_hash = ${hashSessionToken(token)}`);
        return Number(res.rows[0]!.minutes);
      },
    );
    expect(idle).toBeGreaterThan(15);
  });
});

describe('the platform audit ledger', () => {
  it('hash-chains its entries and verifies', async () => {
    const id = await operator();
    await withPlatform({ operatorId: ANON, reason: 'test audit write' }, async (db) => {
      for (const action of ['platform.login.failed', 'platform.login.succeeded']) {
        await db.execute(sql`
          INSERT INTO platform_audit_events
            (actor_operator_id, actor_label, action, resource_type, resource_id,
             reason, source, severity)
          VALUES (${id}, 'operator', ${action}, 'platform_operator', ${id},
                  'test', 'test', 'security')`);
      }
    });

    const result = await withPlatform(
      { operatorId: ANON, reason: 'test chain verification' },
      async (db) => {
        const res = await db.execute<{ ok: boolean; checked: string; detail: string }>(sql`
          SELECT ok, checked::text, detail FROM app.verify_platform_audit_chain()`);
        return res.rows[0]!;
      },
    );
    expect(result.ok).toBe(true);
    expect(Number(result.checked)).toBeGreaterThanOrEqual(2);
  });

  it('is append-only, so an entry cannot be rewritten', async () => {
    await expect(
      withPlatform({ operatorId: ANON, reason: 'test append-only' }, async (db) =>
        db.execute(sql`UPDATE platform_audit_events SET reason = 'tampered'`)),
      // The grant is revoked as well as the trigger being in place, so
      // Postgres refuses before the trigger is ever reached. Either message is
      // the property we want.
    ).rejects.toThrow(/append-only|permission denied/i);
  });
});
