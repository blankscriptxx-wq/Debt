import { describe, expect, it } from 'vitest';
import {
  composeCaseIntelligence, assessHealth, signal,
  CASE_TYPE_TEMPLATES, DEFAULT_THRESHOLD_CONFIG,
  type CaseSnapshot, type DebtSnapshot, type IntelligenceInput, type Signal,
} from '@solvenda/core';

const DMP = CASE_TYPE_TEMPLATES.find((t) => t.key === 'dmp')!;
const NOW = new Date('2026-08-27T10:00:00Z');

function debt(overrides: Partial<DebtSnapshot> = {}): DebtSnapshot {
  return {
    id: crypto.randomUUID(), balancePence: 200_000, arrearsPence: 0, debtType: 'unsecured',
    isPriority: false, isJoint: false, inDispute: false, isStatuteBarred: false,
    includedInSolution: true, creditorId: crypto.randomUUID(), creditorName: 'Creditor',
    status: 'active', ...overrides,
  };
}

function snapshot(overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: crypto.randomUUID(), caseTypeKey: 'dmp', stage: 'live',
    jurisdiction: 'england-wales', monthsSinceLastReview: 3,
    client: { id: crypto.randomUUID(), jurisdiction: 'england-wales', householdAdults: 1,
              householdChildren: 0, employmentStatus: 'employed', dateOfBirth: '1985-03-12' },
    debts: [debt(), debt(), debt()],
    statement: { totalIncomePence: 198_000, totalExpenditurePence: 176_000,
                 surplusPence: 22_000, completedAt: '2026-06-01' },
    affordability: { sustainablePaymentPence: 22_000, contingencyPence: 0 },
    assets: { totalPence: 0, realisablePence: 0, vehicleValuePence: 0,
              vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0 },
    history: { hasActiveInsolvency: false, hasPriorInsolvency: false,
               priorInsolvencyDisclosed: false, monthsSinceBreathingSpace: null, monthsSinceDmp: null },
    vulnerability: { activeRecordCount: 0, drivers: [], highestSeverity: null },
    evidence: {}, attributes: {},
    ...overrides,
  };
}

function compose(overrides: Partial<IntelligenceInput> = {}) {
  return composeCaseIntelligence({
    snapshot: snapshot(),
    caseType: DMP,
    caseTypes: CASE_TYPE_TEMPLATES,
    thresholdConfig: DEFAULT_THRESHOLD_CONFIG,
    now: NOW,
    ...overrides,
  });
}

describe('case health', () => {
  it('reports a healthy case with no concerns', () => {
    const intel = compose();
    expect(intel.health.band).toBe('healthy');
    expect(intel.health.score).toBe(100);
    expect(intel.health.summary).toBe('No concerns identified on this case.');
  });

  it('always exposes the drivers behind the score', () => {
    // A composite number is only useful if it can be taken apart.
    const intel = compose({
      payments: { expectedMonthlyPence: 22_000, lastPaymentPence: null,
                  lastPaymentAt: null, missedCount: 3, arrearsPence: 66_000 },
    });
    expect(intel.health.score).toBeLessThan(100);
    expect(intel.health.drivers.length).toBeGreaterThan(0);
    expect(intel.health.drivers[0]!.title).toMatch(/payments missed/i);
    expect(intel.health.drivers[0]!.sources.length).toBeGreaterThan(0);
  });

  it('bands the score', () => {
    expect(assessHealth([]).band).toBe('healthy');
    expect(assessHealth([signal({ key: 'a', category: 'payment', severity: 'attention',
      title: 'A', detail: '', sources: [], suggestedAction: null })]).band).toBe('healthy');
    const critical: Signal[] = Array.from({ length: 2 }, (_, i) => signal({
      key: `c${i}`, category: 'compliance', severity: 'critical',
      title: 'C', detail: '', sources: [], suggestedAction: null }));
    expect(assessHealth(critical).band).toBe('at-risk');
  });

  it('does not penalise a case for the client being vulnerable', () => {
    // Ranking cases by their clients' difficulties would be exactly wrong.
    const intel = compose({
      snapshot: snapshot({
        vulnerability: { activeRecordCount: 2, drivers: ['health', 'resilience'],
                         highestSeverity: 'significant' },
      }),
    });
    expect(intel.health.score).toBe(100);
    // The signal is still raised, prominently.
    const v = intel.signals.find((s) => s.key === 'vulnerability-recorded')!;
    expect(v.severity).toBe('urgent');
    expect(v.suggestedAction).toMatch(/support needs/);
  });
});

describe('signals', () => {
  it('flags a deficit budget as urgent', () => {
    const intel = compose({
      snapshot: snapshot({
        statement: { totalIncomePence: 150_000, totalExpenditurePence: 176_000,
                     surplusPence: -26_000, completedAt: '2026-06-01' },
      }),
    });
    const s = intel.signals.find((x) => x.key === 'deficit-budget')!;
    expect(s.severity).toBe('urgent');
    expect(s.detail).toContain('£260.00');
  });

  it('detects a material fall in affordability against the previous statement', () => {
    const intel = compose({
      previousStatement: { surplusPence: 45_000, totalIncomePence: 210_000,
                           totalExpenditurePence: 165_000, completedAt: '2026-02-01' },
    });
    const s = intel.signals.find((x) => x.key === 'affordability-changed')!;
    expect(s.severity).toBe('urgent');
    expect(s.title).toMatch(/fallen/);
    expect(s.detail).toContain('£450.00');
    expect(s.detail).toContain('£220.00');
    expect(s.sources).toHaveLength(2);
  });

  it('treats an improvement as worth noting but not urgent', () => {
    const intel = compose({
      previousStatement: { surplusPence: 10_000, totalIncomePence: 180_000,
                           totalExpenditurePence: 170_000, completedAt: '2026-02-01' },
    });
    const s = intel.signals.find((x) => x.key === 'affordability-changed')!;
    expect(s.severity).toBe('attention');
    expect(s.title).toMatch(/improved/);
  });

  it('ignores a trivial change in surplus', () => {
    const intel = compose({
      previousStatement: { surplusPence: 22_500, totalIncomePence: 198_000,
                           totalExpenditurePence: 175_500, completedAt: '2026-02-01' },
    });
    expect(intel.signals.find((x) => x.key === 'affordability-changed')).toBeUndefined();
  });

  it('frames declared-versus-observed differences as questions, not corrections', () => {
    const intel = compose({
      discrepancies: [
        { category: 'food-and-housekeeping', subcategory: null, declaredPence: 40_000,
          observedPence: 62_000, differencePence: 22_000, direction: 'observed-higher',
          percentageDifference: 35.5, materiality: 'material', confidence: 0.86,
          suggestedQuestion: 'Ask about cash spending.' },
      ],
    });
    const s = intel.signals.find((x) => x.key === 'declared-observed-divergence')!;
    expect(s.detail).toMatch(/questions to raise, not corrections to make/);
    expect(s.suggestedAction).toMatch(/Work through the differences with the client/);
  });

  it('flags an overdue review against the case type cadence', () => {
    const intel = compose({ snapshot: snapshot({ monthsSinceLastReview: 15 }) });
    const s = intel.signals.find((x) => x.key === 'review-overdue')!;
    expect(s.severity).toBe('urgent');
    expect(s.title).toContain('3 months'); // 15 months against a 12 month cadence
  });

  it('flags a case sitting in a stage beyond its target', () => {
    const intel = compose({
      snapshot: snapshot({
        stage: 'onboarding',
        attributes: { stageEnteredAt: '2026-08-20T10:00:00Z' }, // 168 hours, target 72
      }),
    });
    const s = intel.signals.find((x) => x.key === 'stage-sla-breached')!;
    expect(s.severity).toBe('urgent');
  });

  it('escalates a blocking compliance failure to critical', () => {
    const intel = compose({
      complianceFailures: [
        { id: crypto.randomUUID(), ruleKey: 'annual-review-current',
          severity: 'blocking', detail: 'Annual review is overdue.' },
      ],
    });
    const s = intel.signals.find((x) => x.key === 'compliance-failures')!;
    expect(s.severity).toBe('critical');
    expect(intel.health.band).not.toBe('healthy');
  });

  it('treats prolonged silence as a signal about the client, not about compliance', () => {
    const intel = compose({
      engagement: { lastClientContactAt: '2026-06-01T10:00:00Z',
                    lastClientResponseAt: '2026-06-01T10:00:00Z',
                    unansweredOutboundCount: 4, portalLastSeenAt: null },
    });
    const s = intel.signals.find((x) => x.key === 'client-disengaged')!;
    expect(s.severity).toBe('urgent');
    expect(s.detail).toMatch(/sign of difficulty rather than disinterest/);
  });

  it('surfaces pending AI suggestions without treating them as concerns', () => {
    const intel = compose({
      pendingProposals: [
        { id: crypto.randomUUID(), proposalType: 'expenditure-adjustment',
          touchesRegulatedField: true, confidence: 0.86, reasoning: 'x' },
        { id: crypto.randomUUID(), proposalType: 'duplicate-debt',
          touchesRegulatedField: false, confidence: 0.91, reasoning: 'y' },
      ],
    });
    expect(intel.pendingProposalCount).toBe(2);
    expect(intel.regulatedProposalCount).toBe(1);
    const s = intel.signals.find((x) => x.key === 'proposals-awaiting-decision')!;
    expect(s.severity).toBe('informational');
    expect(s.detail).toMatch(/can only be actioned by you/);
    // Suggestions awaiting review do not make a case unhealthy.
    expect(intel.health.score).toBe(100);
  });
});

describe('advice readiness', () => {
  it('blocks where the financial picture is incomplete', () => {
    const intel = compose({
      snapshot: snapshot({ statement: null, affordability: null, debts: [] }),
    });
    expect(intel.adviceReadiness.ready).toBe(false);
    expect(intel.adviceReadiness.blocking.map((b) => b.item)).toEqual(
      expect.arrayContaining(['Financial statement', 'Affordability assessment', 'Debts']));
  });

  it('blocks on evidence the stage requires', () => {
    const intel = compose({
      snapshot: snapshot({ stage: 'onboarding', evidence: { 'consent.processing': true } }),
    });
    expect(intel.adviceReadiness.blocking.some((b) => b.item === 'Required evidence')).toBe(true);
    expect(intel.adviceReadiness.blocking.find((b) => b.item === 'Required evidence')!.why)
      .toContain('Identity verified');
  });

  it('is ready when everything needed is present', () => {
    const intel = compose({ snapshot: snapshot({ stage: 'live' }) });
    expect(intel.adviceReadiness.ready).toBe(true);
  });

  it('knows whether this stage is where advice is recorded', () => {
    expect(compose({ snapshot: snapshot({ stage: 'advice' }) }).adviceReadiness.isAdvicePoint).toBe(true);
    expect(compose({ snapshot: snapshot({ stage: 'live' }) }).adviceReadiness.isAdvicePoint).toBe(false);
  });
});

describe('next best action', () => {
  it('leads with the most urgent thing', () => {
    const intel = compose({
      snapshot: snapshot({
        statement: { totalIncomePence: 150_000, totalExpenditurePence: 176_000,
                     surplusPence: -26_000, completedAt: '2026-06-01' },
      }),
      payments: { expectedMonthlyPence: 22_000, lastPaymentPence: null,
                  lastPaymentAt: null, missedCount: 3, arrearsPence: 66_000 },
    });
    expect(intel.nextActions[0]!.urgency).toBe('now');
    expect(intel.nextActions[0]!.reason).toMatch(/payments missed/i);
    expect(intel.nextActions.length).toBeLessThanOrEqual(6);
  });

  it('prompts for the advice decision once the case is ready at the advice point', () => {
    const intel = compose({ snapshot: snapshot({ stage: 'advice' }) });
    expect(intel.nextActions[0]!.key).toBe('ready-for-advice');
  });

  it('ties every action back to the signal that produced it', () => {
    const intel = compose({
      snapshot: snapshot({ monthsSinceLastReview: 15 }),
    });
    for (const action of intel.nextActions) {
      if (action.key === 'ready-for-advice') continue;
      expect(intel.signals.some((s) => s.key === action.key)).toBe(true);
    }
  });
});

describe('composition', () => {
  it('works entirely without a model, and says so', () => {
    // The intelligence is computed from the record. A narrative is added later
    // and clearly labelled; nothing here depends on a model being available.
    const intel = compose();
    expect(intel.narrative).toBeNull();
    expect(intel.signals).toBeDefined();
    expect(intel.health).toBeDefined();
    expect(intel.eligibility.assessments.length).toBeGreaterThan(0);
  });

  it('includes the solution comparison, so alternatives are always visible', () => {
    const intel = compose();
    expect(intel.eligibility.assessments.map((a) => a.caseTypeKey)).toContain('iva');
    expect(intel.eligibility.assessments.map((a) => a.caseTypeKey)).toContain('dro');
  });

  it('orders signals by severity', () => {
    const intel = compose({
      snapshot: snapshot({ monthsSinceLastReview: 15,
        vulnerability: { activeRecordCount: 1, drivers: ['health'], highestSeverity: 'possible' } }),
      complianceFailures: [{ id: crypto.randomUUID(), ruleKey: 'r', severity: 'blocking', detail: 'd' }],
      pendingProposals: [{ id: crypto.randomUUID(), proposalType: 't',
                           touchesRegulatedField: false, confidence: null, reasoning: 'r' }],
    });
    const order = intel.signals.map((s) => s.severity);
    expect(order[0]).toBe('critical');
    expect(order[order.length - 1]).toBe('informational');
  });
});
