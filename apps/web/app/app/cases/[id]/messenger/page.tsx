import { redirect } from 'next/navigation';
import { sql } from '@solvenda/db';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader } from '@/lib/console/case-file';
import { recordAudit } from '@solvenda/audit';
import { requirePermission } from '@solvenda/auth';
import {
  Badge, Card, EmptyState, Field, Form, Grid, SimulatedNotice, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const NOTE_TYPES = ['general', 'call', 'vulnerability', 'complaint', 'compliance', 'handover'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Correspondence and internal notes.
 *
 * One timeline, two audiences. Anything on a client channel is correspondence
 * the client can see in their portal; an internal note never leaves the firm
 * and is excluded from the client view — a property the client portal's own
 * browser suite asserts, because getting it wrong discloses an adviser's
 * private assessment to the person it is about.
 *
 * Notes are stored as communications on the `internal-note` channel rather than
 * in a separate table, so the case timeline stays a single ordered account of
 * everything that happened.
 */
export default async function MessengerTab({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { saved, error } = await searchParams;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');

  const [entries, templates] = await Promise.all([
    query(session, async (db) => {
      const res = await db.execute<Record<string, string | null>>(sql`
        SELECT c.id, c.channel, c.direction, c.subject, c.body, c.occurred_at::text,
               c.status, u.full_name AS author
          FROM communications c
          LEFT JOIN users u ON u.id = c.sent_by
         WHERE c.case_id = ${id}
         ORDER BY c.occurred_at DESC LIMIT 100`);
      return res.rows;
    }),
    query(session, async (db) => {
      const res = await db.execute<Record<string, string>>(sql`
        SELECT key, name, body FROM communication_templates
         WHERE channel = 'internal-note' AND status = 'active'
         ORDER BY name`);
      return res.rows;
    }),
  ]);

  const notes = entries.filter((e) => e['channel'] === 'internal-note');
  const messages = entries.filter((e) => e['channel'] !== 'internal-note');

  // The same conversations the inbox works, linked rather than duplicated: an
  // adviser in the case file should be able to reach the thread, and the two
  // views must never be able to disagree about what was said.
  const conversations = await query(session, async (db) => {
    const r = await db.execute<Record<string, string | null>>(sql`
      SELECT c.id, c.channel, c.counterparty_label, c.counterparty_identifier,
             c.last_message_preview,
             (SELECT count(*) FROM message_attachments a
               JOIN documents d ON d.id = a.document_id
              WHERE a.conversation_id = c.id AND d.status = 'unfiled')::text AS unfiled
        FROM conversations c
       WHERE c.case_id = ${id} AND c.status <> 'closed'
       ORDER BY c.last_message_at DESC NULLS LAST`);
    return r.rows;
  });
  const unanswered = messages.filter((m) => m['direction'] === 'outbound').length
    - messages.filter((m) => m['direction'] === 'inbound').length;

  async function addNote(formData: FormData) {
    'use server';
    const active = await requireSession();
    const body = String(formData.get('body') ?? '').trim();
    if (!body) {
      redirect(`/app/cases/${id}/messenger?error=${encodeURIComponent('A note needs some content.')}`);
    }
    const noteType = String(formData.get('noteType') ?? 'general');

    await query(active, async (db) => {
      requirePermission(active.principal, 'case:write');
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO communications
          (case_id, client_id, channel, direction, counterparty_type, subject, body,
           status, sent_by, sent_by_type, simulated, occurred_at)
        VALUES (${header!.caseId}, ${header!.clientId}, 'internal-note', 'internal',
                'internal', ${sentence(noteType)}, ${body}, 'sent',
                ${active.user.id}, 'user',
                -- Not simulated: an internal note is genuinely recorded here,
                -- unlike an outbound message, which would go through an adapter
                -- that has no live provider behind it.
                false, now())
        RETURNING id`);
      await recordAudit(db, active.context, {
        action: 'comms.note.added',
        resourceType: 'communication',
        resourceId: res.rows[0]!.id,
        caseId: header!.caseId,
        reason: `Internal note (${noteType})`,
        source: 'console',
        after: { channel: 'internal-note', noteType },
      });
    });
    redirect(`/app/cases/${id}/messenger?saved=1`);
  }

  return (
    <Stack gap={5}>
      <SimulatedNotice what="Outbound email, SMS and letters would go through the messaging adapters, which are sandbox simulators." />

      <Card title="Add an internal note"
            subtitle="Never shown to the client. Use correspondence for anything they should see.">
        <Form action={addNote} submitLabel="Save note"
              result={saved ? { ok: true, message: 'Note added to the timeline.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Type">
              <select className="sv-input" name="noteType" defaultValue="general">
                {NOTE_TYPES.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}
              </select>
            </Field>
            {templates.length > 0 && (
              <Field label="Templates available"
                     hint="Configured by the firm, not hard-coded.">
                <span className="sv-muted">
                  {templates.map((t) => t['name']).join(', ')}
                </span>
              </Field>
            )}
          </Grid>
          <Field label="Note" required>
            <textarea className="sv-input" name="body" rows={4} required
                      placeholder="What happened, and what it means for the case." />
          </Field>
        </Form>
      </Card>

      {conversations.length > 0 && (
        <Card title="Conversations"
              subtitle="Live threads on this case. The inbox and the case file read the same messages, so they cannot disagree.">
          <ul className="sv-list">
            {conversations.map((c) => (
              <li key={c['id']!}>
                <a href={`/app/inbox?c=${c['id']}`}>
                  {c['channel']} with {c['counterparty_label'] ?? c['counterparty_identifier']}
                </a>
                {' — '}
                <span className="sv-muted">
                  {c['unfiled'] !== '0'
                    ? `${c['unfiled']} attachment${c['unfiled'] === '1' ? '' : 's'} waiting to be filed`
                    : c['last_message_preview'] ?? 'no messages yet'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Correspondence"
            subtitle="Everything sent to or received from the client, and from creditors.">
        {messages.length === 0 ? (
          <EmptyState title="No correspondence yet." />
        ) : (
          <ul className="sv-thread">
            {messages.map((m) => (
              <li key={m['id']} className={`sv-thread__item sv-thread__item--${m['direction']}`}>
                <div className="sv-thread__meta">
                  <Badge>{m['channel']}</Badge>
                  <span>{sentence(m['direction'] ?? '')}</span>
                  <span className="sv-muted">
                    {new Date(m['occurred_at']!).toLocaleString('en-GB',
                      { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                {m['subject'] && <strong>{m['subject']}</strong>}
                <p>{m['body']}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Internal notes" subtitle="Visible to the firm only.">
        {notes.length === 0 ? (
          <EmptyState title="No notes on this case." />
        ) : (
          <ul className="sv-thread">
            {notes.map((n) => (
              <li key={n['id']} className="sv-thread__item sv-thread__item--internal">
                <div className="sv-thread__meta">
                  <Badge tone="attention">{n['subject'] ?? 'Note'}</Badge>
                  <span className="sv-muted">
                    {n['author'] ?? 'Unknown'} ·{' '}
                    {new Date(n['occurred_at']!).toLocaleString('en-GB',
                      { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </div>
                <p>{n['body']}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SummaryBar figures={[
        { label: 'Correspondence', value: messages.length },
        { label: 'Internal notes', value: notes.length },
        {
          label: 'Awaiting a reply', value: Math.max(0, unanswered),
          tone: unanswered > 2 ? 'critical' : 'neutral',
          detail: unanswered > 2 ? 'Disengagement worth chasing' : undefined,
        },
      ]} />
    </Stack>
  );
}
