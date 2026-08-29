import { requireSession, query } from '@/lib/console/session';
import { loadInbox, loadInboxCounts, loadConversation, searchClients,
         type InboxFilter } from '@/lib/console/inbox';
import { loadDashboard } from '@/lib/console/data';
import { AppShell } from '@/components/console/app-shell';
import { ConversationPane } from '@/components/console/conversation-pane';
import { InboxList } from '@/components/console/inbox-list';
import { ContextPane } from '@/components/console/context-pane';
import { EmptyState } from '@solvenda/ui';
import { caseContext } from '@/lib/console/case-context';
import { outstandingEvidence } from '@solvenda/core';
import { listTemplates, resolveSignature, type TemplateSummary } from '@solvenda/comms';
import { listVulnerabilityRecords } from '@solvenda/core';
import { pendingProposalsForClient } from '@solvenda/ai';

export const dynamic = 'force-dynamic';

const FILTERS: InboxFilter[] = ['mine', 'unassigned', 'unmatched', 'all'];

/**
 * The inbox.
 *
 * Three panes, because an adviser answering a client needs three things at once:
 * what is waiting, what was said, and who this is. Making any of them a separate
 * page is what turns answering a message into a navigation exercise, and it is
 * the difference between this and a CRM's communication log.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; c?: string; q?: string;
                          saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { filter: rawFilter, c: conversationId, q, saved, error } = await searchParams;
  const filter = (FILTERS as string[]).includes(rawFilter ?? '')
    ? (rawFilter as InboxFilter) : 'mine';

  const [dashboard, conversations, counts] = await Promise.all([
    query(session, (db) => loadDashboard(db, session.user.id)),
    query(session, (db) => loadInbox(db, filter, session.user.id)),
    query(session, (db) => loadInboxCounts(db, session.user.id)),
  ]);

  // The conversation asked for, or the first thing waiting — an inbox that opens
  // on nothing makes the adviser click before they can start.
  const selectedId = conversationId ?? conversations[0]?.id ?? null;
  const conversation = selectedId
    ? await query(session, (db) => loadConversation(db, selectedId))
    : null;

  // Only loaded when the conversation is unidentified, since that is the only
  // time an adviser is choosing a client.
  const clients = conversation && !conversation.clientId
    ? await query(session, (db) => searchClients(db, q ?? ''))
    : [];

  // The firm's letters, each already knowing whether this channel will carry it
  // right now — because a picker that offers something WhatsApp will refuse is
  // how an adviser comes to believe a client was told something they were not.
  const windowOpen = !conversation ? false
    : conversation.channel !== 'whatsapp' || Boolean(conversation.windowOpenUntil);
  const templates: TemplateSummary[] = conversation?.clientId
    ? await query(session, (db) => listTemplates(db, conversation.channel, windowOpen))
    : [];

  // Stated in the composer before anything is typed. The name comes from the
  // signed-in account and cannot be chosen, which is the whole point of showing
  // it; an account with no name recorded cannot send to a client at all, and
  // saying so here beats a failure after somebody has written the message.
  const signature = await query(session, (db) => resolveSignature(db, session.principal))
    .then((s) => s.text)
    .catch(() => null);

  // What the firm has agreed to do differently for this person, and how many
  // signals nobody has decided yet. Both belong beside the composer: the first
  // because an adviser about to write should know what was promised, the second
  // because a queue that is only visible on the case file is a queue that waits.
  const [support, pendingSignals] = conversation?.clientId
    ? await Promise.all([
        query(session, (db) => listVulnerabilityRecords(db, conversation.clientId!)),
        query(session, (db) =>
          pendingProposalsForClient(db, conversation.clientId!, 'vulnerability-consideration')),
      ])
    : [[], []];

  // The case behind the conversation, so the context pane can say what is
  // outstanding — which is also what makes an attachment suggestion specific.
  const context = conversation?.caseId ? await caseContext(conversation.caseId) : null;
  const outstanding = context ? outstandingEvidence(context.detail.evidence) : [];

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current="inbox"
    >
      <div className="sv-inbox">
        <InboxList
          conversations={conversations}
          counts={counts}
          filter={filter}
          selectedId={selectedId}
        />

        {conversation ? (
          <ConversationPane
            conversation={conversation}
            clients={clients}
            search={q ?? ''}
            outstanding={outstanding.map((e) => ({
              key: e.key, label: e.label, state: e.state,
            }))}
            caseId={conversation.caseId}
            templates={templates}
            signature={signature}
            result={saved ? { ok: true, message: decodeURIComponent(saved) }
                  : error ? { ok: false, message: error } : null}
          />
        ) : (
          <div className="sv-conv">
            <EmptyState
              title="Nothing waiting here."
              detail="Messages arrive from the firm's own numbers and addresses. Try another filter."
            />
          </div>
        )}

        <ContextPane
          conversation={conversation}
          standing={context ? {
            score: context.detail.intelligence.health.score,
            band: context.detail.intelligence.health.band,
            summary: context.detail.intelligence.health.summary,
            ready: context.detail.intelligence.adviceReadiness.ready,
            blockingCount: context.detail.intelligence.adviceReadiness.blocking.length,
          } : null}
          outstanding={outstanding.map((e) => ({
            key: e.key, label: e.label, state: e.state, because: e.because,
          }))}
          support={support
            .filter((r) => r.driver !== 'none')
            .map((r) => ({
              driver: r.driver, severity: r.severity,
              supportNeeds: r.supportNeeds, adjustmentsAgreed: r.adjustmentsAgreed,
            }))}
          pendingSignals={pendingSignals.length}
        />
      </div>
    </AppShell>
  );
}
