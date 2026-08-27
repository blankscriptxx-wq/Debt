import { describe, expect, it } from 'vitest';
import {
  evaluateEligibility, buildFacts, qualifyingDebtPence,
  CASE_TYPE_TEMPLATES, DEFAULT_THRESHOLD_CONFIG,
  type CaseSnapshot, type DebtSnapshot,
} from '@solvenda/core';

function debt(overrides: Partial<DebtSnapshot> = {}): DebtSnapshot {
  return {
    id: crypto.randomUUID(), balancePence: 200_000, arrearsPence: 0,
    debtType: 'unsecured', isPriority: false, isJoint: false, inDispute: false,
    isStatuteBarred: false, includedInSolution: true,
    creditorId: crypto.randomUUID(), creditorName: 'Creditor', status: 'active',
    ...overrides,
  };
}

function snapshot(overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: crypto.randomUUID(), caseTypeKey: 'dmp', stage: 'fact-find',
    jurisdiction: 'england-wales', monthsSinceLastReview: null,
    client: {
      id: crypto.randomUUID(), jurisdiction: 'england-wales',
      householdAdults: 1, householdChildren: 0,
      employmentStatus: 'employed', dateOfBirth: '1985-03-12',
    },
    debts: [debt(), debt(), debt(), debt()],
    statement: { totalIncomePence: 180_000, totalExpenditurePence: 155_000,
                 surplusPence: 25_000, completedAt: new Date().toISOString() },
    affordability: { sustainablePaymentPence: 22_000, contingencyPence: 3_000 },
    assets: { totalPence: 80_000, realisablePence: 0, vehicleValuePence: 80_000,
              vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0 },
    history: { hasActiveInsolvency: false, hasPriorInsolvency: false,
               priorInsolvencyDisclosed: false, monthsSinceBreathingSpace: null,
               monthsSinceDmp: null },
    vulnerability: { activeRecordCount: 0, drivers: [], highestSeverity: null },
    evidence: {}, attributes: {},
    ...overrides,
  };
}

const evaluate = (s: CaseSnapshot) =>
  evaluateEligibility({
    snapshot: s, caseTypes: CASE_TYPE_TEMPLATES, thresholdConfig: DEFAULT_THRESHOLD_CONFIG,
  });

describe('qualifying debt', () => {
  it('excludes priority, disputed, statute-barred and excluded debts', () => {
    const debts = [
      debt({ balancePence: 100_000 }),
      debt({ balancePence: 500_000, isPriority: true }),
      debt({ balancePence: 300_000, inDispute: true }),
      debt({ balancePence: 200_000, isStatuteBarred: true }),
      debt({ balancePence: 400_000, includedInSolution: false }),
      debt({ balancePence: 900_000, status: 'settled' }),
    ];
    // Statutory thresholds bite on qualifying debt, which is not the same as
    // everything the client owes.
    expect(qualifyingDebtPence(debts)).toBe(100_000);
  });
});

describe('solution comparison', () => {
  it('assesses every case type available in the client jurisdiction', () => {
    const result = evaluate(snapshot());
    const keys = result.assessments.map((a) => a.caseTypeKey).sort();
    expect(keys).toEqual(['bankruptcy', 'breathing-space', 'dmp', 'dro', 'iva']);
    // Scottish solutions are absent for an England and Wales client.
    expect(keys).not.toContain('trust-deed');
  });

  it('offers Scottish solutions to a Scottish client', () => {
    const result = evaluate(snapshot({
      jurisdiction: 'scotland',
      client: { ...snapshot().client, jurisdiction: 'scotland' },
    }));
    const keys = result.assessments.map((a) => a.caseTypeKey).sort();
    expect(keys).toEqual(['das-dpp', 'dmp', 'sequestration', 'trust-deed']);
    expect(keys).not.toContain('dro');
  });

  it('rules out a DRO where surplus income is above the limit', () => {
    // £250 surplus against a £75 DRO ceiling.
    const result = evaluate(snapshot());
    const dro = result.assessments.find((a) => a.caseTypeKey === 'dro')!;
    expect(dro.available).toBe(false);
    expect(dro.blockers.map((b) => b.key)).toContain('surplus-ceiling');
    expect(dro.blockers.find((b) => b.key === 'surplus-ceiling')!.message)
      .toMatch(/Surplus income exceeds the DRO limit/);
  });

  it('opens a DRO up when the circumstances actually fit', () => {
    const result = evaluate(snapshot({
      debts: [debt({ balancePence: 400_000 }), debt({ balancePence: 300_000 })],
      statement: { totalIncomePence: 120_000, totalExpenditurePence: 116_000,
                   surplusPence: 4_000, completedAt: new Date().toISOString() },
      affordability: { sustainablePaymentPence: 4_000, contingencyPence: 0 },
      assets: { totalPence: 50_000, realisablePence: 0, vehicleValuePence: 50_000,
                vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0 },
    }));
    const dro = result.assessments.find((a) => a.caseTypeKey === 'dro')!;
    expect(dro.available).toBe(true);
    expect(result.available).toContain('dro');
  });

  it('rules out an IVA below the viable debt level, and says what to consider instead', () => {
    const result = evaluate(snapshot({ debts: [debt({ balancePence: 100_000 })] }));
    const iva = result.assessments.find((a) => a.caseTypeKey === 'iva')!;
    expect(iva.available).toBe(false);
    expect(iva.blockers.map((b) => b.key)).toEqual(
      expect.arrayContaining(['minimum-debt', 'minimum-creditors']));
    expect(iva.blockers.find((b) => b.key === 'minimum-debt')!.message)
      .toMatch(/Consider a DRO, a DMP or bankruptcy/);
  });

  it('warns rather than blocks on a recent Breathing Space, citing the protocol', () => {
    const result = evaluate(snapshot({
      debts: [debt({ balancePence: 400_000 }), debt({ balancePence: 400_000 }), debt({ balancePence: 300_000 })],
      history: { ...snapshot().history, monthsSinceBreathingSpace: 6 },
    }));
    const iva = result.assessments.find((a) => a.caseTypeKey === 'iva')!;
    expect(iva.warnings.map((w) => w.key)).toContain('no-recent-breathing-space');
    expect(iva.warnings[0]!.authority).toBe('IVA Protocol 2025');
    // A warning does not close the option off.
    expect(iva.blockers).toEqual([]);
    expect(iva.available).toBe(true);
  });

  it('blocks an undisclosed prior insolvency outright', () => {
    const result = evaluate(snapshot({
      debts: [debt({ balancePence: 400_000 }), debt({ balancePence: 400_000 })],
      history: { ...snapshot().history, hasPriorInsolvency: true, priorInsolvencyDisclosed: false },
    }));
    const iva = result.assessments.find((a) => a.caseTypeKey === 'iva')!;
    expect(iva.blockers.map((b) => b.key)).toContain('prior-insolvency-disclosed');
  });

  it('blocks Breathing Space where one was used within twelve months', () => {
    const result = evaluate(snapshot({
      history: { ...snapshot().history, monthsSinceBreathingSpace: 4 },
    }));
    const bs = result.assessments.find((a) => a.caseTypeKey === 'breathing-space')!;
    expect(bs.blockers.map((b) => b.key)).toContain('not-used-recently');
  });

  it('still allows a mental health crisis moratorium after a recent standard one', () => {
    const result = evaluate(snapshot({
      history: { ...snapshot().history, monthsSinceBreathingSpace: 4 },
      attributes: { breathingSpaceType: 'mental-health-crisis', mhcEvidencePresent: true },
      evidence: { mhcEvidencePresent: true },
    }));
    const bs = result.assessments.find((a) => a.caseTypeKey === 'breathing-space')!;
    expect(bs.blockers.map((b) => b.key)).not.toContain('not-used-recently');
  });

  it('requires professional evidence for a crisis moratorium', () => {
    const result = evaluate(snapshot({
      attributes: { breathingSpaceType: 'mental-health-crisis' },
      evidence: { mhcEvidencePresent: false },
    }));
    const bs = result.assessments.find((a) => a.caseTypeKey === 'breathing-space')!;
    expect(bs.blockers.map((b) => b.key)).toContain('mhc-evidence-present');
  });

  it('respects a threshold change without any code change', () => {
    const base = snapshot({
      debts: [debt({ balancePence: 400_000 }), debt({ balancePence: 300_000 })],
      statement: { totalIncomePence: 120_000, totalExpenditurePence: 116_000,
                   surplusPence: 4_000, completedAt: new Date().toISOString() },
      affordability: { sustainablePaymentPence: 4_000, contingencyPence: 0 },
      assets: { totalPence: 50_000, realisablePence: 0, vehicleValuePence: 50_000,
                vehicleAdaptedForDisability: false, hasProperty: false, propertyEquityPence: 0 },
    });

    const asShipped = evaluateEligibility({
      snapshot: base, caseTypes: CASE_TYPE_TEMPLATES, thresholdConfig: DEFAULT_THRESHOLD_CONFIG });
    expect(asShipped.assessments.find((a) => a.caseTypeKey === 'dro')!.available).toBe(true);

    // A regulation lowers the DRO debt ceiling to £5,000. The firm edits one
    // configured value; no rule and no code changes.
    const afterChange = evaluateEligibility({
      snapshot: base, caseTypes: CASE_TYPE_TEMPLATES,
      thresholdConfig: { ...DEFAULT_THRESHOLD_CONFIG, 'config.droDebtLimitPence': 500_000 } });
    const dro = afterChange.assessments.find((a) => a.caseTypeKey === 'dro')!;
    expect(dro.available).toBe(false);
    expect(dro.blockers.map((b) => b.key)).toContain('debt-ceiling');
  });

  it('records a ruleset fingerprint so a stored evaluation stays identifiable', () => {
    const a = evaluate(snapshot());
    const b = evaluate(snapshot());
    expect(a.rulesetFingerprint).toBe(b.rulesetFingerprint);
    expect(a.rulesetFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the full fact set so an evaluation can be explained later', () => {
    const result = evaluate(snapshot());
    expect(result.facts['debt.qualifyingPence']).toBe(800_000);
    expect(result.facts['debt.creditorCount']).toBe(4);
    expect(result.facts['config.droSurplusLimitPence']).toBe(7_500);
  });
});

describe('fact building', () => {
  it('counts distinct creditors, not debts', () => {
    const shared = crypto.randomUUID();
    const facts = buildFacts(snapshot({
      debts: [debt({ creditorId: shared }), debt({ creditorId: shared }), debt()],
    }));
    expect(facts['debt.count']).toBe(3);
    expect(facts['debt.creditorCount']).toBe(2);
  });

  it('separates priority arrears from the rest', () => {
    const facts = buildFacts(snapshot({
      debts: [debt({ isPriority: true, balancePence: 90_000, arrearsPence: 40_000 }), debt()],
    }));
    expect(facts['debt.priorityArrearsPence']).toBe(40_000);
    expect(facts['debt.priorityCount']).toBe(1);
    expect(facts['debt.nonPriorityCount']).toBe(1);
  });

  it('exposes information that has not been gathered as null, not zero', () => {
    const facts = buildFacts(snapshot({ statement: null, affordability: null }));
    expect(facts['sfs.surplusPence']).toBeNull();
    expect(facts['affordability.sustainablePaymentPence']).toBeNull();
    expect(facts['sfs.present']).toBe(false);
  });
});
