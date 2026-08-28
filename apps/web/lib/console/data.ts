import { sql, type Database } from '@solvenda/db';
import {
  composeCaseIntelligence, CASE_TYPE_TEMPLATES, DEFAULT_THRESHOLD_CONFIG,
  parseCaseTypeDefinition, resolveEvidenceState, evidenceMap,
  type CaseIntelligence, type CaseSnapshot, type DebtSnapshot, type ResolvedEvidence,
} from '@solvenda/core';
import { loadEvidenceRecords } from './case-file.js';
import { pendingProposals } from '@solvenda/ai';
import { caseTimeline, engagementSummary, type TimelineEntry } from '@solvenda/comms';

export interface CaseListRow {
  id: string;
  reference: string;
  clientName: string;
  caseTypeKey: string;
  stage: string;
  status: string;
  ownerName: string | null;
  totalDebtPence: number;
  surplusPence: number | null;
  nextReviewDue: string | null;
  openTasks: number;
  vulnerabilityCount: number;
}

export async function listCases(db: Database, options: {
  ownerId?: string | null; search?: string; limit?: number;
} = {}): Promise<CaseListRow[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const search = options.search?.trim() ? `%${options.search.trim()}%` : null;

  const res = await db.execute<{
    id: string; reference: string; client_name: string; case_type_key: string;
    stage: string; status: string; owner_name: string | null;
    total_debt: string; surplus: string | null; next_review_due: string | null;
    open_tasks: string; vulnerability_count: string;
  }>(sql`
    SELECT k.id, k.reference,
           c.first_name || ' ' || c.last_name AS client_name,
           k.case_type_key, k.stage, k.status,
           u.full_name AS owner_name,
           coalesce((SELECT sum(balance_pence) FROM debts d
                      WHERE d.case_id = k.id AND d.status = 'active'), 0)::text AS total_debt,
           (SELECT surplus_pence FROM financial_statements fs
             WHERE fs.case_id = k.id AND fs.status = 'current')::text AS surplus,
           k.next_review_due::text,
           (SELECT count(*) FROM case_tasks t
             WHERE t.case_id = k.id AND t.status IN ('open','in-progress'))::text AS open_tasks,
           (SELECT count(*) FROM vulnerability_records v
             WHERE v.client_id = c.id AND v.status = 'active')::text AS vulnerability_count
      FROM cases k
      JOIN clients c ON c.id = k.client_id
      LEFT JOIN users u ON u.id = k.owner_user_id
     WHERE k.status <> 'closed'
       AND (${options.ownerId ?? null}::uuid IS NULL OR k.owner_user_id = ${options.ownerId ?? null}::uuid)
       AND (${search}::text IS NULL
            OR k.reference ILIKE ${search}
            OR (c.first_name || ' ' || c.last_name) ILIKE ${search}
            OR c.address_postcode ILIKE ${search})
     ORDER BY k.next_review_due NULLS LAST, k.opened_at DESC
     LIMIT ${limit}`);

  return res.rows.map((r) => ({
    id: r.id, reference: r.reference, clientName: r.client_name,
    caseTypeKey: r.case_type_key, stage: r.stage, status: r.status,
    ownerName: r.owner_name,
    totalDebtPence: Number(r.total_debt),
    surplusPence: r.surplus === null ? null : Number(r.surplus),
    nextReviewDue: r.next_review_due,
    openTasks: Number(r.open_tasks),
    vulnerabilityCount: Number(r.vulnerability_count),
  }));
}

export interface CaseDetail {
  intelligence: CaseIntelligence;
  /** Every requirement the case type declares, with how well it is met. */
  evidence: ResolvedEvidence[];
  /** The current statement, which advice cannot be recorded without. */
  statementId: string | null;
  reference: string;
  clientName: string;
  clientId: string;
  caseTypeName: string;
  ownerName: string | null;
  timeline: TimelineEntry[];
  proposals: Awaited<ReturnType<typeof pendingProposals>>;
  tasks: { id: string; title: string; dueAt: string | null; priority: string; status: string }[];
  debts: { id: string; creditorName: string; balancePence: number; isPriority: boolean;
           provenance: string; status: string }[];
}

/**
 * Assembles a case for the intelligence view.
 *
 * Deliberately one function: the value of Case Intelligence is that an adviser
 * gets the whole picture in one place, and that is only true if the page
 * fetches the whole picture rather than lazily filling in panels.
 */
export async function loadCaseDetail(db: Database, caseId: string): Promise<CaseDetail | null> {
  const head = await db.execute<{
    id: string; reference: string; case_type_key: string; case_type_version: number;
    stage: string; jurisdiction: string; client_id: string; owner_name: string | null;
    client_name: string; first_name: string; household_adults: number;
    household_children: number; employment_status: string | null;
    date_of_birth: string | null; client_jurisdiction: string;
    stage_entered_at: string; months_since_review: string | null;
  }>(sql`
    SELECT k.id, k.reference, k.case_type_key, k.case_type_version, k.stage, k.jurisdiction,
           k.client_id, u.full_name AS owner_name,
           c.first_name || ' ' || c.last_name AS client_name, c.first_name,
           c.household_adults, c.household_children, c.employment_status,
           c.date_of_birth::text, c.jurisdiction AS client_jurisdiction,
           k.stage_entered_at::text,
           -- extract(month FROM age(...)) yields the month *component* of the
           -- interval, so a statement 13 months old reported as 1. Total months
           -- is years * 12 + months.
           (SELECT ((extract(year FROM age(now(), max(fs.completed_at))) * 12)
                    + extract(month FROM age(now(), max(fs.completed_at))))::int::text
              FROM financial_statements fs WHERE fs.case_id = k.id) AS months_since_review
      FROM cases k
      JOIN clients c ON c.id = k.client_id
      LEFT JOIN users u ON u.id = k.owner_user_id
     WHERE k.id = ${caseId}`);

  const row = head.rows[0];
  if (!row) return null;

  const debtRows = await db.execute<{
    id: string; creditor_name: string; balance_pence: string; arrears_pence: string;
    debt_type: string; is_priority: boolean; is_joint: boolean; in_dispute: boolean;
    is_statute_barred: boolean; included_in_solution: boolean; creditor_id: string | null;
    status: string; provenance: string;
  }>(sql`SELECT * FROM debts WHERE case_id = ${caseId} ORDER BY balance_pence DESC`);

  const debts: DebtSnapshot[] = debtRows.rows.map((d) => ({
    id: d.id, balancePence: Number(d.balance_pence), arrearsPence: Number(d.arrears_pence),
    debtType: d.debt_type, isPriority: d.is_priority, isJoint: d.is_joint,
    inDispute: d.in_dispute, isStatuteBarred: d.is_statute_barred,
    includedInSolution: d.included_in_solution, creditorId: d.creditor_id,
    creditorName: d.creditor_name, status: d.status,
  }));

  const statements = await db.execute<{
    id: string;
    total_income_pence: string; total_expenditure_pence: string; surplus_pence: string;
    completed_at: string | null; status: string; version: number;
  }>(sql`
    SELECT id, total_income_pence::text, total_expenditure_pence::text, surplus_pence::text,
           completed_at::text, status, version
      FROM financial_statements WHERE case_id = ${caseId} ORDER BY version DESC LIMIT 2`);

  const current = statements.rows.find((s) => s.status === 'current') ?? statements.rows[0] ?? null;
  const previous = statements.rows[1] ?? null;

  const affordability = await db.execute<{ sustainable_payment_pence: string; contingency_pence: string }>(
    sql`SELECT sustainable_payment_pence::text, contingency_pence::text
          FROM affordability_assessments WHERE case_id = ${caseId}
         ORDER BY assessed_at DESC LIMIT 1`);

  const vulnerability = await db.execute<{ n: string; drivers: string[]; severity: string | null }>(sql`
    SELECT count(*)::text AS n,
           coalesce(array_agg(DISTINCT driver), '{}') AS drivers,
           max(severity) AS severity
      FROM vulnerability_records WHERE client_id = ${row.client_id} AND status = 'active'`);

  const taskRows = await db.execute<{
    id: string; title: string; due_at: string | null; status: string;
    priority: string; assigned_to: string | null;
  }>(sql`
    SELECT id, title, due_at::text, status, priority, assigned_to
      FROM case_tasks WHERE case_id = ${caseId} ORDER BY due_at NULLS LAST`);

  const complianceRows = await db.execute<{
    id: string; rule_key: string; severity: string; detail: string | null;
  }>(sql`
    SELECT id, rule_key, severity, detail FROM compliance_checks
     WHERE case_id = ${caseId} AND outcome = 'fail'`);

  const proposals = await pendingProposals(db, caseId);
  const engagement = await engagementSummary(db, row.client_id);
  const timeline = await caseTimeline(db, caseId, { limit: 40 });

  const caseTypeRow = await db.execute<{ definition: unknown }>(sql`
    SELECT definition FROM case_type_definitions
     WHERE key = ${row.case_type_key} AND status = 'active'
     ORDER BY version DESC LIMIT 1`);

  const caseType = caseTypeRow.rows[0]
    ? parseCaseTypeDefinition(caseTypeRow.rows[0].definition)
    : CASE_TYPE_TEMPLATES.find((t) => t.key === row.case_type_key) ?? CASE_TYPE_TEMPLATES[0]!;

  // Evidence is resolved from the case's own records against the requirements
  // the case type declares. It used to be read from the consents table alone,
  // which meant "identity verified" and "statement complete" could only be true
  // if someone wrote them as consents — and only the seed ever did.
  const evidenceRecords = await loadEvidenceRecords(db, caseId, row.client_id);
  const resolvedEvidence = resolveEvidenceState(caseType, row.stage, evidenceRecords);
  const evidence = evidenceMap(resolvedEvidence);

  const snapshot: CaseSnapshot = {
    caseId: row.id,
    caseTypeKey: row.case_type_key,
    stage: row.stage,
    jurisdiction: row.jurisdiction as CaseSnapshot['jurisdiction'],
    monthsSinceLastReview: row.months_since_review === null ? null : Number(row.months_since_review),
    client: {
      id: row.client_id,
      jurisdiction: row.client_jurisdiction as CaseSnapshot['jurisdiction'],
      householdAdults: row.household_adults,
      householdChildren: row.household_children,
      employmentStatus: row.employment_status,
      dateOfBirth: row.date_of_birth,
    },
    debts,
    statement: current ? {
      totalIncomePence: Number(current.total_income_pence),
      totalExpenditurePence: Number(current.total_expenditure_pence),
      surplusPence: Number(current.surplus_pence),
      completedAt: current.completed_at,
    } : null,
    affordability: affordability.rows[0] ? {
      sustainablePaymentPence: Number(affordability.rows[0].sustainable_payment_pence),
      contingencyPence: Number(affordability.rows[0].contingency_pence),
    } : null,
    assets: {
      totalPence: 0, realisablePence: 0, vehicleValuePence: 0,
      vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0,
    },
    history: {
      hasActiveInsolvency: false, hasPriorInsolvency: false,
      priorInsolvencyDisclosed: false, monthsSinceBreathingSpace: null, monthsSinceDmp: null,
    },
    vulnerability: {
      activeRecordCount: Number(vulnerability.rows[0]?.n ?? 0),
      drivers: vulnerability.rows[0]?.drivers ?? [],
      highestSeverity: vulnerability.rows[0]?.severity ?? null,
    },
    evidence,
    attributes: { stageEnteredAt: row.stage_entered_at },
  };

  const intelligence = composeCaseIntelligence({
    snapshot,
    caseType,
    caseTypes: CASE_TYPE_TEMPLATES,
    thresholdConfig: DEFAULT_THRESHOLD_CONFIG,
    previousStatement: previous ? {
      surplusPence: Number(previous.surplus_pence),
      totalIncomePence: Number(previous.total_income_pence),
      totalExpenditurePence: Number(previous.total_expenditure_pence),
      completedAt: previous.completed_at ?? '',
    } : null,
    tasks: taskRows.rows.map((t) => ({
      id: t.id, title: t.title, dueAt: t.due_at, status: t.status,
      priority: t.priority, assignedTo: t.assigned_to,
    })),
    complianceFailures: complianceRows.rows.map((c) => ({
      id: c.id, ruleKey: c.rule_key, severity: c.severity, detail: c.detail,
    })),
    pendingProposals: proposals.map((p) => ({
      id: p.id, proposalType: p.proposalType,
      touchesRegulatedField: p.touchesRegulatedField,
      confidence: p.confidence, reasoning: p.reasoning,
    })),
    engagement,
  });

  return {
    intelligence,
    evidence: resolvedEvidence,
    statementId: current?.id ?? null,
    reference: row.reference,
    clientName: row.client_name,
    clientId: row.client_id,
    caseTypeName: caseType.name,
    ownerName: row.owner_name,
    timeline,
    proposals,
    tasks: taskRows.rows.map((t) => ({
      id: t.id, title: t.title, dueAt: t.due_at, priority: t.priority, status: t.status,
    })),
    debts: debtRows.rows.map((d) => ({
      id: d.id, creditorName: d.creditor_name, balancePence: Number(d.balance_pence),
      isPriority: d.is_priority, provenance: d.provenance, status: d.status,
    })),
  };
}

export interface DashboardData {
  openCases: number;
  casesNeedingAttention: number;
  overdueReviews: number;
  openTasks: number;
  overdueTasks: number;
  pendingApprovals: number;
  regulatedProposals: number;
  recentCases: CaseListRow[];
}

export async function loadDashboard(db: Database, userId: string): Promise<DashboardData> {
  const counts = await db.execute<Record<string, string>>(sql`
    SELECT
      (SELECT count(*) FROM cases WHERE status = 'open')::text AS open_cases,
      (SELECT count(*) FROM cases WHERE status = 'open' AND next_review_due < current_date)::text AS overdue_reviews,
      (SELECT count(*) FROM case_tasks WHERE status IN ('open','in-progress'))::text AS open_tasks,
      (SELECT count(*) FROM case_tasks
        WHERE status IN ('open','in-progress') AND due_at < now())::text AS overdue_tasks,
      (SELECT count(*) FROM workflow_approvals WHERE status = 'pending')::text AS pending_approvals,
      (SELECT count(*) FROM ai_proposals
        WHERE status = 'pending' AND touches_regulated_field)::text AS regulated_proposals,
      (SELECT count(DISTINCT case_id) FROM compliance_checks
        WHERE outcome = 'fail' AND severity = 'blocking')::text AS attention`);

  const row = counts.rows[0]!;
  const recentCases = await listCases(db, { ownerId: userId, limit: 8 });

  return {
    openCases: Number(row['open_cases']),
    casesNeedingAttention: Number(row['attention']),
    overdueReviews: Number(row['overdue_reviews']),
    openTasks: Number(row['open_tasks']),
    overdueTasks: Number(row['overdue_tasks']),
    pendingApprovals: Number(row['pending_approvals']),
    regulatedProposals: Number(row['regulated_proposals']),
    recentCases,
  };
}
