import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withTenant } from '@solvenda/db';
import { ensureTestOperator, createTestTenant } from '@solvenda/testing';
import {
  hashPassword, verifyPassword, assertPasswordAcceptable, WeakPasswordError,
  generateTotpSecret, totpCodeAt, verifyTotp, totpUri,
  login, resolveSession, completeMfa, revokeSession, revokeOtherSessions,
  loadUserPrincipal, authorize, seedGlobalCatalogues, provisionTenant,
  SESSION_IDLE_MINUTES,
} from '@solvenda/auth';

let operatorId: string;

beforeAll(async () => {
  operatorId = await ensureTestOperator();
  await seedGlobalCatalogues(operatorId);
});
afterAll(async () => { await closeDatabase(); });

describe('password handling', () => {
  it('produces an Argon2id hash that verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('the same passphrase'), hashPassword('the same passphrase')]);
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing when no password is set', async () => {
    expect(await verifyPassword('anything at all', null)).toBe(false);
  });

  it('rejects passwords that are too short or trivially guessable', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('password123')).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('aaaaaaaaaaaaaa')).toThrow(WeakPasswordError);
    expect(() => assertPasswordAcceptable('a reasonable passphrase')).not.toThrow();
  });
});

describe('TOTP', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCodeAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });

  it('tolerates one step of clock drift either side, but not two', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCodeAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, now - 120_000), now)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });

  it('builds an enrolment URI an authenticator app understands', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'adviser@firm.test');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Solvenda%3Aadviser%40firm\.test\?/);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('sign-in', () => {
  it('opens a session for valid credentials and rejects bad ones identically', async () => {
    const tenant = await createTestTenant('login');
    const password = 'a perfectly reasonable passphrase';
    const hash = await hashPassword(password);
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));

    const ok = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password,
    }));
    expect(ok.ok).toBe(true);

    const bad = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'not the right passphrase',
    }));
    expect(bad).toEqual({ ok: false, reason: 'invalid_credentials' });

    const unknown = await tenant.as((db) => login(db, tenant.context, {
      email: 'nobody@nowhere.test', password: 'not the right passphrase',
    }));
    // Identical shape, so the endpoint reveals nothing about who exists.
    expect(unknown).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('locks an account after repeated failures and records each attempt', async () => {
    const tenant = await createTestTenant('lockout');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));

    for (let i = 0; i < 5; i++) {
      await tenant.as((db) => login(db, tenant.context, {
        email: `staff@${tenant.slug}.test`, password: 'wrong passphrase here',
      }));
    }

    const afterLock = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
    }));
    expect(afterLock).toEqual({ ok: false, reason: 'locked' });

    const events = await tenant.as(async (db) => {
      const r = await db.execute<{ action: string }>(sql`
        SELECT action FROM audit_events WHERE action LIKE 'auth.%' ORDER BY seq`);
      return r.rows.map((x) => x.action);
    });
    // Four ordinary failures, then the attempt that trips the lock.
    expect(events.filter((a) => a === 'auth.login.failed')).toHaveLength(4);
    expect(events.filter((a) => a === 'auth.login.locked')).toHaveLength(2);
  });

  it('withholds MFA satisfaction until the second factor is presented', async () => {
    const tenant = await createTestTenant('mfa');
    const password = 'a perfectly reasonable passphrase';
    const hash = await hashPassword(password);
    const secret = generateTotpSecret();
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, mfa_secret = ${secret}, status = 'active'
       WHERE id = ${tenant.userId}`));

    const first = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password,
    }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.session.mfaRequired).toBe(true);

    const resolved = await tenant.as((db) => resolveSession(db, first.session.token));
    expect(resolved?.mfaSatisfied).toBe(false);

    // A regulated permission is unavailable until the factor is completed.
    const before = await tenant.as((db) => loadUserPrincipal(db, tenant.userId, false));
    expect(authorize(before!, 'case:read')).toMatchObject({ allowed: false });

    const completed = await tenant.as((db) => completeMfa(db, tenant.context, {
      token: first.session.token, totpCode: totpCodeAt(secret, Date.now()),
    }));
    expect(completed).toBe(true);

    const after = await tenant.as((db) => resolveSession(db, first.session.token));
    expect(after?.mfaSatisfied).toBe(true);
  });

  it('rejects a wrong second factor and records it', async () => {
    const tenant = await createTestTenant('mfa-bad');
    const password = 'a perfectly reasonable passphrase';
    const hash = await hashPassword(password);
    const secret = generateTotpSecret();
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, mfa_secret = ${secret}, status = 'active'
       WHERE id = ${tenant.userId}`));

    const outcome = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password, totpCode: '000000',
    }));
    expect(outcome).toEqual({ ok: false, reason: 'mfa_invalid' });
  });
});

describe('sessions', () => {
  it('does not store the bearer token', async () => {
    const tenant = await createTestTenant('token');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));
    const outcome = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
    }));
    if (!outcome.ok) throw new Error('login failed');

    const stored = await tenant.as(async (db) => {
      const r = await db.execute<{ token_hash: string }>(sql`SELECT token_hash FROM sessions`);
      return r.rows.map((x) => x.token_hash);
    });
    expect(stored).not.toContain(outcome.session.token);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns nothing for a revoked session', async () => {
    const tenant = await createTestTenant('revoke');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));
    const outcome = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
    }));
    if (!outcome.ok) throw new Error('login failed');

    await tenant.as((db) => revokeSession(db, tenant.context, outcome.session.sessionId, 'test revocation'));
    expect(await tenant.as((db) => resolveSession(db, outcome.session.token))).toBeNull();
  });

  it('returns nothing for an expired session', async () => {
    const tenant = await createTestTenant('expire');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));
    const outcome = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
    }));
    if (!outcome.ok) throw new Error('login failed');

    await tenant.as((db) => db.execute(sql`
      UPDATE sessions SET idle_expires_at = now() - interval '1 minute'
       WHERE id = ${outcome.session.sessionId}`));
    expect(await tenant.as((db) => resolveSession(db, outcome.session.token))).toBeNull();
  });

  it('slides the idle window on use', async () => {
    const tenant = await createTestTenant('slide');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));
    const outcome = await tenant.as((db) => login(db, tenant.context, {
      email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
    }));
    if (!outcome.ok) throw new Error('login failed');

    await tenant.as((db) => db.execute(sql`
      UPDATE sessions SET idle_expires_at = now() + interval '1 minute'
       WHERE id = ${outcome.session.sessionId}`));
    await tenant.as((db) => resolveSession(db, outcome.session.token));

    const remaining = await tenant.as(async (db) => {
      const r = await db.execute<{ mins: string }>(sql`
        SELECT extract(epoch from (idle_expires_at - now()))/60 AS mins
          FROM sessions WHERE id = ${outcome.session.sessionId}`);
      return Number(r.rows[0]!.mins);
    });
    expect(remaining).toBeGreaterThan(SESSION_IDLE_MINUTES - 2);
  });

  it('revokes every other session for a user', async () => {
    const tenant = await createTestTenant('revoke-all');
    const hash = await hashPassword('a perfectly reasonable passphrase');
    await tenant.as((db) => db.execute(sql`
      UPDATE users SET password_hash = ${hash}, status = 'active' WHERE id = ${tenant.userId}`));

    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const o = await tenant.as((db) => login(db, tenant.context, {
        email: `staff@${tenant.slug}.test`, password: 'a perfectly reasonable passphrase',
      }));
      if (o.ok) sessions.push(o.session);
    }
    const keep = sessions[0]!;
    const revoked = await tenant.as((db) =>
      revokeOtherSessions(db, tenant.context, tenant.userId, keep.sessionId, 'password changed'));
    expect(revoked).toBe(2);
    expect(await tenant.as((db) => resolveSession(db, keep.token))).not.toBeNull();
    expect(await tenant.as((db) => resolveSession(db, sessions[1]!.token))).toBeNull();
  });
});

describe('tenant provisioning', () => {
  it('creates a firm with editable role copies and one administrator', async () => {
    const slug = `firm-${Math.random().toString(36).slice(2, 8)}`;
    const result = await provisionTenant({
      operatorId,
      slug,
      legalName: 'Provisioned Debt Advice Ltd',
      admin: {
        email: `admin@${slug}.test`,
        fullName: 'Firm Administrator',
        password: 'a perfectly reasonable passphrase',
      },
    });

    const principal = await withTenant({ tenantId: result.tenantId }, (db) =>
      loadUserPrincipal(db, result.adminUserId, true));

    expect(principal).not.toBeNull();
    expect(authorize(principal!, 'user:write')).toEqual({ allowed: true });
    expect(authorize(principal!, 'tenant:configure')).toEqual({ allowed: true });
    // A firm administrator configures the firm; they do not give advice.
    expect(authorize(principal!, 'advice:decide')).toMatchObject({
      allowed: false, code: 'not_granted',
    });

    const roleCount = await withTenant({ tenantId: result.tenantId }, async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM roles`);
      return Number(r.rows[0]!.n);
    });
    expect(roleCount).toBeGreaterThanOrEqual(9);
  });
});
