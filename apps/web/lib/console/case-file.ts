import { sql, type Database } from '@solvenda/db';
import {
  listAppointments, listAssets, listEmployment, listHouseholdMembers,
  listVerificationItems, totalsFor,
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
