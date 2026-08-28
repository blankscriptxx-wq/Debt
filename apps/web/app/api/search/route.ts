import { NextResponse } from 'next/server';
import { sql } from '@solvenda/db';
import { currentSession, query } from '@/lib/console/session';

/**
 * Global search.
 *
 * Runs inside the caller's tenant context, so the RLS policies do the scoping.
 * There is no tenant filter in the SQL below and there does not need to be -
 * a bug here returns nothing rather than another firm's clients.
 */
export async function GET(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ results: [] }, { status: 401 });

  const term = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (term.length < 2) return NextResponse.json({ results: [] });

  const pattern = `%${term}%`;
  const results = await query(session, async (db) => {
    const res = await db.execute<{
      id: string; reference: string; client_name: string; case_type_key: string; stage: string;
    }>(sql`
      SELECT k.id, k.reference, c.first_name || ' ' || c.last_name AS client_name,
             k.case_type_key, k.stage
        FROM cases k
        JOIN clients c ON c.id = k.client_id
       WHERE k.reference ILIKE ${pattern}
          OR (c.first_name || ' ' || c.last_name) ILIKE ${pattern}
          OR c.address_postcode ILIKE ${pattern}
          OR c.email ILIKE ${pattern}
       ORDER BY k.opened_at DESC
       LIMIT 8`);
    return res.rows;
  });

  return NextResponse.json({
    results: results.map((r) => ({
      id: r.id,
      label: `${r.reference} — ${r.client_name}`,
      hint: `${r.case_type_key.toUpperCase()} · ${r.stage}`,
      href: `/app/cases/${r.id}`,
    })),
  });
}
