import { sql, type Database } from '@solvenda/db';
import { displayIdentifier, matchIdentifier, type MatchResult } from '@solvenda/comms';
import { serviceWindowOpenUntil } from '@solvenda/integrations';

/**
 * Reads for the inbox.
 *
 * The list answers "what is owed and by whom", the thread answers "what was
 * said", and the context pane answers "who is this and what does their case
 * still need". Three questions, three queries, one screen — the point being
 * that an adviser stops navigating between pages to answer them.
 */

export type InboxFilter = 'mine' | 'unassigned' | 'unmatched' | 'all';

export interface ConversationSummary {
  id: string;
  channel: string;
  counterpartyLabel: string;
  counterpartyIdentifier: string;
  clientId: string | null;
  clientName: string | null;
  caseId: string | null;
  caseReference: string | null;
  status: string;
  assignedTo: string | null;
  assignedName: string | null;
  unread: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  replyDueAt: string | null;
  attachmentsWaiting: number;
  /** Free-form marks on the thread. Carried whole, so the next feature can use it. */
  tags: string[];
}

export async function loadInbox(
  db: Database, filter: InboxFilter, userId: string,
): Promise<ConversationSummary[]> {
  const where =
    filter === 'mine' ? sql`AND c.assigned_to = ${userId} AND c.status <> 'closed'`
    : filter === 'unassigned' ? sql`AND c.assigned_to IS NULL AND c.status <> 'closed'`
    : filter === 'unmatched' ? sql`AND c.client_id IS NULL AND c.status <> 'closed'`
    : sql`AND c.status <> 'closed'`;

  const res = await db.execute<Record<string, string | null> & { tags: string[] }>(sql`
    SELECT c.id, c.channel, c.counterparty_label, c.counterparty_identifier,
           c.client_id, c.case_id, c.status, c.assigned_to, c.tags,
           c.first_unread_at::text, c.last_message_at::text, c.last_message_preview,
           c.reply_due_at::text,
           cl.first_name || ' ' || cl.last_name AS client_name,
           k.reference AS case_reference,
           u.full_name AS assigned_name,
           (SELECT count(*) FROM message_attachments a
             WHERE a.conversation_id = c.id AND a.ingest_status = 'stored'
               AND a.document_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM documents d
                            WHERE d.id = a.document_id AND d.status = 'unfiled')
           )::text AS attachments_waiting
      FROM conversations c
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN cases k ON k.id = c.case_id
      LEFT JOIN users u ON u.id = c.assigned_to
     WHERE true ${where}
     ORDER BY c.first_unread_at IS NULL, c.last_message_at DESC NULLS LAST
     LIMIT 100`);

  return res.rows.map((r) => ({
    id: r['id']!,
    channel: r['channel']!,
    counterpartyLabel: r['counterparty_label']
      ?? displayIdentifier(r['channel']!, r['counterparty_identifier']!),
    counterpartyIdentifier: r['counterparty_identifier']!,
    clientId: r['client_id'] ?? null,
    clientName: r['client_name'] ?? null,
    caseId: r['case_id'] ?? null,
    caseReference: r['case_reference'] ?? null,
    status: r['status']!,
    assignedTo: r['assigned_to'] ?? null,
    assignedName: r['assigned_name'] ?? null,
    unread: (r['first_unread_at'] ?? null) !== null,
    lastMessageAt: r['last_message_at'] ?? null,
    lastMessagePreview: r['last_message_preview'] ?? null,
    replyDueAt: r['reply_due_at'] ?? null,
    attachmentsWaiting: Number(r['attachments_waiting'] ?? '0'),
    tags: r.tags ?? [],
  }));
}

export interface ConversationMessage {
  id: string;
  direction: string;
  body: string | null;
  status: string;
  occurredAt: string;
  sentByName: string | null;
  sentByType: string;
  channel: string;
  simulated: boolean;
  attachments: {
    id: string;
    filename: string | null;
    contentType: string | null;
    byteSize: number | null;
    mediaKind: string | null;
    ingestStatus: string;
    ingestError: string | null;
    documentId: string | null;
    /** Null once it has been filed onto a case. */
    documentStatus: string | null;
  }[];
}

export interface ConversationDetail {
  id: string;
  channel: string;
  counterpartyLabel: string;
  counterpartyIdentifier: string;
  clientId: string | null;
  clientName: string | null;
  caseId: string | null;
  caseReference: string | null;
  status: string;
  assignedTo: string | null;
  assignedName: string | null;
  accountName: string;
  simulated: boolean;
  /** Null when the 24-hour window has closed, which changes what can be sent. */
  windowOpenUntil: string | null;
  lastInboundAt: string | null;
  messages: ConversationMessage[];
  /** Only computed when the conversation has not been linked yet. */
  match: MatchResult | null;
}

export async function loadConversation(
  db: Database, conversationId: string,
): Promise<ConversationDetail | null> {
  const head = await db.execute<Record<string, string | null>>(sql`
    SELECT c.id, c.channel, c.counterparty_label, c.counterparty_identifier,
           c.client_id, c.case_id, c.status, c.assigned_to, c.last_inbound_at::text,
           cl.first_name || ' ' || cl.last_name AS client_name,
           k.reference AS case_reference,
           u.full_name AS assigned_name,
           a.display_name AS account_name, a.simulated::text AS simulated
      FROM conversations c
      JOIN channel_accounts a ON a.id = c.channel_account_id
      LEFT JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN cases k ON k.id = c.case_id
      LEFT JOIN users u ON u.id = c.assigned_to
     WHERE c.id = ${conversationId}`);
  const row = head.rows[0];
  if (!row) return null;

  const messages = await db.execute<Record<string, string | null>>(sql`
    SELECT m.id, m.direction, m.body, m.status, m.occurred_at::text, m.channel,
           m.sent_by_type, m.simulated::text AS simulated, u.full_name AS sent_by_name
      FROM communications m
      LEFT JOIN users u ON u.id = m.sent_by
     WHERE m.conversation_id = ${conversationId}
     ORDER BY m.occurred_at`);

  const attachments = await db.execute<Record<string, string | null>>(sql`
    SELECT a.id, a.communication_id, a.filename, a.content_type, a.byte_size::text,
           a.media_kind, a.ingest_status, a.ingest_error, a.document_id,
           d.status AS document_status
      FROM message_attachments a
      LEFT JOIN documents d ON d.id = a.document_id
     WHERE a.conversation_id = ${conversationId}
     ORDER BY a.created_at`);

  const byMessage = new Map<string, ConversationMessage['attachments']>();
  for (const a of attachments.rows) {
    const list = byMessage.get(a['communication_id']!) ?? [];
    list.push({
      id: a['id']!,
      filename: a['filename'] ?? null,
      contentType: a['content_type'] ?? null,
      byteSize: a['byte_size'] == null ? null : Number(a['byte_size']),
      mediaKind: a['media_kind'] ?? null,
      ingestStatus: a['ingest_status']!,
      ingestError: a['ingest_error'] ?? null,
      documentId: a['document_id'] ?? null,
      documentStatus: a['document_status'] ?? null,
    });
    byMessage.set(a['communication_id']!, list);
  }

  const lastInboundAt = row['last_inbound_at'] ?? null;
  const windowOpenUntil = row['channel'] === 'whatsapp'
    ? serviceWindowOpenUntil(lastInboundAt ? new Date(lastInboundAt) : null)
    : null;

  return {
    id: row['id']!,
    channel: row['channel']!,
    counterpartyLabel: row['counterparty_label']
      ?? displayIdentifier(row['channel']!, row['counterparty_identifier']!),
    counterpartyIdentifier: row['counterparty_identifier']!,
    clientId: row['client_id'] ?? null,
    clientName: row['client_name'] ?? null,
    caseId: row['case_id'] ?? null,
    caseReference: row['case_reference'] ?? null,
    status: row['status']!,
    assignedTo: row['assigned_to'] ?? null,
    assignedName: row['assigned_name'] ?? null,
    accountName: row['account_name']!,
    simulated: row['simulated'] === 'true',
    windowOpenUntil: windowOpenUntil ? windowOpenUntil.toISOString() : null,
    lastInboundAt,
    messages: messages.rows.map((m) => ({
      id: m['id']!,
      direction: m['direction']!,
      body: m['body'] ?? null,
      status: m['status']!,
      occurredAt: m['occurred_at']!,
      sentByName: m['sent_by_name'] ?? null,
      sentByType: m['sent_by_type']!,
      channel: m['channel']!,
      simulated: m['simulated'] === 'true',
      attachments: byMessage.get(m['id']!) ?? [],
    })),
    // Only worth computing for a conversation nobody has identified yet.
    match: row['client_id']
      ? null
      : await matchIdentifier(db, row['channel']!, row['counterparty_identifier']!),
  };
}

/** Counts for the filter chips, so an adviser can see where the work is. */
export async function loadInboxCounts(
  db: Database, userId: string,
): Promise<Record<InboxFilter, number>> {
  const res = await db.execute<Record<string, string>>(sql`
    SELECT
      count(*) FILTER (WHERE assigned_to = ${userId})::text AS mine,
      count(*) FILTER (WHERE assigned_to IS NULL)::text AS unassigned,
      count(*) FILTER (WHERE client_id IS NULL)::text AS unmatched,
      count(*)::text AS all
    FROM conversations WHERE status <> 'closed'`);
  const r = res.rows[0]!;
  return {
    mine: Number(r['mine']), unassigned: Number(r['unassigned']),
    unmatched: Number(r['unmatched']), all: Number(r['all']),
  };
}

/** Clients an adviser can pick from when identifying a conversation. */
export async function searchClients(
  db: Database, term: string,
): Promise<{ id: string; reference: string; name: string; caseId: string | null;
             caseReference: string | null }[]> {
  const like = `%${term.trim()}%`;
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT c.id, c.reference, c.first_name || ' ' || c.last_name AS name,
           k.id AS case_id, k.reference AS case_reference
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT id, reference FROM cases
         WHERE client_id = c.id AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1) k ON true
     WHERE ${term.trim() === ''}
        OR c.reference ILIKE ${like}
        OR (c.first_name || ' ' || c.last_name) ILIKE ${like}
        OR coalesce(c.phone_mobile, '') ILIKE ${like}
     ORDER BY c.created_at DESC LIMIT 25`);
  return res.rows.map((r) => ({
    id: r['id']!, reference: r['reference']!, name: r['name']!,
    caseId: r['case_id'] ?? null, caseReference: r['case_reference'] ?? null,
  }));
}
