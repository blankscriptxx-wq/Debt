import { sql, type Database } from '@solvenda/db';

/** Queries backing the list and oversight screens. */

export interface TaskRow {
  id: string; title: string; detail: string | null; priority: string; status: string;
  dueAt: string | null; caseId: string | null; caseReference: string | null;
  clientName: string | null; createdVia: string; overdue: boolean;
}

export async function listTasks(db: Database, options: { assignedTo?: string | null } = {}) {
  const res = await db.execute<Record<string, string | null> & { overdue: boolean }>(sql`
    SELECT t.id, t.title, t.detail, t.priority, t.status, t.due_at::text AS due_at,
           t.case_id, k.reference AS case_reference,
           c.first_name || ' ' || c.last_name AS client_name,
           t.created_via, (t.due_at IS NOT NULL AND t.due_at < now()) AS overdue
      FROM case_tasks t
      LEFT JOIN cases k ON k.id = t.case_id
      LEFT JOIN clients c ON c.id = t.client_id
     WHERE t.status IN ('open','in-progress','blocked')
       AND (${options.assignedTo ?? null}::uuid IS NULL
            OR t.assigned_to = ${options.assignedTo ?? null}::uuid)
     ORDER BY t.due_at NULLS LAST, t.created_at DESC
     LIMIT 200`);
  return res.rows.map((r) => ({
    id: r['id']!, title: r['title']!, detail: r['detail'] ?? null, priority: r['priority']!,
    status: r['status']!, dueAt: r['due_at'] ?? null, caseId: r['case_id'] ?? null,
    caseReference: r['case_reference'] ?? null, clientName: r['client_name'] ?? null,
    createdVia: r['created_via']!, overdue: r.overdue,
  })) satisfies TaskRow[];
}

export interface ApprovalRow {
  id: string; title: string; detail: string; requiredPermission: string;
  caseId: string | null; caseReference: string | null; clientName: string | null;
  dueAt: string | null; workflowName: string | null; regulated: boolean;
}

export async function listApprovals(db: Database) {
  const res = await db.execute<Record<string, string | null> & { regulated: boolean }>(sql`
    SELECT a.id, a.title, a.detail, a.required_permission, a.case_id,
           k.reference AS case_reference,
           c.first_name || ' ' || c.last_name AS client_name,
           a.due_at::text AS due_at, w.name AS workflow_name,
           coalesce(p.is_regulated, false) AS regulated
      FROM workflow_approvals a
      LEFT JOIN cases k ON k.id = a.case_id
      LEFT JOIN clients c ON c.id = k.client_id
      LEFT JOIN workflow_runs r ON r.id = a.run_id
      LEFT JOIN workflow_definitions w ON w.id = r.definition_id
      LEFT JOIN permissions p ON p.key = a.required_permission
     WHERE a.status = 'pending'
     ORDER BY a.due_at NULLS LAST
     LIMIT 100`);
  return res.rows.map((r) => ({
    id: r['id']!, title: r['title']!, detail: r['detail']!,
    requiredPermission: r['required_permission']!, caseId: r['case_id'] ?? null,
    caseReference: r['case_reference'] ?? null, clientName: r['client_name'] ?? null,
    dueAt: r['due_at'] ?? null, workflowName: r['workflow_name'] ?? null, regulated: r.regulated,
  })) satisfies ApprovalRow[];
}

export interface ComplianceSummary {
  regulatedActionsThisMonth: number;
  overriddenChecks: number;
  failingChecks: { ruleKey: string; count: number; severity: string }[];
  consentsWithdrawn: number;
  vulnerabilityByDriver: { driver: string; count: number }[];
  recentRegulatedActions: {
    id: string; action: string; actor: string; reason: string | null;
    occurredAt: string; caseReference: string | null;
  }[];
  chainVerified: boolean;
  chainDetail: string | null;
  chainEntries: number;
}

export async function loadCompliance(db: Database): Promise<ComplianceSummary> {
  const [counts, failing, drivers, recent, chain] = await Promise.all([
    db.execute<{ regulated: string; overridden: string; withdrawn: string }>(sql`
      SELECT (SELECT count(*) FROM audit_events
               WHERE severity = 'regulated'
                 AND occurred_at > date_trunc('month', now()))::text AS regulated,
             (SELECT count(*) FROM compliance_checks WHERE outcome = 'overridden')::text AS overridden,
             (SELECT count(*) FROM consents WHERE withdrawn_at IS NOT NULL)::text AS withdrawn`),
    db.execute<{ rule_key: string; n: string; severity: string }>(sql`
      SELECT rule_key, count(*)::text AS n, max(severity) AS severity
        FROM compliance_checks WHERE outcome = 'fail'
       GROUP BY rule_key ORDER BY count(*) DESC LIMIT 10`),
    db.execute<{ driver: string; n: string }>(sql`
      SELECT driver, count(*)::text AS n FROM vulnerability_records
       WHERE status = 'active' GROUP BY driver ORDER BY count(*) DESC`),
    db.execute<Record<string, string | null>>(sql`
      SELECT a.id, a.action, a.actor_label, a.reason, a.occurred_at::text, k.reference
        FROM audit_events a
        LEFT JOIN cases k ON k.id = a.case_id
       WHERE a.severity = 'regulated'
       ORDER BY a.seq DESC LIMIT 25`),
    db.execute<{ checked: string; ok: boolean; detail: string | null }>(sql`
      SELECT checked::text, ok, detail FROM app.verify_audit_chain(NULL)`),
  ]);

  const c = counts.rows[0]!;
  const chainRow = chain.rows[0];
  return {
    regulatedActionsThisMonth: Number(c.regulated),
    overriddenChecks: Number(c.overridden),
    consentsWithdrawn: Number(c.withdrawn),
    failingChecks: failing.rows.map((r) => ({
      ruleKey: r.rule_key, count: Number(r.n), severity: r.severity })),
    vulnerabilityByDriver: drivers.rows.map((r) => ({ driver: r.driver, count: Number(r.n) })),
    recentRegulatedActions: recent.rows.map((r) => ({
      id: r['id']!, action: r['action']!, actor: r['actor_label']!,
      reason: r['reason'] ?? null, occurredAt: r['occurred_at']!,
      caseReference: r['reference'] ?? null,
    })),
    chainVerified: chainRow?.ok ?? true,
    chainDetail: chainRow?.detail ?? null,
    chainEntries: Number(chainRow?.checked ?? 0),
  };
}

export interface AnalyticsSummary {
  casesByStage: { stage: string; count: number }[];
  casesByType: { caseType: string; count: number }[];
  solutionOutcomes: { solution: string; count: number }[];
  aiUsage: { capability: string; invocations: number; costPence: number; accepted: number;
             modified: number; rejected: number }[];
  workflowRuns: { workflow: string; completed: number; failed: number; waiting: number }[];
  commsByChannel: { channel: string; outbound: number; inbound: number }[];
  totalDebtPence: number;
  medianSurplusPence: number | null;
}

export async function loadAnalytics(db: Database): Promise<AnalyticsSummary> {
  const [stages, types, outcomes, ai, proposals, workflows, comms, money] = await Promise.all([
    db.execute<{ stage: string; n: string }>(sql`
      SELECT stage, count(*)::text AS n FROM cases WHERE status = 'open'
       GROUP BY stage ORDER BY count(*) DESC`),
    db.execute<{ case_type_key: string; n: string }>(sql`
      SELECT case_type_key, count(*)::text AS n FROM cases
       GROUP BY case_type_key ORDER BY count(*) DESC`),
    db.execute<{ recommended_case_type: string; n: string }>(sql`
      SELECT recommended_case_type, count(*)::text AS n FROM advice_decisions
       WHERE status = 'active' GROUP BY recommended_case_type ORDER BY count(*) DESC`),
    db.execute<{ capability_key: string; n: string; cost: string }>(sql`
      SELECT capability_key, count(*)::text AS n, coalesce(sum(cost_pence),0)::text AS cost
        FROM ai_invocations GROUP BY capability_key ORDER BY count(*) DESC`),
    db.execute<{ status: string; n: string }>(sql`
      SELECT status, count(*)::text AS n FROM ai_proposals GROUP BY status`),
    db.execute<{ definition_key: string; status: string; n: string }>(sql`
      SELECT definition_key, status, count(*)::text AS n FROM workflow_runs
       GROUP BY definition_key, status`),
    db.execute<{ channel: string; direction: string; n: string }>(sql`
      SELECT channel, direction, count(*)::text AS n FROM communications
       GROUP BY channel, direction`),
    db.execute<{ total_debt: string; median_surplus: string | null }>(sql`
      SELECT coalesce((SELECT sum(balance_pence) FROM debts WHERE status = 'active'), 0)::text AS total_debt,
             (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY surplus_pence)
                FROM financial_statements WHERE status = 'current')::text AS median_surplus`),
  ]);

  const proposalCounts = new Map(proposals.rows.map((r) => [r.status, Number(r.n)]));
  const workflowMap = new Map<string, { completed: number; failed: number; waiting: number }>();
  for (const row of workflows.rows) {
    const entry = workflowMap.get(row.definition_key) ?? { completed: 0, failed: 0, waiting: 0 };
    if (row.status === 'completed') entry.completed += Number(row.n);
    else if (row.status === 'failed') entry.failed += Number(row.n);
    else entry.waiting += Number(row.n);
    workflowMap.set(row.definition_key, entry);
  }
  const commsMap = new Map<string, { outbound: number; inbound: number }>();
  for (const row of comms.rows) {
    const entry = commsMap.get(row.channel) ?? { outbound: 0, inbound: 0 };
    if (row.direction === 'outbound') entry.outbound += Number(row.n);
    else entry.inbound += Number(row.n);
    commsMap.set(row.channel, entry);
  }

  const m = money.rows[0]!;
  return {
    casesByStage: stages.rows.map((r) => ({ stage: r.stage, count: Number(r.n) })),
    casesByType: types.rows.map((r) => ({ caseType: r.case_type_key, count: Number(r.n) })),
    solutionOutcomes: outcomes.rows.map((r) => ({
      solution: r.recommended_case_type, count: Number(r.n) })),
    aiUsage: ai.rows.map((r) => ({
      capability: r.capability_key, invocations: Number(r.n), costPence: Number(r.cost),
      accepted: proposalCounts.get('accepted') ?? 0,
      modified: proposalCounts.get('modified') ?? 0,
      rejected: proposalCounts.get('rejected') ?? 0,
    })),
    workflowRuns: [...workflowMap].map(([workflow, v]) => ({ workflow, ...v })),
    commsByChannel: [...commsMap].map(([channel, v]) => ({ channel, ...v })),
    totalDebtPence: Number(m.total_debt),
    medianSurplusPence: m.median_surplus === null ? null : Math.round(Number(m.median_surplus)),
  };
}
