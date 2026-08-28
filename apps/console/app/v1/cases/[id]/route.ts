import { NextResponse } from 'next/server';
import { sql } from '@solvenda/db';
import { withApiKey, apiError } from '@/lib/api';

/** GET /v1/cases/{id} */
export const GET = withApiKey('case:read', async (_request, { db }, params) => {
  const id = params['id'];
  if (!id) return apiError(400, 'invalid_request', 'A case id is required.');

  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT k.id, k.reference, k.case_type_key, k.stage, k.status, k.jurisdiction,
           k.opened_at::text, k.next_review_due::text, k.closed_at::text, k.closure_reason,
           c.id AS client_id, c.reference AS client_reference
      FROM cases k JOIN clients c ON c.id = k.client_id
     WHERE k.id = ${id}`);

  const row = res.rows[0];
  if (!row) return apiError(404, 'not_found', 'No case with that identifier.');

  const debts = await db.execute<Record<string, string | null>>(sql`
    SELECT id, creditor_name, balance_pence::text, arrears_pence::text, debt_type,
           is_priority::text, provenance, status
      FROM debts WHERE case_id = ${id} ORDER BY balance_pence DESC`);

  const statement = await db.execute<Record<string, string | null>>(sql`
    SELECT version::text, total_income_pence::text, total_expenditure_pence::text,
           surplus_pence::text, completed_at::text
      FROM financial_statements WHERE case_id = ${id} AND status = 'current'`);

  return NextResponse.json({
    data: {
      id: row['id'],
      reference: row['reference'],
      caseType: row['case_type_key'],
      stage: row['stage'],
      status: row['status'],
      jurisdiction: row['jurisdiction'],
      openedAt: row['opened_at'],
      nextReviewDue: row['next_review_due'],
      closedAt: row['closed_at'],
      closureReason: row['closure_reason'],
      client: { id: row['client_id'], reference: row['client_reference'] },
      debts: debts.rows.map((d) => ({
        id: d['id'], creditorName: d['creditor_name'],
        balancePence: Number(d['balance_pence']), arrearsPence: Number(d['arrears_pence']),
        debtType: d['debt_type'], isPriority: d['is_priority'] === 'true',
        provenance: d['provenance'], status: d['status'],
      })),
      financialStatement: statement.rows[0] ? {
        version: Number(statement.rows[0]['version']),
        totalIncomePence: Number(statement.rows[0]['total_income_pence']),
        totalExpenditurePence: Number(statement.rows[0]['total_expenditure_pence']),
        surplusPence: Number(statement.rows[0]['surplus_pence']),
        completedAt: statement.rows[0]['completed_at'],
      } : null,
    },
  });
});
