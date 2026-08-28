import { NextResponse } from 'next/server';
import { sql } from '@solvenda/db';
import { createClient, CaseworkError } from '@solvenda/core';
import { withApiKey, paginationFrom, apiError } from '@/lib/console/api';

/** GET /v1/clients */
export const GET = withApiKey('client:read', async (request, { db }) => {
  const url = new URL(request.url);
  const { limit, cursor } = paginationFrom(url);

  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT id, reference, first_name, last_name, email, jurisdiction,
           household_adults::text, household_children::text, status, created_at::text
      FROM clients
     WHERE (${cursor}::text IS NULL OR id::text < ${cursor}::text)
     ORDER BY id DESC LIMIT ${limit + 1}`);

  const rows = res.rows.slice(0, limit);
  const hasMore = res.rows.length > limit;

  return NextResponse.json({
    data: rows.map((r) => ({
      id: r['id'], reference: r['reference'],
      firstName: r['first_name'], lastName: r['last_name'],
      email: r['email'], jurisdiction: r['jurisdiction'],
      household: { adults: Number(r['household_adults']),
                   children: Number(r['household_children']) },
      status: r['status'], createdAt: r['created_at'],
    })),
    pagination: { hasMore, nextCursor: hasMore ? rows[rows.length - 1]?.['id'] ?? null : null },
  });
});

/**
 * POST /v1/clients
 *
 * The realistic integration case: an introducer's system creating a referral.
 * Vulnerability information is deliberately not accepted here - it is special
 * category data requiring an Article 9 condition and an adviser's assessment,
 * and a referral form is the wrong place to capture it.
 */
export const POST = withApiKey('client:write', async (request, { db, ctx, principal }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.firstName !== 'string' || typeof body.lastName !== 'string') {
    return apiError(400, 'invalid_request', 'firstName and lastName are required.',
      { fields: ['firstName', 'lastName'] });
  }
  if ('vulnerability' in body) {
    return apiError(422, 'not_accepted',
      'Vulnerability information cannot be submitted through this endpoint. It is special ' +
      'category data requiring a lawful basis under Article 9 and an adviser assessment.');
  }

  // The same function the console calls, so a client opened either way gets the
  // same reference scheme and the same audit entry.
  try {
    const created = await createClient(db, ctx, principal, {
      firstName: body.firstName, lastName: body.lastName,
      dateOfBirth: body.dateOfBirth, email: body.email, phoneMobile: body.phoneMobile,
      addressLine1: body.addressLine1, addressCity: body.addressCity,
      addressPostcode: body.addressPostcode, jurisdiction: body.jurisdiction,
      householdAdults: body.household?.adults, householdChildren: body.household?.children,
      employmentStatus: body.employmentStatus,
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (cause) {
    if (cause instanceof CaseworkError) {
      return apiError(422, 'cannot_open_client', cause.message);
    }
    throw cause;
  }
});
