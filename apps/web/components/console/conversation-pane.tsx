import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import {
  linkConversation, assignConversation, setConversationStatus, markRead,
  fileAttachment, rejectAttachment, suggestClassification, replyInConversation,
  sendTemplate, SimulatedChannel, ConversationError, AttachmentError, TemplateError,
  type TemplateSummary,
} from '@solvenda/comms';
import { Badge, SimulatedNotice } from '@solvenda/ui';
import type { ConversationDetail } from '@/lib/console/inbox';
import { AttachmentCard } from './attachment-card';
import { LetterPicker } from './letter-picker';

/**
 * The conversation.
 *
 * Read as a conversation rather than a table of rows, because that is what it
 * is, and because an adviser scanning for "did we ever tell them about the
 * fee?" reads a thread far faster than a log. Internal notes sit in the same
 * thread and look nothing like a message, since the one thing that must never
 * happen is a note meant for a colleague being read as something the client saw.
 */

function timeOf(iso: string): string {
  return new Date(iso).toLocaleString('en-GB',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Delivery state, in the shorthand people already read on a phone. */
function tick(status: string): { mark: string; label: string } {
  switch (status) {
    case 'read': return { mark: '✓✓', label: 'Read' };
    case 'delivered': return { mark: '✓✓', label: 'Delivered' };
    case 'sent': return { mark: '✓', label: 'Sent' };
    case 'queued': return { mark: '⋯', label: 'Sending' };
    case 'failed': case 'bounced': return { mark: '!', label: 'Failed' };
    default: return { mark: '', label: status };
  }
}

export async function ConversationPane({
  conversation, clients, search, outstanding, caseId, templates, signature, result,
}: {
  conversation: ConversationDetail;
  clients: readonly { id: string; reference: string; name: string;
                      caseId: string | null; caseReference: string | null }[];
  search: string;
  outstanding: readonly { key: string; label: string; state: string }[];
  caseId: string | null;
  templates: readonly TemplateSummary[];
  /** How anything sent from here will be signed. Null if the account has no name. */
  signature: string | null;
  result: { ok: boolean; message: string } | null;
}) {
  const conversationId = conversation.id;

  // Opening a conversation is reading it. Anything else means an adviser has to
  // remember to mark it, and a shared inbox where nobody does that is a list of
  // things that all look equally urgent.
  await query(await requireSession(), (db) => markRead(db, conversationId));

  async function identify(form: FormData) {
    'use server';
    const session = await requireSession();
    try {
      const clientId = String(form.get('clientId') ?? '');
      if (!clientId) throw new ConversationError('Choose who this is.');
      await query(session, (db) => linkConversation(db, session.context, session.principal, {
        conversationId, clientId,
        caseId: String(form.get('caseId') ?? '') || null,
      }));
    } catch (cause) {
      console.error('identifying a conversation failed', cause);
      return redirect(`/app/inbox?c=${conversationId}&error=`
        + encodeURIComponent(cause instanceof ConversationError
            ? cause.message : 'That could not be linked.'));
    }
    redirect(`/app/inbox?c=${conversationId}&saved=`
      + encodeURIComponent('Linked. This number is recognised from now on.'));
  }

  async function claim(form: FormData) {
    'use server';
    const session = await requireSession();
    const toMe = form.get('to') === 'me';
    await query(session, (db) => assignConversation(db, session.context, session.principal, {
      conversationId, toUserId: toMe ? session.user.id : null,
    }));
    redirect(`/app/inbox?c=${conversationId}&saved=`
      + encodeURIComponent(toMe ? 'Assigned to you.' : 'Returned to the queue.'));
  }

  async function close() {
    'use server';
    const session = await requireSession();
    await query(session, (db) => setConversationStatus(db, session.context, session.principal, {
      conversationId, status: 'closed',
    }));
    redirect(`/app/inbox?saved=${encodeURIComponent('Conversation closed.')}`);
  }

  async function reply(form: FormData) {
    'use server';
    const session = await requireSession();
    const body = String(form.get('body') ?? '').trim();
    const internal = form.get('internal') === 'on';
    if (!body) redirect(`/app/inbox?c=${conversationId}`);

    try {
      await query(session, (db) =>
        replyInConversation(db, session.context, session.principal, {
          conversationId, body, internal,
          // Every channel is a sandbox simulator until a firm connects a real
          // provider, which the notice above the thread says plainly.
          adapter: internal ? undefined
                            : new SimulatedChannel(conversation.channel as 'whatsapp'),
        }));
    } catch (cause) {
      console.error('sending failed', cause);
      return redirect(`/app/inbox?c=${conversationId}&error=`
        + encodeURIComponent((cause as Error).message ?? 'That could not be sent.'));
    }
    redirect(`/app/inbox?c=${conversationId}&saved=`
      + encodeURIComponent(internal ? 'Note added.' : 'Sent.'));
  }

  async function letter(form: FormData) {
    'use server';
    const session = await requireSession();
    const clientId = conversation.clientId;
    if (!clientId) {
      return redirect(`/app/inbox?c=${conversationId}&error=`
        + encodeURIComponent('Link this conversation to a client before sending a letter.'));
    }

    // Whatever the template declared, gathered from fields named for it. The
    // signature is not among them — it is resolved from the signed-in account
    // inside sendTemplate, and there is no parameter here that could override it.
    const variables: Record<string, string> = {};
    for (const [name, value] of form.entries()) {
      if (name.startsWith('var.')) variables[name.slice(4)] = String(value).trim();
    }

    try {
      await query(session, (db) => sendTemplate(
        db, session.context, session.principal,
        new SimulatedChannel(conversation.channel as 'whatsapp'), {
          templateKey: String(form.get('templateKey') ?? ''),
          clientId, caseId: conversation.caseId, conversationId,
          channel: conversation.channel as 'whatsapp',
          variables,
          // Recomputed here rather than trusted from the page: the window can
          // close between a page render and a click.
          windowOpen: conversation.channel !== 'whatsapp'
            || Boolean(conversation.windowOpenUntil),
        }));
    } catch (cause) {
      console.error('sending a letter failed', cause);
      return redirect(`/app/inbox?c=${conversationId}&error=`
        + encodeURIComponent(cause instanceof TemplateError
            ? cause.message : 'That letter could not be sent.'));
    }
    redirect(`/app/inbox?c=${conversationId}&saved=`
      + encodeURIComponent('Letter sent, signed in your name.'));
  }

  async function file(form: FormData) {
    'use server';
    const session = await requireSession();
    const attachmentId = String(form.get('attachmentId') ?? '');
    try {
      const target = String(form.get('caseId') ?? '');
      if (!target) {
        throw new AttachmentError(
          'This conversation is not linked to a case yet, so there is nowhere to file it.');
      }
      const requirement = String(form.get('satisfiesRequirement') ?? '') || null;
      const filed = await query(session, (db) =>
        fileAttachment(db, session.context, session.principal, {
          attachmentId, caseId: target,
          documentType: String(form.get('documentType') ?? 'other'),
          acceptedSuggestion: form.get('accepted') === 'on',
          satisfiesRequirement: requirement,
        }));
      redirect(`/app/inbox?c=${conversationId}&saved=` + encodeURIComponent(
        filed.requirementSatisfied
          ? 'Filed, and the case now has evidence for it. The spine has moved.'
          : 'Filed to the case.'));
    } catch (cause) {
      if ((cause as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw cause;
      console.error('filing an attachment failed', cause);
      redirect(`/app/inbox?c=${conversationId}&error=`
        + encodeURIComponent(cause instanceof AttachmentError
            ? cause.message : 'That could not be filed.'));
    }
  }

  async function dismiss(form: FormData) {
    'use server';
    const session = await requireSession();
    try {
      await query(session, (db) => rejectAttachment(db, session.context, session.principal, {
        attachmentId: String(form.get('attachmentId') ?? ''),
        reason: String(form.get('reason') ?? '') || 'Not a document for the case file',
      }));
    } catch (cause) {
      console.error('dismissing an attachment failed', cause);
    }
    redirect(`/app/inbox?c=${conversationId}&saved=`
      + encodeURIComponent('Left out of the case file.'));
  }

  const windowOpen = conversation.channel !== 'whatsapp' || Boolean(conversation.windowOpenUntil);

  return (
    <section className="sv-conv" aria-label="Conversation">
      <header className="sv-conv__head">
        <div>
          <h2 className="sv-conv__title">
            {conversation.clientName ?? conversation.counterpartyLabel}
          </h2>
          <p className="sv-conv__sub">
            <span>{conversation.counterpartyLabel}</span>
            <span>via {conversation.accountName}</span>
            {conversation.caseReference && <span>{conversation.caseReference}</span>}
            {conversation.assignedName
              ? <span>Owned by {conversation.assignedName}</span>
              : <Badge tone="attention">Unassigned</Badge>}
          </p>
        </div>
        <div className="sv-conv__actions">
          <form action={claim}>
            <input type="hidden" name="to"
                   value={conversation.assignedTo ? 'queue' : 'me'} />
            <button className="sv-btn sv-btn--secondary sv-btn--sm" type="submit">
              {conversation.assignedTo ? 'Return to queue' : 'Assign to me'}
            </button>
          </form>
          <form action={close}>
            <button className="sv-btn sv-btn--secondary sv-btn--sm" type="submit">Close</button>
          </form>
        </div>
      </header>

      {result && (
        <p className={`sv-form__result ${result.ok ? 'sv-form__result--ok'
                                                   : 'sv-form__result--error'}`}
           role={result.ok ? 'status' : 'alert'}>{result.message}</p>
      )}

      {conversation.simulated && (
        <SimulatedNotice what="This is a sandbox WhatsApp number rather than a connected business account." />
      )}

      {/* Identifying comes before anything else: until it is done, nothing in
          this conversation can be filed anywhere, and that is deliberate. */}
      {!conversation.clientId && (
        <div className="sv-conv__identify">
          <h3 className="sv-subheading">Who is this?</h3>
          <p className="sv-muted">
            {conversation.match?.reason
              ?? 'Link this conversation to a client before filing anything from it.'}
          </p>
          <form action={identify} className="sv-conv__identifyForm">
            <select className="sv-input" name="clientId" defaultValue=""
                    aria-label="Client">
              <option value="" disabled>Choose a client…</option>
              {(conversation.match?.candidates ?? []).map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.name} · {c.reference} — {c.why}
                </option>
              ))}
              {clients
                .filter((c) => !(conversation.match?.candidates ?? [])
                  .some((m) => m.clientId === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.reference}
                    {c.caseReference ? ` · ${c.caseReference}` : ''}
                  </option>
                ))}
            </select>
            <button className="sv-btn sv-btn--primary sv-btn--sm" type="submit">
              Link
            </button>
          </form>
        </div>
      )}

      <div className="sv-thread">
        {conversation.messages.map((m) => {
          const internal = m.direction === 'internal' || m.channel === 'internal-note';
          const mine = m.direction === 'outbound';
          return (
            <article key={m.id}
                     className={`sv-msg${internal ? ' sv-msg--note'
                                                  : mine ? ' sv-msg--out' : ' sv-msg--in'}`}>
              {internal && <span className="sv-msg__noteMark">Internal note</span>}
              {m.body && <p className="sv-msg__body">{m.body}</p>}

              {m.attachments.map((a) => (
                <AttachmentCard
                  key={a.id}
                  attachment={a}
                  caseId={caseId}
                  suggestion={suggestClassification({
                    filename: a.filename, contentType: a.contentType,
                    mediaKind: a.mediaKind, messageText: m.body,
                    outstanding,
                  })}
                  outstanding={outstanding}
                  onFile={file}
                  onDismiss={dismiss}
                />
              ))}

              <footer className="sv-msg__meta">
                <span>{timeOf(m.occurredAt)}</span>
                {m.sentByName && <span>{m.sentByName}</span>}
                {mine && (
                  <span title={tick(m.status).label} aria-label={tick(m.status).label}
                        className={m.status === 'read' ? 'sv-msg__read' : undefined}>
                    {tick(m.status).mark}
                  </span>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      {conversation.clientId && (
        <LetterPicker
          templates={templates}
          signature={signature}
          windowOpen={windowOpen}
          clientName={conversation.clientName ?? conversation.counterpartyLabel}
          onSend={letter}
        />
      )}

      <form action={reply} className="sv-composer">
        {/* The service window is a state, not an error to discover on send.
            Saying so before the adviser types is the difference between a
            product that knows the rules and one that reports them afterwards. */}
        {!windowOpen && (
          <p className="sv-composer__closed" role="status">
            More than 24 hours since {conversation.clientName ?? 'they'} last wrote, so
            WhatsApp will only carry an approved template. A free reply will not reach them.
          </p>
        )}
        <textarea className="sv-input" name="body" rows={3}
                  aria-label="Reply"
                  placeholder={windowOpen
                    ? 'Reply, or add an internal note…'
                    : 'Only an internal note can be added while the window is closed.'} />
        <div className="sv-composer__row">
          <label className="sv-check">
            <input type="checkbox" name="internal" defaultChecked={!windowOpen} />
            Internal note — the client never sees this
          </label>
          <div className="sv-composer__send">
            {signature && (
              <span className="sv-composer__signed">Signed {signature}</span>
            )}
            <button className="sv-btn sv-btn--primary sv-btn--md" type="submit">Send</button>
          </div>
        </div>
      </form>
    </section>
  );
}
