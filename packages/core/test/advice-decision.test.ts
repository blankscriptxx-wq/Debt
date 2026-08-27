import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, type Database } from '@solvenda/db';
import { createTestTenant, expectDbError, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { aiPrincipal, workflowPrincipal, PermissionDeniedError, seedGlobalCatalogues, type Principal } from '@solvenda/auth';
import {
  recordAdviceDecision, supersedeAdviceDecision, AdviceValidationError,
  evaluateEligibility, CASE_TYPE_TEMPLATES, DEFAULT_THRESHOLD_CONFIG,
  type CaseSnapshot, type EligibilityResult,
} from '@solvenda/core';

let tenant: TestTenant;
let clientId: string;
let caseId: string;
let statementId: string;
let evaluationId: string;
let eligibility: EligibilityResult;

function adviser(overrides: Partial<Extract<Principal, { kind: 'user' }>> = {}): Principal {
  return {
    kind: 'user',
    tenantId: tenant.id,
    userId: tenant.userId,
    permissions: new Set(['advice:decide', 'advice:supersede', 'case:read']),
    competencies: ['debt-advice'],
    mfaSatisfied: true,
    status: 'active',
    ...overrides,
  };
}

const RATIONALE =
  'Client has a sustainable surplus of £220 and eight non-priority creditors totalling £14,200. ' +
  'A DMP keeps flexibility while she is in a temporary reduced-hours arrangement.';

function baseInput() {
  return {
    caseId, clientId,
    recommendedCaseType: 'dmp',
    rationale: RATIONALE,
    optionsConsidered: ['dmp', 'iva', 'dro'],
    rejectedOptions: [
      { caseTypeKey: 'iva', reason: 'Client wishes to avoid a formal insolvency while hours may recover.' },
      { caseTypeKey: 'dro', reason: 'Surplus income of £220 is well above the DRO limit.' },
    ],
    risksExplained: [
      'Interest and charges may not be frozen by every creditor.',
      'The plan is informal and creditors may still pursue enforcement.',
    ],
    statementId, eligibilityEvaluationId: evaluationId,
    clientResponse: 'accepted' as const,
  };
}

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('advice');

  const ids = await tenant.as(async (db: Database) => {
    const client = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, jurisdiction, household_adults)
      VALUES ('CL-0001', 'Joanne', 'Whitfield', 'england-wales', 1) RETURNING id`);
    const clientRow = client.rows[0]!.id;

    const kase = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
      VALUES ('DMP-0001', ${clientRow}, 'dmp', 1, 'advice', ${tenant.userId}) RETURNING id`);
    const caseRow = kase.rows[0]!.id;

    const statement = await db.execute<{ id: string }>(sql`
      INSERT INTO financial_statements
        (case_id, client_id, version, status, total_income_pence, total_expenditure_pence,
         surplus_pence, total_debt_pence, completed_by, completed_at)
      VALUES (${caseRow}, ${clientRow}, 1, 'current', 198000, 176000, 22000, 1420000,
              ${tenant.userId}, now())
      RETURNING id`);

    return { clientRow, caseRow, statementRow: statement.rows[0]!.id };
  });

  clientId = ids.clientRow;
  caseId = ids.caseRow;
  statementId = ids.statementRow;

  const snapshot: CaseSnapshot = {
    caseId, caseTypeKey: 'dmp', stage: 'advice', jurisdiction: 'england-wales',
    monthsSinceLastReview: null,
    client: { id: clientId, jurisdiction: 'england-wales', householdAdults: 1,
              householdChildren: 0, employmentStatus: 'employed', dateOfBirth: '1985-03-12' },
    debts: Array.from({ length: 8 }, (_, i) => ({
      id: crypto.randomUUID(), balancePence: 177_500, arrearsPence: 0, debtType: 'unsecured',
      isPriority: false, isJoint: false, inDispute: false, isStatuteBarred: false,
      includedInSolution: true, creditorId: crypto.randomUUID(),
      creditorName: `Creditor ${i}`, status: 'active',
    })),
    statement: { totalIncomePence: 198_000, totalExpenditurePence: 176_000,
                 surplusPence: 22_000, completedAt: new Date().toISOString() },
    affordability: { sustainablePaymentPence: 22_000, contingencyPence: 0 },
    assets: { totalPence: 0, realisablePence: 0, vehicleValuePence: 0,
              vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0 },
    history: { hasActiveInsolvency: false, hasPriorInsolvency: false,
               priorInsolvencyDisclosed: false, monthsSinceBreathingSpace: null, monthsSinceDmp: null },
    vulnerability: { activeRecordCount: 0, drivers: [], highestSeverity: null },
    evidence: {}, attributes: {},
  };

  eligibility = evaluateEligibility({
    snapshot, caseTypes: CASE_TYPE_TEMPLATES, thresholdConfig: DEFAULT_THRESHOLD_CONFIG });

  evaluationId = await tenant.as(async (db) => {
    const r = await db.execute<{ id: string }>(sql`
      INSERT INTO eligibility_evaluations (case_id, statement_id, facts, results, ruleset_fingerprint, evaluated_by)
      VALUES (${caseId}, ${statementId}, ${JSON.stringify(eligibility.facts)}::jsonb,
              ${JSON.stringify(eligibility.assessments)}::jsonb,
              ${eligibility.rulesetFingerprint}, ${tenant.userId})
      RETURNING id`);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closeDatabase(); });

describe('only a person can record regulated advice', () => {
  it('refuses an AI principal', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, aiPrincipal(tenant.id, 'advice-rationale', crypto.randomUUID()),
        baseInput(), eligibility)),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('refuses a workflow, even one explicitly granted the permission', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, workflowPrincipal(tenant.id, 'run-1', ['advice:decide']),
        baseInput(), eligibility)),
    ).rejects.toThrow(/can only be exercised by an authenticated person/);
  });

  it('refuses an API key holding the permission', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context,
        { kind: 'api_key', tenantId: tenant.id, keyId: 'k1', scopes: new Set(['advice:decide']) },
        baseInput(), eligibility)),
    ).rejects.toThrow(/can only be exercised by an authenticated person/);
  });

  it('refuses an adviser without the competency sign-off', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser({ competencies: [] }), baseInput(), eligibility)),
    ).rejects.toThrow(/competency sign-off/);
  });

  it('refuses an adviser who has not completed a second factor', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser({ mfaSatisfied: false }), baseInput(), eligibility)),
    ).rejects.toThrow(/second factor/);
  });

  it('leaves no partial record behind after a refusal', async () => {
    const count = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM advice_decisions WHERE case_id = ${caseId}`);
      return Number(r.rows[0]!.n);
    });
    expect(count).toBe(0);
  });
});

describe('the evidence a decision must rest on', () => {
  it('requires a financial statement', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(), { ...baseInput(), statementId: null }, eligibility)),
    ).rejects.toThrow(/current financial statement is required/);
  });

  it('requires an eligibility evaluation', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(), { ...baseInput(), eligibilityEvaluationId: null }, eligibility)),
    ).rejects.toThrow(/eligibility evaluation is required/);
  });

  it('requires a rationale of substance', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(), { ...baseInput(), rationale: 'DMP' }, eligibility)),
    ).rejects.toThrow(/rationale of at least/);
  });

  it('requires a reason for every option considered and not chosen', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(),
        { ...baseInput(), rejectedOptions: [
          { caseTypeKey: 'iva', reason: 'Client wishes to avoid formal insolvency for now.' }] },
        eligibility)),
    ).rejects.toThrow(/option "dro" was considered but no reason for rejecting it was recorded/);
  });

  it('rejects a reason too brief to mean anything', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(),
        { ...baseInput(), rejectedOptions: [
          { caseTypeKey: 'iva', reason: 'no' }, { caseTypeKey: 'dro', reason: 'no' }] },
        eligibility)),
    ).rejects.toThrow(/too brief to be meaningful/);
  });

  it('requires the recommendation to be among the options considered', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(
        db, tenant.context, adviser(),
        { ...baseInput(), recommendedCaseType: 'bankruptcy' }, eligibility)),
    ).rejects.toThrow(AdviceValidationError);
  });
});

describe('recording a decision', () => {
  it('records it with the adviser, the evidence and the alternatives', async () => {
    const result = await tenant.as((db) =>
      recordAdviceDecision(db, tenant.context, adviser(), baseInput(), eligibility));

    expect(result.departedFromEligibility).toBe(false);

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM advice_decisions WHERE id = ${result.id}`);
      return r.rows[0]!;
    });

    expect(row['decided_by']).toBe(tenant.userId);
    expect(row['decided_by_competencies']).toEqual(['debt-advice']);
    expect(row['recommended_case_type']).toBe('dmp');
    expect(row['statement_id']).toBe(statementId);
    expect(row['ai_contribution']).toBe('none');
    expect(row['status']).toBe('active');
  });

  it('writes an audit entry marked as regulated, carrying the rationale', async () => {
    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT action, severity, reason, actor_user_id, after_state
          FROM audit_events WHERE action = 'advice.decision.recorded' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['severity']).toBe('regulated');
    expect(event['reason']).toContain('sustainable surplus');
    expect(event['actor_user_id']).toBe(tenant.userId);
    expect((event['after_state'] as Record<string, unknown>)['optionsConsidered'])
      .toEqual(['dmp', 'iva', 'dro']);
  });

  it('refuses a second active decision on the same case', async () => {
    await expect(
      tenant.as((db) => recordAdviceDecision(db, tenant.context, adviser(), baseInput(), eligibility)),
    ).rejects.toThrow(/already has an active advice decision/);
  });

  it('will not let the substance of a recorded decision be edited', async () => {
    await expectDbError(
      tenant.as((db) => db.execute(sql`
        UPDATE advice_decisions SET rationale = 'something else entirely'
         WHERE case_id = ${caseId} AND status = 'active'`)),
      /substance of an advice decision is immutable/,
    );
  });

  it('will not let a decision be deleted', async () => {
    await expectDbError(
      tenant.as((db) => db.execute(sql`DELETE FROM advice_decisions WHERE case_id = ${caseId}`)),
      /cannot be deleted/,
    );
  });
});

describe('departing from the eligibility engine', () => {
  it('refuses a solution the rules ruled out unless the departure is explained', async () => {
    const other = await createTestTenant('advice-departure');
    const setup = await other.as(async (db) => {
      const c = await db.execute<{ id: string }>(sql`
        INSERT INTO clients (reference, first_name, last_name) VALUES ('CL-1','A','B') RETURNING id`);
      const k = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage)
        VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'advice') RETURNING id`);
      const s = await db.execute<{ id: string }>(sql`
        INSERT INTO financial_statements (case_id, client_id, version, status)
        VALUES (${k.rows[0]!.id}, ${c.rows[0]!.id}, 1, 'current') RETURNING id`);
      const e = await db.execute<{ id: string }>(sql`
        INSERT INTO eligibility_evaluations (case_id, facts, results, ruleset_fingerprint)
        VALUES (${k.rows[0]!.id}, '{}'::jsonb, '[]'::jsonb, 'x') RETURNING id`);
      return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id,
               statementId: s.rows[0]!.id, evaluationId: e.rows[0]!.id };
    });

    const principal: Principal = { ...adviser(), tenantId: other.id, userId: other.userId };
    const input = {
      caseId: setup.caseId, clientId: setup.clientId,
      recommendedCaseType: 'dro',
      rationale: 'Client presentation suggests a DRO despite the recorded surplus figure being stale.',
      optionsConsidered: ['dro', 'dmp'],
      rejectedOptions: [{ caseTypeKey: 'dmp', reason: 'Client cannot sustain payments for the required term.' }],
      risksExplained: [],
      statementId: setup.statementId,
      eligibilityEvaluationId: setup.evaluationId,
    };

    await expect(
      other.as((db) => recordAdviceDecision(db, other.context, principal, input, eligibility)),
    ).rejects.toThrow(/Advising it anyway requires an override reason/);

    // With a stated reason it is permitted, and the departure is recorded.
    const result = await other.as((db) => recordAdviceDecision(
      db, other.context, principal,
      { ...input, overrideReason: 'Surplus figure predates a confirmed reduction in working hours; recalculation is in progress.' },
      eligibility));

    expect(result.departedFromEligibility).toBe(true);

    const event = await other.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT reason, after_state FROM audit_events
         WHERE action = 'advice.decision.recorded' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['reason']).toContain('departure from eligibility');
    expect((event['after_state'] as Record<string, unknown>)['departedFromEligibility']).toBe(true);
  });
});

describe('superseding', () => {
  it('replaces a decision without altering the original', async () => {
    const replacement = {
      ...baseInput(),
      recommendedCaseType: 'iva',
      rationale: 'Hours reduction is now permanent and the surplus supports an IVA over a 60 month term.',
      optionsConsidered: ['iva', 'dmp'],
      rejectedOptions: [{ caseTypeKey: 'dmp', reason: 'Term would exceed 20 years at the reduced surplus.' }],
    };

    const previous = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM advice_decisions WHERE case_id = ${caseId} AND status = 'active'`);
      return r.rows[0]!.id;
    });

    const result = await tenant.as((db) => supersedeAdviceDecision(
      db, tenant.context, adviser(),
      { previousDecisionId: previous,
        reason: 'Client hours reduction confirmed as permanent; original advice no longer suitable.',
        replacement },
      eligibility));

    const rows = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT id, status, recommended_case_type, rationale, superseded_by, supersede_reason
          FROM advice_decisions WHERE case_id = ${caseId} ORDER BY decided_at`);
      return r.rows;
    });

    expect(rows).toHaveLength(2);
    const [original, current] = rows;
    expect(original!['status']).toBe('superseded');
    // The original wording is intact - the file shows what was said at the time.
    expect(original!['rationale']).toBe(RATIONALE);
    expect(original!['recommended_case_type']).toBe('dmp');
    expect(original!['superseded_by']).toBe(result.id);
    expect(current!['status']).toBe('active');
    expect(current!['recommended_case_type']).toBe('iva');
  });

  it('requires a reason explaining what changed', async () => {
    const active = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM advice_decisions WHERE case_id = ${caseId} AND status = 'active'`);
      return r.rows[0]!.id;
    });
    await expect(
      tenant.as((db) => supersedeAdviceDecision(
        db, tenant.context, adviser(),
        { previousDecisionId: active, reason: 'changed', replacement: baseInput() },
        eligibility)),
    ).rejects.toThrow(/reason of at least 20 characters/);
  });
});
