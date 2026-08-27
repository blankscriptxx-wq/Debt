import { sql, type Database } from '@solvenda/db';

/**
 * The case timeline.
 *
 * Merges communications, audit events and domain events into one chronological
 * account. An adviser or a reviewer asking "what happened on this case" gets
 * one answer, whether the thing that happened was a phone call, an advice
 * decision, a workflow step or a client opening the portal.
 */

export interface TimelineEntry {
  id: string;
  kind: 'communication' | 'audit' | 'event';
  occurredAt: string;
  channel: string | null;
  direction: string | null;
  title: string;
  detail: string | null;
  actorLabel: string | null;
  severity: string | null;
  simulated: boolean;
}

export interface TimelineOptions {
  limit?: number;
  before?: Date;
  /** Excludes routine reads, which otherwise drown the narrative. */
  includeInformational?: boolean;
}

export async function caseTimeline(
  db: Database,
  caseId: string,
  options: TimelineOptions = {},
): Promise<TimelineEntry[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const before = options.before?.toISOString() ?? null;
  const includeInformational = options.includeInformational ?? false;

  const res = await db.execute<{
    id: string; kind: string; occurred_at: string; channel: string | null;
    direction: string | null; title: string; detail: string | null;
    actor_label: string | null; severity: string | null; simulated: boolean;
  }>(sql`
    (
      SELECT c.id, 'communication' AS kind, c.occurred_at,
             c.channel, c.direction,
             coalesce(c.subject, initcap(replace(c.channel, '-', ' '))) AS title,
             left(coalesce(c.body_redacted, c.body), 400) AS detail,
             coalesce(u.full_name, c.counterparty_label) AS actor_label,
             NULL::text AS severity, c.simulated
        FROM communications c
        LEFT JOIN users u ON u.id = c.sent_by
       WHERE c.case_id = ${caseId}
         AND (${before}::timestamptz IS NULL OR c.occurred_at < ${before}::timestamptz)
    )
    UNION ALL
    (
      SELECT a.id, 'audit' AS kind, a.occurred_at,
             NULL AS channel, NULL AS direction,
             a.action AS title, a.reason AS detail,
             a.actor_label, a.severity, false AS simulated
        FROM audit_events a
       WHERE a.case_id = ${caseId}
         AND (${includeInformational} OR a.severity <> 'info')
         AND (${before}::timestamptz IS NULL OR a.occurred_at < ${before}::timestamptz)
    )
    UNION ALL
    (
      SELECT e.id, 'event' AS kind, e.occurred_at,
             NULL AS channel, NULL AS direction,
             e.event_type AS title, NULL AS detail,
             e.source AS actor_label, NULL::text AS severity, false AS simulated
        FROM domain_events e
       WHERE e.case_id = ${caseId}
         AND (${before}::timestamptz IS NULL OR e.occurred_at < ${before}::timestamptz)
    )
    ORDER BY occurred_at DESC
    LIMIT ${limit}`);

  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind as TimelineEntry['kind'],
    occurredAt: r.occurred_at,
    channel: r.channel,
    direction: r.direction,
    title: r.title,
    detail: r.detail,
    actorLabel: r.actor_label,
    severity: r.severity,
    simulated: r.simulated,
  }));
}

export interface EngagementSummary {
  lastClientContactAt: string | null;
  lastClientResponseAt: string | null;
  unansweredOutboundCount: number;
  portalLastSeenAt: string | null;
}

/**
 * How engaged the client is, computed from the timeline rather than guessed.
 * Feeds the disengagement signal in Case Intelligence.
 */
export async function engagementSummary(
  db: Database,
  clientId: string,
): Promise<EngagementSummary> {
  const res = await db.execute<{
    last_outbound: string | null; last_inbound: string | null; unanswered: string;
  }>(sql`
    SELECT
      max(occurred_at) FILTER (WHERE direction = 'outbound') AS last_outbound,
      max(occurred_at) FILTER (WHERE direction = 'inbound')  AS last_inbound,
      count(*) FILTER (
        WHERE direction = 'outbound'
          AND occurred_at > coalesce(
            (SELECT max(occurred_at) FROM communications
              WHERE client_id = ${clientId} AND direction = 'inbound'),
            '-infinity'::timestamptz)
      )::text AS unanswered
      FROM communications WHERE client_id = ${clientId}`);

  const row = res.rows[0]!;
  return {
    lastClientContactAt: row.last_outbound,
    lastClientResponseAt: row.last_inbound,
    unansweredOutboundCount: Number(row.unanswered),
    portalLastSeenAt: null,
  };
}
