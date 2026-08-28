import { sql, type Database } from '@solvenda/db';
import {
  listAppointments, listAssets, listEmployment, listHouseholdMembers,
  listVerificationItems, totalsFor, type EvidenceRecords,
} from '@solvenda/core';

/**
 * Reads backing the case file tabs.
 *
 * Each tab loads only what it renders. The header is shared, so it is one
 * query rather than one per tab.
 */

export interface CaseFileHeader {
  caseId: string;
  clientId: string;
  reference: string;
  clientName: string;
  caseTypeKey: string;
  stage: string;
  status: string;
  ownerName: string | null;
}

export async function loadCaseFileHeader(
  db: Database, caseId: string,
): Promise<CaseFileHeader | null> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT k.id, k.reference, k.case_type_key, k.stage, k.status,
           c.id AS client_id, c.first_name || ' ' || c.last_name AS client_name,
           u.full_name AS owner_name
      FROM cases k
      JOIN clients c ON c.id = k.client_id
      LEFT JOIN users u ON u.id = k.owner_user_id
     WHERE k.id = ${caseId}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    caseId: row['id']!, clientId: row['client_id']!,
    reference: row['reference']!, clientName: row['client_name']!,
    caseTypeKey: row['case_type_key']!, stage: row['stage']!, status: row['status']!,
    ownerName: row['owner_name'] ?? null,
  };
}

/** Counts for the tab strip, so an adviser can see where the work is. */
export async function loadTabCounts(
  db: Database, caseId: string, clientId: string,
): Promise<Record<string, number>> {
  const res = await db.execute<Record<string, string>>(sql`
    SELECT (SELECT count(*) FROM household_members WHERE client_id = ${clientId}) AS household,
           (SELECT count(*) FROM employment_records
             WHERE client_id = ${clientId} AND is_current) AS employment,
           (SELECT count(*) FROM assets
             WHERE client_id = ${clientId} AND disposed_on IS NULL) AS assets,
           (SELECT count(*) FROM debts
             WHERE case_id = ${caseId} AND status = 'active') AS debts,
           (SELECT count(*) FROM appointments
             WHERE case_id = ${caseId} AND status = 'scheduled') AS appointments,
           (SELECT count(*) FROM verification_items
             WHERE case_id = ${caseId} AND status = 'outstanding') AS verification,
           (SELECT count(*) FROM communications
             WHERE case_id = ${caseId} AND channel <> 'internal-note') AS messages`);
  const row = res.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

export async function loadClient(db: Database, clientId: string) {
  const res = await db.execute<Record<string, string | null> & { previous_names: string[] }>(sql`
    SELECT id, reference, title, first_name, middle_names, last_name, previous_names,
           date_of_birth::text, place_of_birth, marital_status, gender,
           national_insurance_number, email, phone_mobile, phone_other,
           address_line1, address_city, address_postcode, occupancy_status,
           employment_status, security_question,
           (security_answer_hash IS NOT NULL) AS has_security_answer,
           contact_preferences, jurisdiction
      FROM clients WHERE id = ${clientId}`);
  return res.rows[0] ?? null;
}

export async function loadDebts(db: Database, caseId: string) {
  const res = await db.execute<Record<string, string | null> & {
    is_priority: boolean; is_joint: boolean; is_credit_agreement: boolean;
    in_dispute: boolean; is_statute_barred: boolean; included_in_solution: boolean;
  }>(sql`
    SELECT id, creditor_name, account_reference, customer_number, debt_type,
           is_priority, balance_pence::text, arrears_pence::text,
           contractual_payment_pence::text, is_joint, is_credit_agreement,
           in_dispute, is_statute_barred, included_in_solution, provenance, status
      FROM debts WHERE case_id = ${caseId} AND status <> 'removed'
     ORDER BY is_priority DESC, balance_pence DESC`);
  const debts = res.rows.map((r) => ({
    id: r['id']!, creditorName: r['creditor_name']!,
    accountReference: r['account_reference'] ?? null,
    customerNumber: r['customer_number'] ?? null,
    debtType: r['debt_type']!,
    isPriority: r.is_priority,
    balancePence: Number(r['balance_pence']),
    arrearsPence: Number(r['arrears_pence']),
    contractualPaymentPence: r['contractual_payment_pence'] == null
      ? null : Number(r['contractual_payment_pence']),
    isJoint: r.is_joint,
    isCreditAgreement: r.is_credit_agreement,
    inDispute: r.in_dispute,
    isStatuteBarred: r.is_statute_barred,
    includedInSolution: r.included_in_solution,
    provenance: r['provenance']!,
    status: r['status']!,
  }));
  return { debts, totals: totalsFor(debts) };
}

export { listAppointments, listAssets, listEmployment, listHouseholdMembers, listVerificationItems };

/**
 * Gathers the records evidence state is resolved from.
 *
 * Kept beside the other case file loaders rather than inside `loadCaseDetail`
 * because both the spine and Case Intelligence need it, and they must not be
 * allowed to answer "what is missing" differently.
 */
export async function loadEvidenceRecords(
  db: Database, caseId: string, clientId: string,
): Promise<EvidenceRecords> {
  const [items, consents, vulnerability, statement] = await Promise.all([
    db.execute<{ id: string; requirement_key: string; status: string;
                 method: string | null; expires_on: string | null }>(sql`
      SELECT id, requirement_key, status, method, expires_on::text
        FROM verification_items WHERE case_id = ${caseId}`),
    db.execute<{ id: string; purpose: string; granted: boolean; withdrawn_at: string | null }>(sql`
      SELECT id, purpose, granted, withdrawn_at::text
        FROM consents WHERE client_id = ${clientId}`),
    db.execute<{ id: string | null }>(sql`
      SELECT id FROM vulnerability_records
       WHERE client_id = ${clientId} AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`),
    db.execute<{ id: string; completed_at: string | null;
                 line_count: string; evidenced_count: string }>(sql`
      SELECT s.id, s.completed_at::text,
             count(l.id)::text AS line_count,
             count(l.id) FILTER (
               WHERE l.evidence_status IN ('document','open-banking')
             )::text AS evidenced_count
        FROM financial_statements s
        LEFT JOIN financial_statement_lines l ON l.statement_id = s.id
       WHERE s.case_id = ${caseId} AND s.status = 'current'
       GROUP BY s.id, s.completed_at
       ORDER BY s.id LIMIT 1`),
  ]);

  const s = statement.rows[0];
  return {
    verificationItems: items.rows.map((v) => ({
      id: v.id,
      requirementKey: v.requirement_key,
      status: v.status as EvidenceRecords['verificationItems'][number]['status'],
      method: v.method,
      expiresOn: v.expires_on,
    })),
    consents: consents.rows.map((c) => ({
      id: c.id, purpose: c.purpose, granted: c.granted, withdrawnAt: c.withdrawn_at,
    })),
    // An assessment recorded as "no indicators identified" is still an
    // assessment, and is what the record's presence means here.
    vulnerability: {
      assessed: vulnerability.rows.length > 0,
      recordId: vulnerability.rows[0]?.id ?? null,
    },
    statement: s
      ? { id: s.id, completedAt: s.completed_at,
          lineCount: Number(s.line_count), evidencedLineCount: Number(s.evidenced_count) }
      : null,
  };
}
