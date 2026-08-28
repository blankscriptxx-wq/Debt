import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import { matchIdentifier, normaliseIdentifier, displayIdentifier } from './matching.js';
import { sendCommunication } from './send.js';
import type { ChannelAdapter } from './channels.js';

/**
 * Conversations: the thread an adviser works in.
 *
 * A message log answers "what was said". An inbox answers "what is owed, by
 * whom, and to whom" — which is the question a shared mailbox exists to settle.
 * The difference is ownership and unread state, and both live here.
 *
 * Unread is a property of the conversation, not of each adviser. In a shared
 * inbox, per-person unread counts tell nobody whether the *client* has been
 * answered, which is the only thing that matters to the client.
 */

export class ConversationError extends Error {}

export interface InboundMessage {
  /** The firm's own number or address that received it. */
  channelAccountId: string;
  channel: 'whatsapp' | 'sms' | 'email' | 'portal';
  from: string;
  body: string | null;
  providerMessageId: string;
  occurredAt?: Date;
  counterpartyLabel?: string | null;
  attachments?: readonly {
    providerMediaId: string;
    filename?: string | null;
    contentType?: string | null;
    byteSize?: number | null;
    sha256?: string | null;
    mediaKind?: string | null;
    /** When the provider stops serving it. WhatsApp webhooks give ~7 days. */
    expiresAt?: Date | null;
  }[];
}

export interface ReceivedMessage {
  conversationId: string;
  communicationId: string;
  attachmentIds: string[];
  matched: boolean;
  clientId: string | null;
  /** Why it was or was not matched, for the adviser to read. */
  matchReason: string;
}

/**
 * Records an inbound message, opening or reusing its conversation.
 *
 * The tenant is already fixed by the caller having resolved the channel account,
 * which is tenant-scoped. Nothing about the sender chooses a tenant, and that is
 * what makes two firms holding the same client's number safe rather than a
 * collision waiting to happen.
 */
export async function receiveInbound(
  db: Database, ctx: TenantContext, message: InboundMessage,
): Promise<ReceivedMessage> {
  const identifier = normaliseIdentifier(message.channel, message.from);
  const occurredAt = message.occurredAt ?? new Date();

  const account = await db.execute<{ id: string; queue: string | null }>(sql`
    SELECT id, queue FROM channel_accounts
     WHERE id = ${message.channelAccountId} AND status = 'active'`);
  if (!account.rows[0]) {
    throw new ConversationError('That channel account is not active on this firm.');
  }

  const match = await matchIdentifier(db, message.channel, identifier);

  // One open thread per person per number: a second message is the same
  // conversation, not another one to triage.
  const existing = await db.execute<{ id: string; client_id: string | null }>(sql`
    SELECT id, client_id FROM conversations
     WHERE channel_account_id = ${message.channelAccountId}
       AND counterparty_identifier = ${identifier}`);

  let conversationId: string;
  if (existing.rows[0]) {
    conversationId = existing.rows[0].id;
    await db.execute(sql`
      UPDATE conversations
         SET status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
             snoozed_until = NULL,
             last_inbound_at = ${occurredAt},
             last_message_at = ${occurredAt},
             last_message_preview = ${preview(message)},
             first_unread_at = coalesce(first_unread_at, ${occurredAt}),
             reply_due_at = coalesce(reply_due_at, ${occurredAt})
       WHERE id = ${conversationId}`);
  } else {
    const created = await db.execute<{ id: string }>(sql`
      INSERT INTO conversations
        (channel_account_id, channel, counterparty_identifier, counterparty_label,
         client_id, matched_by, matched_at, queue, status,
         last_inbound_at, last_message_at, last_message_preview,
         first_unread_at, reply_due_at)
      VALUES (${message.channelAccountId}, ${message.channel}, ${identifier},
              ${message.counterpartyLabel ?? displayIdentifier(message.channel, identifier)},
              ${match.confidence === 'verified' ? match.clientId : null},
              ${match.confidence === 'verified' ? 'verified-identity' : null},
              ${match.confidence === 'verified' ? occurredAt : null},
              ${account.rows[0].queue}, 'open',
              ${occurredAt}, ${occurredAt}, ${preview(message)},
              ${occurredAt}, ${occurredAt})
      RETURNING id`);
    conversationId = created.rows[0]!.id;
  }

  const clientId = existing.rows[0]?.client_id
    ?? (match.confidence === 'verified' ? match.clientId : null);

  // The case, if the client has exactly one open. More than one is ambiguous
  // and is left to the adviser rather than guessed.
  const caseId = clientId ? await soleOpenCase(db, clientId) : null;

  const communication = await db.execute<{ id: string }>(sql`
    INSERT INTO communications
      (conversation_id, case_id, client_id, channel, direction, counterparty_type,
       counterparty_label, body, status, provider_message_id, sent_by_type,
       simulated, occurred_at)
    VALUES (${conversationId}, ${caseId}, ${clientId}, ${message.channel}, 'inbound',
            ${clientId ? 'client' : 'third-party'},
            ${message.counterpartyLabel ?? displayIdentifier(message.channel, identifier)},
            ${message.body}, 'received', ${message.providerMessageId}, 'client',
            true, ${occurredAt})
    RETURNING id`);
  const communicationId = communication.rows[0]!.id;

  // Attachment rows are written now and the bytes fetched immediately after.
  // A WhatsApp media id in a webhook stops working after about seven days, so
  // fetching when an adviser asks for it is a design that loses files.
  const attachmentIds: string[] = [];
  for (const a of message.attachments ?? []) {
    const row = await db.execute<{ id: string }>(sql`
      INSERT INTO message_attachments
        (communication_id, conversation_id, provider_media_id, provider_expires_at,
         filename, content_type, byte_size, provider_sha256, media_kind, ingest_status)
      VALUES (${communicationId}, ${conversationId}, ${a.providerMediaId},
              ${a.expiresAt ?? null}, ${a.filename ?? null}, ${a.contentType ?? null},
              ${a.byteSize ?? null}, ${a.sha256 ?? null}, ${a.mediaKind ?? 'document'},
              'pending')
      RETURNING id`);
    attachmentIds.push(row.rows[0]!.id);
  }

  await recordAudit(db, ctx, {
    action: 'comms.message.received',
    resourceType: 'communication', resourceId: communicationId,
    caseId,
    reason: match.confidence === 'verified'
      ? 'Inbound message matched to a confirmed identity'
      : `Inbound message held for matching: ${match.reason}`,
    source: 'integration',
    after: {
      channel: message.channel, conversationId,
      matched: match.confidence === 'verified',
      attachments: attachmentIds.length,
    },
  });

  return {
    conversationId, communicationId, attachmentIds,
    matched: match.confidence === 'verified',
    clientId,
    matchReason: match.reason,
  };
}

/**
 * Links a conversation to a client, and remembers the answer.
 *
 * Confirming here is what creates the verified identity, so the same number is
 * recognised without asking again. That is the whole reason the conservative
 * rule in `matching.ts` is affordable: it costs one decision, once.
 */
export async function linkConversation(
  db: Database, ctx: TenantContext, principal: Principal,
  input: { conversationId: string; clientId: string; caseId?: string | null },
): Promise<void> {
  requirePermission(principal, 'case:write', { tenantId: ctx.tenantId });

  const conversation = await db.execute<{
    id: string; channel: string; counterparty_identifier: string; client_id: string | null;
  }>(sql`
    SELECT id, channel, counterparty_identifier, client_id
      FROM conversations WHERE id = ${input.conversationId}`);
  const row = conversation.rows[0];
  if (!row) throw new ConversationError('No such conversation.');

  const caseId = input.caseId ?? await soleOpenCase(db, input.clientId);

  await db.execute(sql`
    UPDATE conversations
       SET client_id = ${input.clientId}, case_id = ${caseId},
           matched_by = 'adviser', matched_at = now(),
           matched_by_user = ${ctx.userId ?? null}
     WHERE id = ${input.conversationId}`);

  // Messages already in the thread belong to the client too. Leaving them
  // unattached would mean the client's own timeline started mid-conversation.
  await db.execute(sql`
    UPDATE communications
       SET client_id = ${input.clientId}, case_id = ${caseId},
           counterparty_type = 'client'
     WHERE conversation_id = ${input.conversationId}`);

  await db.execute(sql`
    INSERT INTO channel_identities
      (client_id, channel, identifier, verified_at, verified_by, source)
    VALUES (${input.clientId}, ${row.channel}, ${row.counterparty_identifier},
            now(), ${ctx.userId ?? null}, 'adviser')
    ON CONFLICT (tenant_id, channel, identifier, client_id)
    DO UPDATE SET verified_at = now(), verified_by = ${ctx.userId ?? null}`);

  await recordAudit(db, ctx, {
    action: 'comms.conversation.linked',
    resourceType: 'conversation', resourceId: input.conversationId,
    caseId,
    reason: 'Conversation identified and linked to a client by an adviser',
    source: 'console',
    before: { clientId: row.client_id },
    after: { clientId: input.clientId, caseId, identifier: row.counterparty_identifier },
  });
}

export async function assignConversation(
  db: Database, ctx: TenantContext, principal: Principal,
  input: { conversationId: string; toUserId: string | null; note?: string },
): Promise<void> {
  requirePermission(principal, 'case:write', { tenantId: ctx.tenantId });

  const before = await db.execute<{ assigned_to: string | null }>(sql`
    SELECT assigned_to FROM conversations WHERE id = ${input.conversationId}`);
  if (!before.rows[0]) throw new ConversationError('No such conversation.');

  await db.execute(sql`
    UPDATE conversations
       SET assigned_to = ${input.toUserId},
           assigned_at = ${input.toUserId ? sql`now()` : sql`NULL`}
     WHERE id = ${input.conversationId}`);

  await recordAudit(db, ctx, {
    action: input.toUserId ? 'comms.conversation.assigned' : 'comms.conversation.unassigned',
    resourceType: 'conversation', resourceId: input.conversationId,
    reason: input.note ?? (input.toUserId ? 'Conversation assigned' : 'Returned to the queue'),
    source: 'console',
    before: { assignedTo: before.rows[0].assigned_to },
    after: { assignedTo: input.toUserId },
  });
}

export async function setConversationStatus(
  db: Database, ctx: TenantContext, principal: Principal,
  input: {
    conversationId: string;
    status: 'open' | 'pending' | 'snoozed' | 'closed';
    snoozedUntil?: Date | null;
  },
): Promise<void> {
  requirePermission(principal, 'case:write', { tenantId: ctx.tenantId });

  if (input.status === 'snoozed' && !input.snoozedUntil) {
    throw new ConversationError('Snoozing needs a time to come back to it.');
  }

  await db.execute(sql`
    UPDATE conversations
       SET status = ${input.status},
           snoozed_until = ${input.status === 'snoozed' ? input.snoozedUntil ?? null : null},
           closed_at = ${input.status === 'closed' ? sql`now()` : sql`NULL`},
           closed_by = ${input.status === 'closed' ? (ctx.userId ?? null) : null},
           -- Closing answers the thread. Leaving a reply owed on a closed
           -- conversation would keep it red in a queue nobody is watching.
           reply_due_at = ${input.status === 'closed' ? sql`NULL` : sql`reply_due_at`},
           first_unread_at = ${input.status === 'closed' ? sql`NULL` : sql`first_unread_at`}
     WHERE id = ${input.conversationId}`);

  await recordAudit(db, ctx, {
    action: 'comms.conversation.status.changed',
    resourceType: 'conversation', resourceId: input.conversationId,
    reason: `Conversation marked ${input.status}`,
    source: 'console',
    after: { status: input.status },
  });
}

/** Marks the thread read. Read is "somebody has looked", not "somebody replied". */
export async function markRead(
  db: Database, conversationId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE conversations SET first_unread_at = NULL WHERE id = ${conversationId}`);
}

function preview(message: InboundMessage): string {
  const text = (message.body ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 140);
  const count = message.attachments?.length ?? 0;
  return count ? `${count} attachment${count === 1 ? '' : 's'}` : 'Message';
}

/**
 * The client's only open case, or nothing.
 *
 * A client with two open cases — a moratorium alongside a DMP is ordinary —
 * has no obvious home for a message, and picking one silently files a
 * conversation against the wrong matter. The adviser chooses.
 */
async function soleOpenCase(db: Database, clientId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM cases WHERE client_id = ${clientId} AND status = 'open' LIMIT 2`);
  return rows.rows.length === 1 ? rows.rows[0]!.id : null;
}

/**
 * Replying in a thread, or adding a note to it.
 *
 * Two different things wearing one button. A reply is a message to a person and
 * goes through `sendCommunication`, which enforces the client's contact
 * preferences and consent — bypassing that to save a join would mean the inbox
 * became the one route that could message somebody who asked not to be
 * messaged. A note is not a communication at all: nobody outside the firm ever
 * sees it, it needs no consent, and it can be left on a conversation nobody has
 * identified yet, which is exactly when an adviser most wants to write down
 * what they think is going on.
 */
export async function replyInConversation(
  db: Database, ctx: TenantContext, principal: Principal,
  input: {
    conversationId: string;
    body: string;
    internal: boolean;
    /** Required for a reply; unnecessary for a note. */
    adapter?: ChannelAdapter;
  },
): Promise<{ communicationId: string; delivered: boolean }> {
  const body = input.body.trim();
  if (!body) throw new ConversationError('There is nothing to send.');

  const rows = await db.execute<{
    channel: string; client_id: string | null; case_id: string | null;
    counterparty_identifier: string; counterparty_label: string | null;
  }>(sql`
    SELECT channel, client_id, case_id, counterparty_identifier, counterparty_label
      FROM conversations WHERE id = ${input.conversationId}`);
  const conversation = rows.rows[0];
  if (!conversation) throw new ConversationError('No such conversation.');

  if (input.internal) {
    requirePermission(principal, 'case:write', { tenantId: ctx.tenantId });
    const note = await db.execute<{ id: string }>(sql`
      INSERT INTO communications
        (conversation_id, case_id, client_id, channel, direction, counterparty_type,
         counterparty_label, body, status, sent_by, sent_by_type, simulated)
      VALUES (${input.conversationId}, ${conversation.case_id}, ${conversation.client_id},
              'internal-note', 'internal', 'internal',
              ${conversation.counterparty_label}, ${body}, 'sent',
              ${ctx.userId ?? null}, 'user', false)
      RETURNING id`);

    await touch(db, input.conversationId, body, false);
    await recordAudit(db, ctx, {
      action: 'comms.note.added',
      resourceType: 'communication', resourceId: note.rows[0]!.id,
      caseId: conversation.case_id,
      reason: 'Internal note added to a conversation',
      source: 'console',
    });
    return { communicationId: note.rows[0]!.id, delivered: false };
  }

  if (!conversation.client_id) {
    throw new ConversationError(
      'Identify who this is before replying. Until then only an internal note can be added.');
  }
  if (!input.adapter) throw new ConversationError('No channel adapter for this conversation.');

  const sent = await sendCommunication(db, ctx, principal, input.adapter, {
    caseId: conversation.case_id,
    clientId: conversation.client_id,
    channel: conversation.channel as 'whatsapp',
    body,
  });

  await attachToConversation(db, input.conversationId, sent.communicationId, body);

  return { communicationId: sent.communicationId, delivered: sent.delivered };
}

/**
 * Puts an already-sent message into a thread.
 *
 * `sendCommunication` knows about clients and cases and deliberately not about
 * conversations, so that a message sent from a case file, a workflow or the API
 * is recorded identically to one sent from the inbox. Anything sent *from* a
 * thread stitches itself in here — and it must, because an adviser who sends a
 * letter and cannot see it in the conversation has no way to know it went.
 */
export async function attachToConversation(
  db: Database, conversationId: string, communicationId: string, preview: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE communications SET conversation_id = ${conversationId}
     WHERE id = ${communicationId}`);
  await touch(db, conversationId, preview, true);
}

/**
 * Marks the thread as answered.
 *
 * Replying clears what is owed, and an internal note does not: writing a note to
 * a colleague is not answering the client, and a queue that thinks otherwise
 * quietly loses people.
 */
async function touch(
  db: Database, conversationId: string, body: string, answered: boolean,
): Promise<void> {
  await db.execute(sql`
    UPDATE conversations
       SET last_message_at = now(),
           last_message_preview = ${body.replace(/\s+/g, ' ').slice(0, 140)},
           last_outbound_at = ${answered ? sql`now()` : sql`last_outbound_at`},
           reply_due_at = ${answered ? sql`NULL` : sql`reply_due_at`},
           first_unread_at = NULL
     WHERE id = ${conversationId}`);
}
