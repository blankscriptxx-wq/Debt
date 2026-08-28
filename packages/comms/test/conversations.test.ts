import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, type Database } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, type Principal } from '@solvenda/auth';
import {
  receiveInbound, linkConversation, assignConversation, setConversationStatus,
  matchIdentifier, normaliseIdentifier, ingestAttachment, fileAttachment,
  AttachmentError,
} from '@solvenda/comms';

/**
 * Conversations, matching and attachments.
 *
 * The tests that matter most here are the ones about *not* matching. Filing one
 * client's bank statement onto another client's case is a data breach that
 * nobody notices, so the rule is that a person confirms an identity once and
 * the software never guesses — and these assert that the guess does not happen
 * even when it would look obviously right.
 */

let tenant: TestTenant;
let other: TestTenant;
let accountId: string;
let joanne: string;
let joanneCase: string;
let marcus: string;

const NUMBER = '+447700900123';

function adviser(permissions = ['case:write', 'document:write', 'case:read']): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(permissions), competencies: ['debt-advice'],
    mfaSatisfied: true, status: 'active',
  };
}

const inbound = (over: Partial<Parameters<typeof receiveInbound>[2]> = {}) =>
  tenant.as((db) => receiveInbound(db, tenant.context, {
    channelAccountId: accountId, channel: 'whatsapp', from: NUMBER,
    body: 'Hello, sending my payslip.', providerMessageId: `wamid.${Math.random()}`,
    ...over,
  }));

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('comms');
  other = await createTestTenant('comms-other');

  accountId = await tenant.as(async (db: Database) => {
    const r = await db.execute<{ id: string }>(sql`
      INSERT INTO channel_accounts (channel, identifier, display_name, provider_key, queue)
      VALUES ('whatsapp', '+441132000000', 'Northgate advice line', 'sandbox-whatsapp', 'advice')
      RETURNING id`);
    return r.rows[0]!.id;
  });

  const ids = await tenant.as(async (db) => {
    const a = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, jurisdiction, phone_mobile)
      VALUES ('CL-8001', 'Joanne', 'Whitfield', 'england-wales', '07700 900123') RETURNING id`);
    const b = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, jurisdiction, phone_mobile)
      VALUES ('CL-8002', 'Marcus', 'Adeyemi', 'england-wales', '07700 900123') RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, status)
      VALUES ('DMP-8001', ${a.rows[0]!.id}, 'dmp', 1, 'fact-find', 'open') RETURNING id`);
    return { a: a.rows[0]!.id, b: b.rows[0]!.id, k: k.rows[0]!.id };
  });
  joanne = ids.a; marcus = ids.b; joanneCase = ids.k;
});

afterAll(async () => { await closeDatabase(); });

describe('normalising an identifier', () => {
  it('treats the ways of writing one number as one number', () => {
    for (const written of ['07700 900123', '+44 7700 900123', '447700900123', '00447700900123']) {
      expect(normaliseIdentifier('whatsapp', written)).toBe(NUMBER);
    }
  });

  it('lowercases an email rather than reformatting it', () => {
    expect(normaliseIdentifier('email', ' Joanne@Example.TEST ')).toBe('joanne@example.test');
  });
});

describe('matching an unknown number', () => {
  it('offers candidates but refuses to decide', async () => {
    // Two clients share this number, which is what a household looks like.
    const match = await tenant.as((db) => matchIdentifier(db, 'whatsapp', NUMBER));
    expect(match.confidence).toBe('candidate');
    expect(match.clientId).toBeNull();
    expect(match.candidates.map((c) => c.clientId).sort())
      .toEqual([joanne, marcus].sort());
  });

  it('says so plainly when nobody on file uses the number', async () => {
    const match = await tenant.as((db) => matchIdentifier(db, 'whatsapp', '+447700999999'));
    expect(match.confidence).toBe('none');
    expect(match.reason).toContain('Nobody on file');
  });
});

describe('receiving a message', () => {
  it('opens an unmatched conversation rather than guessing whose it is', async () => {
    const received = await inbound();
    expect(received.matched).toBe(false);
    expect(received.clientId).toBeNull();

    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ client_id: string | null; status: string;
                                   first_unread_at: string | null }>(sql`
        SELECT client_id, status, first_unread_at::text FROM conversations
         WHERE id = ${received.conversationId}`);
      return r.rows[0]!;
    });
    expect(row.client_id).toBeNull();
    expect(row.status).toBe('open');
    // Unread from the moment it lands, which is what puts it in front of someone.
    expect(row.first_unread_at).not.toBeNull();
  });

  it('puts a second message in the same conversation, not a new one', async () => {
    const first = await inbound({ body: 'Are you there?' });
    const second = await inbound({ body: 'Sorry, one more thing.' });
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('records attachments as pending before the bytes are ours', async () => {
    const received = await inbound({
      body: null,
      attachments: [{
        providerMediaId: 'media-1', filename: 'payslip.pdf',
        contentType: 'application/pdf', mediaKind: 'document',
      }],
    });
    expect(received.attachmentIds).toHaveLength(1);

    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ ingest_status: string; document_id: string | null }>(sql`
        SELECT ingest_status, document_id FROM message_attachments
         WHERE id = ${received.attachmentIds[0]}`);
      return r.rows[0]!;
    });
    expect(row.ingest_status).toBe('pending');
    expect(row.document_id).toBeNull();
  });
});

describe('the same number reaching two firms', () => {
  it('routes by the number that received it, never by the sender', async () => {
    // The other firm has its own account and its own client on the same mobile.
    const theirAccount = await other.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO channel_accounts (channel, identifier, display_name)
        VALUES ('whatsapp', '+441619000000', 'Other firm') RETURNING id`);
      await db.execute(sql`
        INSERT INTO clients (reference, first_name, last_name, jurisdiction, phone_mobile)
        VALUES ('CL-8001', 'Someone', 'Else', 'england-wales', '07700 900123')`);
      return r.rows[0]!.id;
    });

    const received = await other.as((db) => receiveInbound(db, other.context, {
      channelAccountId: theirAccount, channel: 'whatsapp', from: NUMBER,
      body: 'Hello', providerMessageId: 'wamid.other',
    }));

    // Our firm cannot see it, and theirs cannot see ours.
    const visibleToUs = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM conversations WHERE id = ${received.conversationId}`);
      return Number(r.rows[0]!.n);
    });
    expect(visibleToUs).toBe(0);
  });

  it('refuses a channel account belonging to another firm', async () => {
    await expect(inbound({ channelAccountId: (await other.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM channel_accounts LIMIT 1`);
      return r.rows[0]!.id;
    })) })).rejects.toThrow();
  });
});

describe('linking a conversation', () => {
  it('remembers the answer, so the next message is recognised', async () => {
    const received = await inbound({ body: 'It is Joanne here.' });
    await tenant.as((db) => linkConversation(db, tenant.context, adviser(), {
      conversationId: received.conversationId, clientId: joanne,
    }));

    // The identity is now confirmed, so matching decides on its own.
    const match = await tenant.as((db) => matchIdentifier(db, 'whatsapp', NUMBER));
    expect(match.confidence).toBe('verified');
    expect(match.clientId).toBe(joanne);

    // And the messages already in the thread belong to the client too, so the
    // timeline does not start halfway through the conversation.
    const attached = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM communications
         WHERE conversation_id = ${received.conversationId} AND client_id = ${joanne}`);
      return Number(r.rows[0]!.n);
    });
    expect(attached).toBeGreaterThan(0);
  });

  it('records the link at security severity, because it is where a mix-up starts', async () => {
    const severity = await tenant.as(async (db) => {
      const r = await db.execute<{ severity: string }>(sql`
        SELECT severity FROM audit_events
         WHERE action = 'comms.conversation.linked' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!.severity;
    });
    expect(severity).toBe('security');
  });
});

describe('working the conversation', () => {
  it('assigns and returns to the queue', async () => {
    const received = await inbound({ from: '+447700900555', body: 'New person' });
    await tenant.as((db) => assignConversation(db, tenant.context, adviser(), {
      conversationId: received.conversationId, toUserId: tenant.userId,
    }));
    await tenant.as((db) => assignConversation(db, tenant.context, adviser(), {
      conversationId: received.conversationId, toUserId: null,
    }));

    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ assigned_to: string | null }>(sql`
        SELECT assigned_to FROM conversations WHERE id = ${received.conversationId}`);
      return r.rows[0]!;
    });
    expect(row.assigned_to).toBeNull();
  });

  it('clears what is owed when the thread is closed', async () => {
    const received = await inbound({ from: '+447700900666', body: 'Thanks, all done' });
    await tenant.as((db) => setConversationStatus(db, tenant.context, adviser(), {
      conversationId: received.conversationId, status: 'closed',
    }));

    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; reply_due_at: string | null }>(sql`
        SELECT status, reply_due_at::text FROM conversations
         WHERE id = ${received.conversationId}`);
      return r.rows[0]!;
    });
    expect(row.status).toBe('closed');
    expect(row.reply_due_at).toBeNull();
  });
});

describe('taking in an attachment', () => {
  const bytes = Buffer.from('%PDF-1.7 a payslip');
  const deps = {
    fetch: async () => ({
      bytes, contentType: 'application/pdf', filename: 'payslip-july.pdf',
    }),
    scan: async () => ({ clean: true }),
    store: async () => ({ storageKey: 'k/1', storageProvider: 'local' }),
  };

  it('holds it against the client but files it on no case', async () => {
    const received = await inbound({
      from: NUMBER, body: null,
      attachments: [{ providerMediaId: 'm-2', filename: 'payslip.pdf',
                      contentType: 'application/pdf', mediaKind: 'document' }],
    });
    const result = await tenant.as((db) =>
      ingestAttachment(db, tenant.context, received.attachmentIds[0]!, deps));

    expect(result.status).toBe('stored');
    const doc = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; case_id: string | null;
                                   source_channel: string | null }>(sql`
        SELECT status, case_id, source_channel FROM documents WHERE id = ${result.documentId}`);
      return r.rows[0]!;
    });
    expect(doc.status).toBe('unfiled');
    expect(doc.case_id).toBeNull();
    expect(doc.source_channel).toBe('whatsapp');
  });

  it('refuses a file whose checksum does not match what the provider sent', async () => {
    const received = await inbound({
      from: NUMBER, body: null,
      attachments: [{ providerMediaId: 'm-3', sha256: 'not-the-right-hash' }],
    });
    const result = await tenant.as((db) =>
      ingestAttachment(db, tenant.context, received.attachmentIds[0]!, deps));
    expect(result.status).toBe('failed');
    expect(result.documentId).toBeNull();
  });

  it('quarantines rather than stores anything a scanner objects to', async () => {
    const received = await inbound({
      from: NUMBER, body: null, attachments: [{ providerMediaId: 'm-4' }],
    });
    const result = await tenant.as((db) => ingestAttachment(db, tenant.context,
      received.attachmentIds[0]!,
      { ...deps, scan: async () => ({ clean: false, detail: 'EICAR test signature' }) }));

    expect(result.status).toBe('infected');
    expect(result.documentId).toBeNull();
    // Nothing was stored for this attachment specifically: an infected file
    // must not exist as a document anybody could later file onto a case.
    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ document_id: string | null; ingest_error: string }>(sql`
        SELECT document_id, ingest_error FROM message_attachments
         WHERE id = ${received.attachmentIds[0]}`);
      return r.rows[0]!;
    });
    expect(row.document_id).toBeNull();
    expect(row.ingest_error).toContain('EICAR');
  });

  it('gives up honestly when the provider no longer holds the file', async () => {
    const received = await inbound({
      from: NUMBER, body: null,
      attachments: [{ providerMediaId: 'm-5', expiresAt: new Date(Date.now() - 1000) }],
    });
    const result = await tenant.as((db) =>
      ingestAttachment(db, tenant.context, received.attachmentIds[0]!, deps));
    expect(result.status).toBe('expired');

    const error = await tenant.as(async (db) => {
      const r = await db.execute<{ ingest_error: string }>(sql`
        SELECT ingest_error FROM message_attachments WHERE id = ${received.attachmentIds[0]}`);
      return r.rows[0]!.ingest_error;
    });
    expect(error).toContain('send it again');
  });
});

describe('filing an attachment onto a case', () => {
  const deps = {
    fetch: async () => ({
      bytes: Buffer.from('%PDF statement'), contentType: 'application/pdf',
      filename: 'statement.pdf',
    }),
    scan: async () => ({ clean: true }),
    store: async () => ({ storageKey: 'k/2', storageProvider: 'local' }),
  };

  async function ingested() {
    const received = await inbound({
      from: NUMBER, body: null, attachments: [{ providerMediaId: `m-${Math.random()}` }],
    });
    await tenant.as((db) =>
      ingestAttachment(db, tenant.context, received.attachmentIds[0]!, deps));
    return received.attachmentIds[0]!;
  }

  it('moves the verification requirement it answers, so the case advances', async () => {
    const attachmentId = await ingested();
    await tenant.as(async (db) => {
      await db.execute(sql`
        INSERT INTO verification_items (case_id, client_id, requirement_key, category)
        VALUES (${joanneCase}, ${joanne}, 'income.bank-statements', 'income')
        ON CONFLICT (case_id, requirement_key) DO NOTHING`);
    });

    const filed = await tenant.as((db) => fileAttachment(db, tenant.context, adviser(), {
      attachmentId, caseId: joanneCase, documentType: 'bank-statement',
      satisfiesRequirement: 'income.bank-statements',
    }));
    expect(filed.requirementSatisfied).toBe('income.bank-statements');

    const item = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; method: string | null;
                                   document_id: string | null }>(sql`
        SELECT status, method, document_id FROM verification_items
         WHERE case_id = ${joanneCase} AND requirement_key = 'income.bank-statements'`);
      return r.rows[0]!;
    });
    expect(item.status).toBe('verified');
    expect(item.method).toBe('document');
    expect(item.document_id).toBe(filed.documentId);
  });

  it('refuses to file onto a case belonging to somebody else', async () => {
    const attachmentId = await ingested();
    const marcusCase = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, status)
        VALUES ('DMP-8002', ${marcus}, 'dmp', 1, 'fact-find', 'open') RETURNING id`);
      return r.rows[0]!.id;
    });

    await expect(tenant.as((db) => fileAttachment(db, tenant.context, adviser(), {
      attachmentId, caseId: marcusCase, documentType: 'bank-statement',
    }))).rejects.toBeInstanceOf(AttachmentError);
  });

  it('records whether a person chose the classification or accepted a suggestion', async () => {
    const attachmentId = await ingested();
    const filed = await tenant.as((db) => fileAttachment(db, tenant.context, adviser(), {
      attachmentId, caseId: joanneCase, documentType: 'payslip',
      acceptedSuggestion: true,
    }));

    const doc = await tenant.as(async (db) => {
      const r = await db.execute<{ classified_by: string; accepted_by: string | null;
                                   source_communication_id: string | null }>(sql`
        SELECT classified_by, classification_accepted_by AS accepted_by,
               source_communication_id
          FROM documents WHERE id = ${filed.documentId}`);
      return r.rows[0]!;
    });
    // The suggestion is credited to the AI, and the acceptance to the person —
    // "it guessed and nobody looked" must stay distinguishable from
    // "somebody read it and agreed".
    expect(doc.classified_by).toBe('ai');
    expect(doc.accepted_by).toBe(tenant.userId);
    expect(doc.source_communication_id).not.toBeNull();
  });

  it('refuses a principal without document:write', async () => {
    const attachmentId = await ingested();
    await expect(tenant.as((db) => fileAttachment(db, tenant.context,
      adviser(['case:read']), {
        attachmentId, caseId: joanneCase, documentType: 'payslip',
      }))).rejects.toThrow();
  });
});
