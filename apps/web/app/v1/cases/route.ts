import { NextResponse } from 'next/server';
import { sql } from '@solvenda/db';
import { openCase, parseCaseTypeDefinition, CaseworkError } from '@solvenda/core';
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
export const POST = withApiKey('case:write', async (request, { db, ctx, principal }) => {
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

  // Opening a case is the same operation here as in the console, so it is the
  // same function. A second copy would be a second answer to "what stage does
  // this start at" and "what is it referenced as".
  try {
    const opened = await openCase(db, ctx, principal, {
      clientId: body.clientId,
      caseType: parseCaseTypeDefinition(caseType.rows[0].definition),
      caseTypeVersion: caseType.rows[0].version,
      source: typeof body.source === 'string' ? body.source : 'api',
    });
    return NextResponse.json({ data: opened }, { status: 201 });
  } catch (cause) {
    if (cause instanceof CaseworkError) {
      return apiError(422, 'cannot_open_case', cause.message);
    }
    throw cause;
  }
});
