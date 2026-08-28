import Link from 'next/link';
import { Badge } from '@solvenda/ui';
import type { ConversationSummary, InboxFilter } from '@/lib/console/inbox';

/**
 * What is waiting.
 *
 * Sorted unread first, then most recent — an inbox exists to answer "who has
 * been kept waiting", and the newest message is rarely the most overdue one.
 */

const LABELS: Record<InboxFilter, string> = {
  mine: 'Mine', unassigned: 'Unassigned', unmatched: 'Unidentified', all: 'All',
};

const CHANNEL_MARK: Record<string, string> = {
  whatsapp: '◆', sms: '▸', email: '✉', portal: '◈', call: '☎', 'internal-note': '▪',
};

function when(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function InboxList({
  conversations, counts, filter, selectedId,
}: {
  conversations: readonly ConversationSummary[];
  counts: Record<InboxFilter, number>;
  filter: InboxFilter;
  selectedId: string | null;
}) {
  return (
    <nav className="sv-inbox__list" aria-label="Conversations">
      <div className="sv-inbox__filters">
        {(Object.keys(LABELS) as InboxFilter[]).map((key) => (
          <Link key={key} href={`/app/inbox?filter=${key}`}
                className={`sv-inbox__filter${filter === key ? ' sv-inbox__filter--on' : ''}`}
                aria-current={filter === key ? 'page' : undefined}>
            {LABELS[key]}
            {counts[key] > 0 && <span className="sv-inbox__filterCount">{counts[key]}</span>}
          </Link>
        ))}
      </div>

      <ul className="sv-inbox__items">
        {conversations.length === 0 && (
          <li className="sv-inbox__empty">Nothing here.</li>
        )}
        {conversations.map((c) => (
          <li key={c.id}>
            <Link href={`/app/inbox?filter=${filter}&c=${c.id}`}
                  className={`sv-inbox__item${c.id === selectedId ? ' sv-inbox__item--on' : ''}`
                           + `${c.unread ? ' sv-inbox__item--unread' : ''}`}
                  aria-current={c.id === selectedId ? 'true' : undefined}>
              <span className="sv-inbox__who">
                <span className="sv-inbox__channel" aria-hidden="true">
                  {CHANNEL_MARK[c.channel] ?? '•'}
                </span>
                <span className="sv-inbox__name">
                  {c.clientName ?? c.counterpartyLabel}
                </span>
                <span className="sv-inbox__when">{when(c.lastMessageAt)}</span>
              </span>

              <span className="sv-inbox__preview">{c.lastMessagePreview ?? '—'}</span>

              <span className="sv-inbox__marks">
                {/* Unidentified is the state that needs a person, so it says so
                    rather than showing a number nobody can act on. */}
                {!c.clientId && <Badge tone="attention">Unidentified</Badge>}
                {c.caseReference && <span className="sv-inbox__ref">{c.caseReference}</span>}
                {c.attachmentsWaiting > 0 && (
                  <Badge tone="accent">
                    {c.attachmentsWaiting} to file
                  </Badge>
                )}
                {c.assignedName && (
                  <span className="sv-inbox__owner">{c.assignedName.split(' ')[0]}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
