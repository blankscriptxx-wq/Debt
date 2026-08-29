import Link from 'next/link';
import { CaseStanding, EvidenceState, EmptyState } from '@solvenda/ui';
import type { ConversationDetail } from '@/lib/console/inbox';

/**
 * Who this is, and what their case still needs.
 *
 * The third pane exists so an adviser can answer a client without opening the
 * case file to remember what they were chasing. It is also what makes the
 * attachment suggestions specific: the same outstanding list drives both, so
 * "this case is waiting on bank statements" is on screen while the client is
 * sending one.
 */

export interface SupportContext {
  driver: string;
  severity: string;
  supportNeeds: string[];
  adjustmentsAgreed: string[];
}

export function ContextPane({
  conversation, standing, outstanding, support = [], pendingSignals = 0,
}: {
  conversation: ConversationDetail | null;
  standing: {
    score: number; band: string; summary: string; ready: boolean; blockingCount: number;
  } | null;
  outstanding: readonly { key: string; label: string; state: string; because: string }[];
  /** What the firm has agreed to do differently for this person. */
  support?: readonly SupportContext[];
  /** Signals nobody has decided yet, counted rather than quoted. */
  pendingSignals?: number;
}) {
  if (!conversation) {
    return <aside className="sv-context" aria-label="Client context" />;
  }

  if (!conversation.clientId) {
    return (
      <aside className="sv-context" aria-label="Client context">
        <EmptyState
          title="Nobody identified yet."
          detail="Once this conversation is linked to a client, their case and what it still needs appear here."
        />
      </aside>
    );
  }

  return (
    <aside className="sv-context" aria-label="Client context">
      <h3 className="sv-subheading">{conversation.clientName}</h3>

      {conversation.caseId && standing ? (
        <CaseStanding {...standing} href={`/app/cases/${conversation.caseId}`} />
      ) : (
        <p className="sv-muted">
          No open case, or more than one. Open the client to choose.
        </p>
      )}

      {/* The highest-value thing on this pane. "What have we promised this
          person" is exactly what an adviser needs in front of them while they
          are writing the reply, and everywhere else it is two clicks away in a
          tab nobody opens mid-conversation. */}
      {support.length > 0 && (
        <div className="sv-context__vuln">
          <h4 className="sv-subheading">Support needs</h4>
          {support.map((s, i) => (
            <div key={i} className="sv-context__vulnItem">
              <span className="sv-context__vulnDriver">
                {s.driver.replace(/-/g, ' ')} · {s.severity}
              </span>
              {s.adjustmentsAgreed.length > 0 && (
                <p className="sv-context__vulnAgreed">
                  Agreed: {s.adjustmentsAgreed.join(' · ')}
                </p>
              )}
              {s.supportNeeds.length > 0 && (
                <p className="sv-context__vulnNeeds">{s.supportNeeds.join(' · ')}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Counted, not quoted. Recording a vulnerability is a regulated act and
          must not become a two-click affair beside the composer. */}
      {pendingSignals > 0 && conversation.caseId && (
        <p className="sv-context__vulnPending">
          {pendingSignals === 1
            ? 'One vulnerability signal is waiting on a decision.'
            : `${pendingSignals} vulnerability signals are waiting on a decision.`}{' '}
          <Link href={`/app/cases/${conversation.caseId}/vulnerability`}>
            Decide on the case file
          </Link>
        </p>
      )}

      {conversation.caseId && (
        <>
          <h4 className="sv-subheading">Still needed</h4>
          {outstanding.length === 0 ? (
            <p className="sv-muted">Nothing outstanding on this case.</p>
          ) : (
            <ul className="sv-context__list">
              {outstanding.map((o) => (
                <li key={o.key} className="sv-context__item">
                  <span className="sv-context__itemHead">
                    <span>{o.label}</span>
                    <EvidenceState state={o.state as 'missing'} />
                  </span>
                  <span className="sv-context__why">{o.because}</span>
                </li>
              ))}
            </ul>
          )}

          <Link className="sv-btn sv-btn--secondary sv-btn--sm"
                href={`/app/cases/${conversation.caseId}`}>
            Open the case file
          </Link>
        </>
      )}
    </aside>
  );
}
