import { NextResponse } from 'next/server';
import { sql, type Database } from '@solvenda/db';
import { withApiKey, paginationFrom, apiError } from '@/lib/console/api';

/**
 * GET /v1/cases
 *
 * Cursor paginated on (opened_at, id) so a page stays stable while cases are
 * being created underneath it.
 */
export const GET = withApiKey('case:read', async (request, { db }) => {
  const url = new URL(request.url);
  const { limit, cursor } = paginationFrom(url);
  const stage = url.searchParams.get('stage');
  const caseType = url.searchParams.get('case_type');

  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT k.id, k.reference, k.case_type_key, k.case_type_version, k.stage, k.status,
           k.jurisdiction, k.opened_at::text, k.next_review_due::text,
           c.id AS client_id, c.reference AS client_reference,
           coalesce((SELECT sum(balance_pence) FROM debts d
                      WHERE d.case_id = k.id AND d.status = 'active'), 0)::text AS total_debt_pence
      FROM cases k
      JOIN clients c ON c.id = k.client_id
     WHERE (${cursor}::text IS NULL OR k.id::text < ${cursor}::text)
       AND (${stage}::text IS NULL OR k.stage = ${stage}::text)
       AND (${caseType}::text IS NULL OR k.case_type_key = ${caseType}::text)
     ORDER BY k.id DESC
     LIMIT ${limit + 1}`);

  const rows = res.rows.slice(0, limit);
  const hasMore = res.rows.length > limit;

  return NextResponse.json({
    data: rows.map((r) => ({
      id: r['id'],
      reference: r['reference'],
      caseType: { key: r['case_type_key'], version: Number(r['case_type_version']) },
      stage: r['stage'],
      status: r['status'],
      jurisdiction: r['jurisdiction'],
      openedAt: r['opened_at'],
      nextReviewDue: r['next_review_due'],
      client: { id: r['client_id'], reference: r['client_reference'] },
      totalDebtPence: Number(r['total_debt_pence']),
    })),
    pagination: { hasMore, nextCursor: hasMore ? rows[rows.length - 1]?.['id'] ?? null : null },
  });
});

/**
 * POST /v1/cases
 *
 * Creates a case for an existing client. Deliberately does not accept advice,
 * a solution or a financial statement: those are regulated records that cannot
 * be created by an API key, and accepting them here only to reject them later
 * would be worse than not offering the field.
 */
export const POST = withApiKey('case:write', async (request, { db, ctx }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.clientId !== 'string' || typeof body.caseTypeKey !== 'string') {
    return apiError(400, 'invalid_request',
      'clientId and caseTypeKey are required.',
      { fields: ['clientId', 'caseTypeKey'] });
  }

  const caseType = await db.execute<{ key: string; version: number; definition: { startStep?: string; stages?: { key: string; order: number }[] } }>(sql`
    SELECT key, version, definition FROM case_type_definitions
     WHERE key = ${body.caseTypeKey} AND status = 'active'
     ORDER BY version DESC LIMIT 1`);
  if (!caseType.rows[0]) {
    return apiError(422, 'unknown_case_type',
      `"${body.caseTypeKey}" is not an active case type for this firm.`);
  }

  const client = await db.execute<{ id: string; jurisdiction: string }>(sql`
    SELECT id, jurisdiction FROM clients WHERE id = ${body.clientId}`);
  if (!client.rows[0]) {
    return apiError(404, 'client_not_found', 'No client with that identifier.');
  }

  const stages = caseType.rows[0].definition.stages ?? [];
  const first = [...stages].sort((a, b) => a.order - b.order)[0]?.key ?? 'referral';

  const reference = await nextReference(db, body.caseTypeKey);

  const created = await db.execute<{ id: string; reference: string }>(sql`
    INSERT INTO cases (reference, client_id, case_type_key, case_type_version, jurisdiction,
                       stage, source)
    VALUES (${reference}, ${body.clientId}, ${body.caseTypeKey}, ${caseType.rows[0].version},
            ${client.rows[0].jurisdiction}, ${first}, ${body.source ?? 'api'})
    RETURNING id, reference`);

  const { recordAudit } = await import('@solvenda/audit');
  await recordAudit(db, ctx, {
    action: 'case.created', resourceType: 'case', resourceId: created.rows[0]!.id,
    caseId: created.rows[0]!.id, source: 'api',
    after: { reference: created.rows[0]!.reference, caseType: body.caseTypeKey },
  });

  return NextResponse.json(
    { data: { id: created.rows[0]!.id, reference: created.rows[0]!.reference, stage: first } },
    { status: 201 },
  );
});

/** Sequential per case type. Adequate at these volumes; a firm wanting a
 *  different scheme configures referenceFormat on the case type. */
async function nextReference(db: Database, caseTypeKey: string): Promise<string> {
  const prefix = caseTypeKey.toUpperCase().slice(0, 4);
  const res = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM cases WHERE case_type_key = ${caseTypeKey}`);
  return `${prefix}-${String(Number(res.rows[0]!.n) + 1).padStart(4, '0')}`;
}
