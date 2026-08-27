import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { createTestTenant, expectDbError, superuserCredentialsAvailable, withSuperuser, type TestTenant } from '@solvenda/testing';
import { recordAudit, auditedMutation, verifyAuditChain, changedFields, redact, AuditReasonRequiredError } from '@solvenda/audit';

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  tenant = await createTestTenant('audit');
  other = await createTestTenant('audit-other');
});
afterAll(async () => { await closeDatabase(); });

describe('audit ledger', () => {
  it('records who, what, when, why, source, before and after', async () => {
    const event = await tenant.as((db) =>
      recordAudit(db, tenant.context, {
        action: 'client.updated',
        resourceType: 'client',
        resourceId: tenant.userId,
        reason: 'Client reported a change of address by telephone',
        source: 'console',
        before: { addressLine1: '1 Old Street', postcode: 'AB1 2CD' },
        after: { addressLine1: '9 New Road', postcode: 'AB1 2CD' },
      }),
    );

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM audit_events WHERE id = ${event.id}`);
      return r.rows[0]!;
    });

    expect(row['actor_user_id']).toBe(tenant.userId);          // WHO
    expect(row['action']).toBe('client.updated');              // WHAT
    expect(row['occurred_at']).toBeTruthy();                   // WHEN
    expect(row['reason']).toMatch(/change of address/);        // WHY
    expect(row['source']).toBe('console');                     // SOURCE
    expect(row['before_state']).toMatchObject({ addressLine1: '1 Old Street' });
    expect(row['after_state']).toMatchObject({ addressLine1: '9 New Road' });
    expect(row['changed_fields']).toEqual(['addressLine1']);
  });

  it('refuses a regulated action with no stated reason', async () => {
    await expect(
      tenant.as((db) =>
        recordAudit(db, tenant.context, {
          action: 'advice.decision.recorded',
          resourceType: 'case',
          source: 'console',
        }),
      ),
    ).rejects.toThrow(AuditReasonRequiredError);
  });

  it('chains each entry to its predecessor', async () => {
    const rows = await tenant.as(async (db) => {
      const r = await db.execute<{ seq: string; prev_hash: string; hash: string }>(sql`
        SELECT seq::text, prev_hash, hash FROM audit_events ORDER BY seq`);
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    }
  });

  it('keeps each tenant chain independent', async () => {
    await other.as((db) =>
      recordAudit(db, other.context, {
        action: 'client.created', resourceType: 'client', source: 'console',
      }),
    );
    const firstOfOther = await other.as(async (db) => {
      const r = await db.execute<{ seq: string; prev_hash: string }>(sql`
        SELECT seq::text, prev_hash FROM audit_events ORDER BY seq LIMIT 1`);
      return r.rows[0]!;
    });
    expect(firstOfOther.seq).toBe('1');
    expect(firstOfOther.prev_hash).toBe('0'.repeat(64));
  });

  it('verifies clean chains', async () => {
    const results = await withPlatform(
      { operatorId: tenant.operatorId, reason: 'integrity verification test' },
      // Scoped to this test's own tenants: another test in the suite
      // deliberately corrupts a chain to prove detection works.
      (db) => verifyAuditChain(db, tenant.id),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.ok, `tenant ${r.tenantId}: ${r.detail}`).toBe(true);
    }
  });

  it('cannot be edited, even by the platform role', async () => {
    await expectDbError(
      withPlatform({ operatorId: tenant.operatorId, reason: 'attempt to rewrite history' },
        (db) => db.execute(sql`UPDATE audit_events SET reason = 'tampered'`)),
      /permission denied|append-only/i,
    );
  });

  it('cannot be deleted, even by the platform role', async () => {
    await expectDbError(
      withPlatform({ operatorId: tenant.operatorId, reason: 'attempt to delete history' },
        (db) => db.execute(sql`DELETE FROM audit_events`)),
      /permission denied|append-only/i,
    );
  });

  it('resists edits even from an owner-level connection with the trigger disabled', async () => {
    // Row level security is FORCEd, so the schema owner is subject to it too.
    // Disabling the append-only trigger therefore buys an attacker nothing:
    // the UPDATE still matches no rows.
    const { withOwner } = await import('../../db/src/client.js');
    const target = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM audit_events ORDER BY seq LIMIT 1`);
      return r.rows[0]!.id;
    });

    const affected = await withOwner(async (client) => {
      await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
      const res = await client.query(
        `UPDATE audit_events SET reason = 'quietly rewritten' WHERE id = $1`, [target]);
      await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
      return res.rowCount;
    });
    expect(affected).toBe(0);
  });

  it.skipIf(!superuserCredentialsAvailable())(
    'detects history rewritten by someone with full database access', async () => {
    // The threat the hash chain actually defends against: an attacker who has
    // already escaped the application and can write to Postgres directly.
    const victim = await createTestTenant('tamper');
    await victim.as((db) => recordAudit(db, victim.context, {
      action: 'client.created', resourceType: 'client', source: 'console',
      after: { name: 'Original Name' },
    }));
    await victim.as((db) => recordAudit(db, victim.context, {
      action: 'client.updated', resourceType: 'client', source: 'console',
      after: { name: 'Second Entry' },
    }));

    await withSuperuser(async (client) => {
      await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
      const res = await client.query(
        `UPDATE audit_events SET reason = 'inserted after the fact'
          WHERE tenant_id = $1 AND seq = 1`, [victim.id]);
      await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
      expect(res.rowCount).toBe(1);
    });

    const results = await withPlatform(
      { operatorId: victim.operatorId, reason: 'integrity verification after tamper' },
      (db) => verifyAuditChain(db, victim.id),
    );
    const report = results.find((r) => r.tenantId === victim.id)!;
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/hash does not match/);
    expect(report.firstBadSeq).toBe(1);
  });

});

describe('audit payload handling', () => {
  it('lists only the fields that actually changed', () => {
    expect(changedFields({ a: 1, b: 2, c: [1, 2] }, { a: 1, b: 3, c: [1, 2] })).toEqual(['b']);
    expect(changedFields({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(['a']);
    expect(changedFields(null, { a: 1 })).toEqual(['a']);
  });

  it('strips credential material before anything is stored', () => {
    const out = redact({
      email: 'a@b.test',
      passwordHash: '$argon2id$v=19$...',
      nested: { mfaSecret: 'JBSWY3DP', keep: 'yes' },
    });
    expect(out).toEqual({
      email: 'a@b.test',
      passwordHash: '[redacted]',
      nested: { mfaSecret: '[redacted]', keep: 'yes' },
    });
  });

  it('captures before and after around a real mutation', async () => {
    const { audit } = await tenant.as((db) =>
      auditedMutation(
        db, tenant.context,
        { action: 'client.updated', resourceType: 'user', resourceId: tenant.userId,
          reason: 'job title correction', source: 'console' },
        {
          readSnapshot: async (d) => {
            const r = await d.execute<Record<string, unknown>>(sql`
              SELECT full_name, job_title FROM users WHERE id = ${tenant.userId}`);
            return r.rows[0] ?? null;
          },
          mutate: (d) => d.execute(sql`
            UPDATE users SET job_title = 'Senior Debt Adviser' WHERE id = ${tenant.userId}`),
        },
      ),
    );

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT before_state, after_state, changed_fields FROM audit_events WHERE id = ${audit.id}`);
      return r.rows[0]!;
    });
    expect(row['changed_fields']).toEqual(['job_title']);
    expect((row['after_state'] as Record<string, unknown>)['job_title']).toBe('Senior Debt Adviser');
  });
});
