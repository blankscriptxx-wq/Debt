import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, workflowPrincipal, type Principal } from '@solvenda/auth';
import {
  sendCommunication, recordInbound, caseTimeline, engagementSummary,
  SimulatedChannel, defaultChannels, CommunicationBlockedError,
} from '@solvenda/comms';

let tenant: TestTenant;
let caseId: string;
let clientId: string;
const channels = defaultChannels();

function adviser(): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(['comms:send', 'comms:read', 'case:read']),
    competencies: [], mfaSatisfied: true, status: 'active',
  };
}

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('comms');
  const ids = await tenant.as(async (db) => {
    const c = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, email, phone_mobile,
                           address_line1, address_postcode, contact_preferences)
      VALUES ('CL-1','Joanne','Whitfield','jo@example.test','07700 900123',
              '9 New Road','AB1 2CD', '{"declinedChannels":["sms"]}'::jsonb)
      RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
      VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'live', ${tenant.userId}) RETURNING id`);
    return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id };
  });
  clientId = ids.clientId;
  caseId = ids.caseId;
});

afterAll(async () => { await closeDatabase(); });

describe('sending', () => {
  it('sends on a permitted channel and records it as simulated', async () => {
    const result = await tenant.as((db) => sendCommunication(
      db, tenant.context, adviser(), channels.get('email')!, {
        caseId, clientId, channel: 'email',
        subject: 'Your plan is set up',
        body: 'Hello Joanne, your payment plan starts on the 1st.',
      }));

    expect(result.delivered).toBe(true);
    // Nothing has been sent anywhere. The record says so, and the console
    // shows it, because a firm believing a message went out when it did not is
    // worse than the message not going out.
    expect(result.simulated).toBe(true);

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM communications WHERE id = ${result.communicationId}`);
      return r.rows[0]!;
    });
    expect(row['channel']).toBe('email');
    expect(row['direction']).toBe('outbound');
    expect(row['counterparty_label']).toBe('jo@example.test');
    expect(row['provider']).toBe('sandbox-email');
    expect(row['simulated']).toBe(true);
  });

  it('honours a channel the client has declined', async () => {
    await expect(
      tenant.as((db) => sendCommunication(db, tenant.context, adviser(), channels.get('sms')!, {
        caseId, clientId, channel: 'sms', body: 'A reminder about your payment.',
      })),
    ).rejects.toThrow(/has asked not to be contacted by sms/);
  });

  it('allows a statutory communication to override, with a stated basis', async () => {
    await expect(
      tenant.as((db) => sendCommunication(db, tenant.context, adviser(), channels.get('sms')!, {
        caseId, clientId, channel: 'sms', body: 'Statutory notice.', statutory: true,
      })),
    ).rejects.toThrow(/must state its basis/);

    const result = await tenant.as((db) => sendCommunication(
      db, tenant.context, adviser(), channels.get('sms')!, {
        caseId, clientId, channel: 'sms',
        body: 'Your Breathing Space moratorium ends on 14 September.',
        statutory: true,
        statutoryBasis: 'Debt Respite Scheme Regulations 2020 - end of moratorium notice',
      }));
    expect(result.delivered).toBe(true);

    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT reason, after_state FROM audit_events
         WHERE action = 'comms.message.sent' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['reason']).toMatch(/Debt Respite Scheme/);
    expect((event['after_state'] as Record<string, unknown>)['overrodePreference']).toBe(true);
  });

  it('refuses to send a message with unresolved placeholders', async () => {
    await expect(
      tenant.as((db) => sendCommunication(db, tenant.context, adviser(), channels.get('email')!, {
        caseId, clientId, channel: 'email',
        body: 'Hello {{ client.firstName }}, your balance is {{balance}}.',
      })),
    ).rejects.toThrow(/unresolved placeholders/);
  });

  it('refuses a channel the client has no address for', async () => {
    const noContact = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO clients (reference, first_name, last_name) VALUES ('CL-2','A','B') RETURNING id`);
      return r.rows[0]!.id;
    });
    await expect(
      tenant.as((db) => sendCommunication(db, tenant.context, adviser(), channels.get('email')!, {
        clientId: noContact, channel: 'email', body: 'Hello.',
      })),
    ).rejects.toThrow(CommunicationBlockedError);
  });

  it('stores a redacted rendering alongside the original', async () => {
    const result = await tenant.as((db) => sendCommunication(
      db, tenant.context, adviser(), channels.get('email')!, {
        caseId, clientId, channel: 'email',
        body: 'Reference AB123456C. Please call 07700 900123.',
      }));
    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ body: string; body_redacted: string }>(sql`
        SELECT body, body_redacted FROM communications WHERE id = ${result.communicationId}`);
      return r.rows[0]!;
    });
    expect(row.body).toContain('AB123456C');
    // What leaves the platform is the redacted version, not the original.
    expect(row.body_redacted).not.toContain('AB123456C');
    expect(row.body_redacted).not.toContain('07700 900123');
  });

  it('lets a workflow send, and records that it did', async () => {
    const result = await tenant.as((db) => sendCommunication(
      db, tenant.context, workflowPrincipal(tenant.id, 'run-1', ['comms:send']),
      channels.get('email')!, {
        caseId, clientId, channel: 'email', body: 'Automated review reminder.',
        templateKey: 'review-reminder',
      }));
    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT sent_by, sent_by_type, template_key FROM communications
         WHERE id = ${result.communicationId}`);
      return r.rows[0]!;
    });
    expect(row['sent_by']).toBeNull();
    expect(row['sent_by_type']).toBe('workflow');
    expect(row['template_key']).toBe('review-reminder');
  });
});

describe('channel adapters', () => {
  it('validates the recipient like a real provider would', async () => {
    const email = new SimulatedChannel('email');
    expect((await email.send({ channel: 'email', to: 'not-an-address', body: 'x' })).status).toBe('failed');
    expect((await email.send({ channel: 'email', to: 'a@b.test', body: 'x' })).status).toBe('sent');
    expect((await email.send({ channel: 'email', to: 'a@b.test', body: '  ' })).failureReason)
      .toBe('Message body is empty');
  });

  it('is deterministic, so tests can assert on it', async () => {
    const sms = new SimulatedChannel('sms');
    const a = await sms.send({ channel: 'sms', to: '+447700900123', body: 'hello' });
    const b = await sms.send({ channel: 'sms', to: '+447700900123', body: 'hello' });
    expect(a.providerMessageId).toBe(b.providerMessageId);
  });
});

describe('the case timeline', () => {
  it('merges communications, audit entries and domain events into one account', async () => {
    await tenant.as((db) => recordInbound(db, tenant.context, {
      caseId, clientId, channel: 'email',
      subject: 'Re: your plan', body: 'Thanks, that all makes sense.',
    }));
    await tenant.as((db) => recordInbound(db, tenant.context, {
      caseId, channel: 'internal-note',
      body: 'Client sounded stressed on the call; check support needs at review.',
    }));
    await tenant.as((db) => db.execute(sql`
      INSERT INTO domain_events (event_type, case_id, client_id, payload, source)
      VALUES ('case.stage-changed', ${caseId}, ${clientId}, '{"to":"live"}'::jsonb, 'console')`));

    const timeline = await tenant.as((db) => caseTimeline(db, caseId));
    const kinds = new Set(timeline.map((e) => e.kind));
    expect(kinds).toContain('communication');
    expect(kinds).toContain('audit');
    expect(kinds).toContain('event');

    // Newest first.
    const times = timeline.map((e) => new Date(e.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('shows the redacted body, not the original', async () => {
    const timeline = await tenant.as((db) => caseTimeline(db, caseId));
    const withNi = timeline.find((e) => e.detail?.includes('Reference'));
    expect(withNi?.detail).not.toContain('AB123456C');
  });

  it('leaves routine reads out unless asked for', async () => {
    const quiet = await tenant.as((db) => caseTimeline(db, caseId));
    const noisy = await tenant.as((db) => caseTimeline(db, caseId, { includeInformational: true }));
    expect(noisy.length).toBeGreaterThanOrEqual(quiet.length);
  });

  it('keeps internal notes on the timeline but marked internal', async () => {
    const timeline = await tenant.as((db) => caseTimeline(db, caseId));
    const note = timeline.find((e) => e.channel === 'internal-note');
    expect(note).toBeDefined();
    expect(note!.direction).toBe('internal');
  });
});

describe('engagement', () => {
  it('counts outbound messages sent since the client last replied', async () => {
    const fresh = await createTestTenant('engagement');
    const ids = await fresh.as(async (db) => {
      const c = await db.execute<{ id: string }>(sql`
        INSERT INTO clients (reference, first_name, last_name, email)
        VALUES ('CL-1','A','B','a@b.test') RETURNING id`);
      const k = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage)
        VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'live') RETURNING id`);
      return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id };
    });

    await fresh.as((db) => recordInbound(db, fresh.context, {
      caseId: ids.caseId, clientId: ids.clientId, channel: 'email',
      body: 'Reply from the client.',
      occurredAt: new Date('2026-06-01T10:00:00Z'),
    }));
    for (let i = 0; i < 3; i++) {
      await fresh.as((db) => db.execute(sql`
        INSERT INTO communications (case_id, client_id, channel, direction, body, occurred_at)
        VALUES (${ids.caseId}, ${ids.clientId}, 'email', 'outbound', 'Chasing',
                ${`2026-07-0${i + 1}T10:00:00Z`})`));
    }

    const summary = await fresh.as((db) => engagementSummary(db, ids.clientId));
    expect(summary.unansweredOutboundCount).toBe(3);
    expect(summary.lastClientResponseAt).toBeTruthy();
  });
});
