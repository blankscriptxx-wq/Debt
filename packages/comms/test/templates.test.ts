import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, workflowPrincipal, type Principal } from '@solvenda/auth';
import {
  applySignature, renderTemplate, resolveSignature, templateCanBeSigned, SignatureError,
  listTemplates, sendTemplate, activateTemplate, TemplateError,
  sendCommunication, defaultChannels,
} from '@solvenda/comms';

/**
 * Signatures and templates.
 *
 * The property under test throughout is that **the name on a message comes from
 * the users table by the authenticated id and from nowhere else**. A signature
 * an adviser could choose is a sign-off, not a signature, and a client deciding
 * what to do about their debts on the strength of a name is entitled to have
 * that name be true.
 */

let tenant: TestTenant;
let clientId: string;
let caseId: string;
const channels = defaultChannels();

function adviser(permissions = ['comms:send']): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(permissions), competencies: [], mfaSatisfied: true, status: 'active',
  };
}

/** The firm's own name, which every signature carries alongside the person's. */
const firm = () => `${tenant.slug} Ltd`;

async function template(over: {
  key: string; body: string; status?: string; providerStatus?: string | null;
  channel?: string; variables?: string[];
}): Promise<string> {
  return tenant.as(async (db) => {
    const r = await db.execute<{ id: string }>(sql`
      INSERT INTO communication_templates
        (key, name, channel, body, required_variables, status, provider_status,
         provider_category, provider_key)
      VALUES (${over.key}, ${over.key}, ${over.channel ?? 'whatsapp'}, ${over.body},
              string_to_array(${(over.variables ?? []).join(',')}, ','),
              ${over.status ?? 'active'}, ${over.providerStatus ?? null},
              'utility', 'sandbox-whatsapp')
      RETURNING id`);
    return r.rows[0]!.id;
  });
}

const bodyOf = (communicationId: string) => tenant.as(async (db) => {
  const r = await db.execute<{ body: string }>(sql`
    SELECT body FROM communications WHERE id = ${communicationId}`);
  return r.rows[0]!.body;
});

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('comms-templates');

  const ids = await tenant.as(async (db) => {
    const c = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, jurisdiction,
                           email, phone_mobile)
      VALUES ('CL-9001', 'Elaine', 'Doughty', 'england-wales',
              'elaine@example.test', '07700 900321')
      RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage)
      VALUES ('DMP-9001', ${c.rows[0]!.id}, 'dmp', 1, 'fact-find') RETURNING id`);
    return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id };
  });
  clientId = ids.clientId;
  caseId = ids.caseId;
});

afterAll(async () => { await closeDatabase(); });

describe('resolving who a message is from', () => {
  it('reads the name from the account, because there is nowhere else to read it', async () => {
    const signature = await tenant.as((db) => resolveSignature(db, adviser()));
    expect(signature.text).toBe(`Test Adviser, ${firm()}`);
    expect(signature.userId).toBe(tenant.userId);
    expect(signature.human).toBe(true);
  });

  it('never gives a workflow a person’s name', async () => {
    const signature = await tenant.as((db) =>
      resolveSignature(db, workflowPrincipal(tenant.id, 'run-1', ['comms:send'])));
    // A client acting on what they think an adviser told them, when no adviser
    // said it, is the failure this prevents.
    expect(signature.text).toBe(`${firm()} (automated message)`);
    expect(signature.text).not.toContain('Test Adviser');
    expect(signature.human).toBe(false);
    expect(signature.userId).toBeNull();
  });

  it('refuses rather than inventing a name for an account without one', async () => {
    const nameless = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, full_name, user_type, status)
        VALUES (${`nameless-${Date.now()}@example.test`}, '   ', 'staff', 'active')
        RETURNING id`);
      return r.rows[0]!.id;
    });

    await expect(tenant.as((db) => resolveSignature(db, { ...adviser(), userId: nameless })))
      .rejects.toThrow(SignatureError);
  });
});

describe('signing free text', () => {
  const signature = { text: 'Ruth Ellery, Northgate', userId: 'u', human: true };

  it('appends the signature', () => {
    expect(applySignature('Your appointment is Thursday.', signature))
      .toBe('Your appointment is Thursday.\n\n— Ruth Ellery, Northgate');
  });

  it('signs a message the adviser already ended with their first name', () => {
    // "Ruth" does not tell a client which Ruth, at which organisation. The
    // attribution goes on regardless of what somebody typed out of habit.
    expect(applySignature('Speak soon,\nRuth', signature))
      .toBe('Speak soon,\nRuth\n\n— Ruth Ellery, Northgate');
  });

  it('does not sign the same message twice', () => {
    const once = applySignature('Your appointment is Thursday.', signature);
    expect(applySignature(once, signature)).toBe(once);
  });
});

describe('filling a template', () => {
  const signature = { text: 'Ruth Ellery, Northgate', userId: 'u', human: true };

  it('will not let the caller choose whose name is on it', () => {
    const rendered = renderTemplate(
      'Hello {{firstName}}.\n\n{{adviser}}',
      { firstName: 'Elaine', adviser: 'Someone Else, Another Firm' },
      signature);
    expect(rendered).toContain('Ruth Ellery, Northgate');
    expect(rendered).not.toContain('Someone Else');
  });

  it('names every gap at once, not the first one', () => {
    try {
      renderTemplate('{{firstName}} owes {{amount}} on {{account}}.\n\n{{adviser}}',
        { firstName: 'Elaine' }, signature);
      expect.unreachable('a template with visible gaps should not render');
    } catch (error) {
      expect((error as Error).message).toContain('amount');
      expect((error as Error).message).toContain('account');
    }
  });

  it('recognises a template that can be signed', () => {
    expect(templateCanBeSigned('Hello.\n\n{{ adviser }}')).toBe(true);
    expect(templateCanBeSigned('Hello.\n\nNorthgate')).toBe(false);
  });
});

describe('sending free text', () => {
  it('signs it with the sender’s real name whatever they typed', async () => {
    const sent = await tenant.as((db) => sendCommunication(
      db, tenant.context, adviser(), channels.get('email')!, {
        caseId, clientId, channel: 'email', subject: 'Your appointment',
        body: 'Hello Elaine, Thursday at two works. Best, Marcus Adeyemi',
      }));

    const body = await bodyOf(sent.communicationId);
    // Marcus is still in the text, because we do not edit what somebody wrote.
    // But the message is attributed to whoever actually pressed send.
    expect(body).toContain(`— Test Adviser, ${firm()}`);
  });

  it('marks an automated message as automated', async () => {
    const sent = await tenant.as((db) => sendCommunication(
      db, tenant.context, workflowPrincipal(tenant.id, 'run-1', ['comms:send']),
      channels.get('email')!, {
        caseId, clientId, channel: 'email', subject: 'Review due',
        body: 'Your annual review is due next month.',
      }));

    const body = await bodyOf(sent.communicationId);
    expect(body).toContain('(automated message)');
    expect(body).not.toContain('Test Adviser');
  });
});

describe('the template picker', () => {
  beforeAll(async () => {
    await template({ key: 'picker-approved', providerStatus: 'approved',
      body: 'Hello {{firstName}}.\n\n{{adviser}}', variables: ['firstName', 'adviser'] });
    await template({ key: 'picker-pending', providerStatus: 'pending',
      body: 'Hello {{firstName}}.\n\n{{adviser}}', variables: ['firstName', 'adviser'] });
    await template({ key: 'picker-unsignable', providerStatus: 'approved',
      body: 'Hello {{firstName}}.', variables: ['firstName'] });
  });

  it('offers everything while the client’s window is open', async () => {
    const list = await tenant.as((db) => listTemplates(db, 'whatsapp', true));
    const byKey = new Map(list.map((t) => [t.key, t]));
    expect(byKey.get('picker-approved')!.sendable).toBe(true);
    expect(byKey.get('picker-pending')!.sendable).toBe(true);
  });

  it('says which are unavailable once it has closed, rather than failing on send', async () => {
    const list = await tenant.as((db) => listTemplates(db, 'whatsapp', false));
    const byKey = new Map(list.map((t) => [t.key, t]));
    expect(byKey.get('picker-approved')!.sendable).toBe(true);
    expect(byKey.get('picker-pending')!.sendable).toBe(false);
    expect(byKey.get('picker-pending')!.blockedBecause).toContain('not approved');
  });

  it('refuses one that cannot be signed, in or out of the window', async () => {
    for (const windowOpen of [true, false]) {
      const list = await tenant.as((db) => listTemplates(db, 'whatsapp', windowOpen));
      const unsignable = list.find((t) => t.key === 'picker-unsignable')!;
      expect(unsignable.sendable).toBe(false);
      expect(unsignable.blockedBecause).toContain('adviser');
    }
  });

  it('does not ask anybody to supply the signature', async () => {
    const list = await tenant.as((db) => listTemplates(db, 'whatsapp', true));
    const approved = list.find((t) => t.key === 'picker-approved')!;
    expect(approved.requiredVariables).toEqual(['firstName']);
  });
});

describe('sending a template', () => {
  it('puts the sender’s name in the variable the template declared', async () => {
    await template({ key: 'send-approved', providerStatus: 'approved',
      body: 'Hello {{firstName}}, your appointment is {{when}}.\n\n{{adviser}}',
      variables: ['firstName', 'when', 'adviser'] });

    const sent = await tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-approved', clientId, caseId, channel: 'whatsapp',
        variables: { firstName: 'Elaine', when: 'Thursday at 2pm' }, windowOpen: false,
      }));

    const body = await bodyOf(sent.communicationId);
    expect(body).toBe(`Hello Elaine, your appointment is Thursday at 2pm.\n\nTest Adviser, ${firm()}`);
    // Appended nothing. An approved template's body is fixed by Meta, so a
    // second signature on the end would no longer match what was approved.
    expect(body).not.toContain('—');
  });

  it('records who signed it, and that a person did', async () => {
    const sent = await tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-approved', clientId, caseId, channel: 'whatsapp',
        variables: { firstName: 'Elaine', when: 'Friday at 10am' }, windowOpen: true,
      }));

    const entry = await tenant.as(async (db) => {
      const r = await db.execute<{ after_state: Record<string, unknown> }>(sql`
        SELECT after_state FROM audit_events
         WHERE resource_id = ${sent.communicationId} AND action = 'comms.message.sent'
         ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!.after_state;
    });
    expect(entry['signedBy']).toBe(`Test Adviser, ${firm()}`);
    expect(entry['humanSigned']).toBe(true);
  });

  it('refuses an unapproved template once the window has closed', async () => {
    await template({ key: 'send-pending', providerStatus: 'pending',
      body: 'Hello {{firstName}}.\n\n{{adviser}}', variables: ['firstName', 'adviser'] });

    await expect(tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-pending', clientId, channel: 'whatsapp',
        variables: { firstName: 'Elaine' }, windowOpen: false,
      }))).rejects.toThrow(TemplateError);

    // The same template inside the window is fine, which is the whole point of
    // showing the window as a state rather than a failure.
    await expect(tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-pending', clientId, channel: 'whatsapp',
        variables: { firstName: 'Elaine' }, windowOpen: true,
      }))).resolves.toBeTruthy();
  });

  it('lands in the thread it was sent from', async () => {
    // An adviser who sends a letter and cannot see it in the conversation has
    // no way to know it went, and will send it again.
    const accountId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO channel_accounts (channel, identifier, display_name)
        VALUES ('whatsapp', '+441132960900', 'Letters line') RETURNING id`);
      return r.rows[0]!.id;
    });
    const conversationId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO conversations
          (channel_account_id, channel, counterparty_identifier, client_id, status)
        VALUES (${accountId}, 'whatsapp', '+447700900321', ${clientId}, 'open')
        RETURNING id`);
      return r.rows[0]!.id;
    });

    const sent = await tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-approved', clientId, caseId, channel: 'whatsapp',
        conversationId, variables: { firstName: 'Elaine', when: 'Monday' },
        windowOpen: true,
      }));

    const row = await tenant.as(async (db) => {
      const r = await db.execute<{ conversation_id: string | null; preview: string }>(sql`
        SELECT m.conversation_id, c.last_message_preview AS preview
          FROM communications m
          JOIN conversations c ON c.id = ${conversationId}
         WHERE m.id = ${sent.communicationId}`);
      return r.rows[0]!;
    });
    expect(row.conversation_id).toBe(conversationId);
    expect(row.preview).toContain('Monday');
  });

  it('refuses to send with a gap in it', async () => {
    await expect(tenant.as((db) => sendTemplate(
      db, tenant.context, adviser(), channels.get('whatsapp')!, {
        templateKey: 'send-approved', clientId, channel: 'whatsapp',
        variables: { firstName: 'Elaine' }, windowOpen: true,
      }))).rejects.toThrow(/when/);
  });
});

describe('activating a template', () => {
  it('will not activate one nobody could sign', async () => {
    const id = await template({ key: 'activate-unsignable', status: 'draft',
      body: 'Hello {{firstName}}, your appointment is confirmed.' });

    await expect(tenant.as((db) => activateTemplate(
      db, tenant.context, adviser(['tenant:configure']), { templateId: id })))
      .rejects.toThrow(/adviser/);

    const status = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string }>(sql`
        SELECT status FROM communication_templates WHERE id = ${id}`);
      return r.rows[0]!.status;
    });
    expect(status).toBe('draft');
  });

  it('activates one that can be', async () => {
    const id = await template({ key: 'activate-signable', status: 'draft',
      body: 'Hello {{firstName}}.\n\n{{adviser}}' });

    await tenant.as((db) => activateTemplate(
      db, tenant.context, adviser(['tenant:configure']), { templateId: id }));

    const status = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string }>(sql`
        SELECT status FROM communication_templates WHERE id = ${id}`);
      return r.rows[0]!.status;
    });
    expect(status).toBe('active');
  });
});
