import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform, withPublic } from '@solvenda/db';
import { expectDbError, createTestTenant } from '@solvenda/testing';
import { recordEnquiry, resetThrottle, throttle } from '@solvenda/core';

/**
 * The unauthenticated path is the one place in the platform where a request
 * with no identity writes to the database. These tests exist to prove that the
 * only thing it can do is deposit an enquiry: everything else has to be denied
 * by the database, not by the application remembering to check.
 */

afterAll(async () => { await closeDatabase(); });
beforeEach(() => { resetThrottle(); });

describe('the unauthenticated database path', () => {
  it('records an enquiry', async () => {
    // Unique per run: enquiries are deliberately never deleted, and the test
    // database is not reset between runs.
    const email = `priya+${randomUUID().slice(0, 8)}@ashworth.test`;
    await recordEnquiry({
      name: 'Priya Raghunathan',
      organisation: 'Ashworth Debt Solutions',
      email,
      message: 'We run about 4,000 DMPs and our QA sampling is killing us.',
      enquiryType: 'demo',
      sourcePath: '/contact',
    });

    const rows = await withPlatform(
      { operatorId: (await createTestTenant('enq')).operatorId, reason: 'test read of enquiries' },
      async (db) => {
        const r = await db.execute<{ email: string; enquiry_type: string; status: string }>(sql`
          SELECT email, enquiry_type, status FROM platform_enquiries
           WHERE email = ${email}`);
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enquiry_type).toBe('demo');
    expect(rows[0]!.status).toBe('new');
  });

  it('cannot read back the enquiries it writes', async () => {
    await expectDbError(
      withPublic(async (db) => db.execute(sql`SELECT * FROM platform_enquiries`)),
      /permission denied/i,
    );
  });

  it('sees no tenant data at all, because no tenant is bound', async () => {
    const alpha = await createTestTenant('pub-alpha');
    await alpha.as(async (db) => {
      await db.execute(sql`
        INSERT INTO users (email, full_name, user_type, status)
        VALUES ('hidden@pub-alpha.test', 'Hidden', 'client', 'active')`);
    });

    const seen = await withPublic(async (db) => {
      const r = await db.execute<{ email: string }>(sql`SELECT email FROM users`);
      return r.rows;
    });
    expect(seen).toEqual([]);
  });

  it('cannot write to a tenant table', async () => {
    await expectDbError(
      withPublic(async (db) =>
        db.execute(sql`
          INSERT INTO clients (first_name, last_name) VALUES ('Mallory', 'Unbound')`),
      ),
      /row-level security|null value in column "tenant_id"|violates/i,
    );
  });

  it('cannot reach platform administration tables', async () => {
    await expectDbError(
      withPublic(async (db) => db.execute(sql`SELECT * FROM tenant_subscriptions`)),
      /permission denied/i,
    );
  });

  it('rejects an enquiry the database constraints would reject', async () => {
    await expect(
      recordEnquiry({
        name: '',
        organisation: '',
        email: 'not-an-email',
        message: '',
        enquiryType: 'general',
        sourcePath: '/contact',
      }),
    ).rejects.toThrow();
  });

  it('throttles repeated submissions from one source', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(throttle('enquiry:198.51.100.7', 5, 60_000, now)).toBe(true);
    }
    expect(throttle('enquiry:198.51.100.7', 5, 60_000, now)).toBe(false);
    // A different source is unaffected, and the window does expire.
    expect(throttle('enquiry:198.51.100.8', 5, 60_000, now)).toBe(true);
    expect(throttle('enquiry:198.51.100.7', 5, 60_000, now + 60_001)).toBe(true);
  });
});
