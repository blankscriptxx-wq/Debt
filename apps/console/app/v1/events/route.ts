import { NextResponse } from 'next/server';
import { sql } from '@solvenda/db';
import { withApiKey, paginationFrom } from '@/lib/api';

/**
 * GET /v1/events
 *
 * The same events webhooks deliver, pollable. Integrators who cannot receive a
 * webhook - or who have missed some - should not have to ask us to replay.
 */
export const GET = withApiKey('case:read', async (request, { db }) => {
  const url = new URL(request.url);
  const { limit, cursor } = paginationFrom(url);
  const type = url.searchParams.get('type');
  const since = url.searchParams.get('since');

  const res = await db.execute<Record<string, string | null> & { payload: unknown }>(sql`
    SELECT id, event_type, case_id, client_id, resource_type, resource_id,
           payload, source, occurred_at::text
      FROM domain_events
     WHERE (${cursor}::text IS NULL OR id::text < ${cursor}::text)
       AND (${type}::text IS NULL OR event_type = ${type}::text)
       AND (${since}::text IS NULL OR occurred_at > ${since}::timestamptz)
     ORDER BY id DESC LIMIT ${limit + 1}`);

  const rows = res.rows.slice(0, limit);
  const hasMore = res.rows.length > limit;

  return NextResponse.json({
    data: rows.map((r) => ({
      id: r['id'], type: r['event_type'],
      caseId: r['case_id'], clientId: r['client_id'],
      resource: r['resource_type'] ? { type: r['resource_type'], id: r['resource_id'] } : null,
      data: r.payload, source: r['source'], occurredAt: r['occurred_at'],
    })),
    pagination: { hasMore, nextCursor: hasMore ? rows[rows.length - 1]?.['id'] ?? null : null },
  });
});
