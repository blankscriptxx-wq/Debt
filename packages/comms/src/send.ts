import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import { scrub } from '@solvenda/ai';
import type { ChannelAdapter, OutboundMessage } from './channels.js';
import { resolveSignature, applySignature } from './signature.js';

export class CommunicationBlockedError extends Error {
  constructor(message: string, public readonly code: 'no-consent' | 'channel-declined' | 'no-address' | 'template-incomplete') {
    super(message);
    this.name = 'CommunicationBlockedError';
  }
}

export interface SendInput {
  caseId?: string | null;
  clientId: string;
  channel: 'email' | 'sms' | 'whatsapp' | 'letter' | 'portal';
  templateKey?: string;
  subject?: string | null;
  body: string;
  counterpartyType?: 'client' | 'creditor' | 'introducer' | 'third-party';
  /** Bypasses preference checks for a statutory communication. Recorded. */
  statutory?: boolean;
  statutoryBasis?: string;
  /**
   * Set when the body already carries its signature — a rendered template,
   * where the signature is a variable rather than something appended. Never a
   * way to send unsigned: a template that does not declare the signature
   * variable cannot be activated in the first place.
   */
  signed?: boolean;
}

/**
 * Sends a message and puts it on the case timeline.
 *
 * Channel preferences are enforced here rather than left to whoever composes
 * the message. A client who has asked not to be texted is not texted, and the
 * only way past that is a statutory communication with a stated basis, which is
 * recorded as such. This is one of the places a firm gets complained about, and
 * "the adviser should have checked" is not a control.
 */
export async function sendCommunication(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  adapter: ChannelAdapter,
  input: SendInput,
): Promise<{ communicationId: string; delivered: boolean; simulated: boolean }> {
  requirePermission(principal, 'comms:send', { tenantId: ctx.tenantId });

  const client = await db.execute<{
    email: string | null; phone_mobile: string | null;
    address_line1: string | null; address_postcode: string | null;
    contact_preferences: Record<string, unknown>;
    communication_adjustments: Record<string, unknown>;
    first_name: string;
  }>(sql`
    SELECT email, phone_mobile, address_line1, address_postcode,
           contact_preferences, communication_adjustments, first_name
      FROM clients WHERE id = ${input.clientId}`);

  const record = client.rows[0];
  if (!record) throw new CommunicationBlockedError('No such client', 'no-address');

  const preferences = record.contact_preferences ?? {};
  const declined = Array.isArray(preferences['declinedChannels'])
    ? (preferences['declinedChannels'] as string[])
    : [];

  if (declined.includes(input.channel) && !input.statutory) {
    throw new CommunicationBlockedError(
      `${record.first_name} has asked not to be contacted by ${input.channel}. ` +
        `A statutory communication may override this, with a stated basis.`,
      'channel-declined',
    );
  }
  if (input.statutory && !input.statutoryBasis?.trim()) {
    throw new CommunicationBlockedError(
      'A statutory communication overriding a client preference must state its basis',
      'template-incomplete',
    );
  }

  const to = recipientFor(input.channel, record);
  if (!to) {
    throw new CommunicationBlockedError(
      `No ${input.channel} address is recorded for this client`, 'no-address');
  }

  const unresolved = input.body.match(/\{\{\s*[\w.]+\s*\}\}/g);
  if (unresolved) {
    throw new CommunicationBlockedError(
      `The message still contains unresolved placeholders: ${unresolved.join(', ')}`,
      'template-incomplete',
    );
  }

  // Signed here rather than by whoever composed it, which is what makes the
  // signature worth anything: the name comes from the users table by the
  // authenticated id, so nobody can sign as somebody else, and no code path
  // above this one can send a client an unattributable message.
  //
  // `signed` is the body already carrying the signature — a template renders it
  // into a variable before it arrives, because an approved WhatsApp template
  // cannot be appended to without ceasing to match what Meta approved.
  const signature = await resolveSignature(db, principal);
  const body = input.signed ? input.body : applySignature(input.body, signature);

  const message: OutboundMessage = {
    channel: input.channel, to,
    subject: input.subject ?? null, body,
  };
  const delivery = await adapter.send(message);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO communications (
      case_id, client_id, channel, direction, counterparty_type, counterparty_id,
      counterparty_label, subject, body, body_redacted, template_key, status,
      failure_reason, consent_basis, channel_permitted, sent_by, sent_by_type,
      provider, provider_message_id, simulated
    ) VALUES (
      ${input.caseId ?? null}, ${input.clientId}, ${input.channel}, 'outbound',
      ${input.counterpartyType ?? 'client'}, ${input.clientId}, ${to},
      ${input.subject ?? null}, ${body}, ${scrub(body).text},
      ${input.templateKey ?? null},
      ${delivery.status === 'failed' ? 'failed' : delivery.status},
      ${delivery.failureReason ?? null},
      ${input.statutory ? `statutory: ${input.statutoryBasis}` : 'client preference'},
      ${!declined.includes(input.channel)},
      ${principal.kind === 'user' ? principal.userId : null},
      ${principal.kind === 'user' ? 'user' : principal.kind === 'workflow' ? 'workflow' : 'system'},
      ${adapter.providerName}, ${delivery.providerMessageId || null}, ${delivery.simulated}
    ) RETURNING id`);

  const communicationId = inserted.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'comms.message.sent',
    resourceType: 'communication',
    resourceId: communicationId,
    caseId: input.caseId ?? null,
    source: principal.kind === 'workflow' ? `workflow:${principal.runId}` : 'console',
    reason: input.statutory ? `Statutory: ${input.statutoryBasis}` : null,
    after: {
      channel: input.channel, status: delivery.status, simulated: delivery.simulated,
      overrodePreference: input.statutory && declined.includes(input.channel),
    },
  });

  return {
    communicationId,
    delivered: delivery.status !== 'failed',
    simulated: delivery.simulated,
  };
}

function recipientFor(
  channel: SendInput['channel'],
  record: { email: string | null; phone_mobile: string | null;
            address_line1: string | null; address_postcode: string | null },
): string | null {
  switch (channel) {
    case 'email': return record.email;
    case 'sms':
    case 'whatsapp': return record.phone_mobile;
    case 'letter':
      return record.address_line1 && record.address_postcode
        ? `${record.address_line1}, ${record.address_postcode}` : null;
    case 'portal': return 'portal';
  }
}

/** Records an inbound message or a note. Both belong on the same timeline. */
export async function recordInbound(
  db: Database,
  ctx: TenantContext,
  input: {
    caseId?: string | null; clientId?: string | null;
    channel: 'email' | 'sms' | 'whatsapp' | 'call' | 'letter' | 'portal' | 'internal-note';
    body: string; subject?: string | null;
    counterpartyLabel?: string | null;
    occurredAt?: Date;
  },
): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO communications (
      case_id, client_id, channel, direction, counterparty_type, counterparty_label,
      subject, body, body_redacted, status, sent_by_type, simulated, occurred_at
    ) VALUES (
      ${input.caseId ?? null}, ${input.clientId ?? null}, ${input.channel},
      ${input.channel === 'internal-note' ? 'internal' : 'inbound'},
      ${input.channel === 'internal-note' ? 'internal' : 'client'},
      ${input.counterpartyLabel ?? null}, ${input.subject ?? null},
      ${input.body}, ${scrub(input.body).text},
      ${input.channel === 'internal-note' ? 'sent' : 'received'},
      ${input.channel === 'internal-note' ? 'user' : 'client'},
      false, ${input.occurredAt?.toISOString() ?? sql`now()`}
    ) RETURNING id`);

  await recordAudit(db, ctx, {
    action: input.channel === 'internal-note' ? 'comms.note.added' : 'comms.message.received',
    resourceType: 'communication',
    resourceId: res.rows[0]!.id,
    caseId: input.caseId ?? null,
    source: 'console',
    after: { channel: input.channel },
  });

  return res.rows[0]!.id;
}
