import { describe, expect, it } from 'vitest';
import { evaluate, evaluateRules, RuleEvaluationError, type Rule } from '@solvenda/core';

const facts = {
  'debt.qualifyingPence': 750_000,
  'debt.creditorCount': 4,
  'sfs.surplusPence': 12_000,
  'client.jurisdiction': 'england-wales',
  'history.hasActiveInsolvency': false,
  'history.monthsSinceBreathingSpace': null,
  'vulnerability.drivers': ['health', 'resilience'],
} as const;

describe('expression evaluation', () => {
  it('handles comparison, logic and arithmetic', () => {
    expect(evaluate({ gte: [{ fact: 'debt.qualifyingPence' }, { const: 600_000 }] }, facts)).toBe(true);
    expect(evaluate({ lt: [{ fact: 'debt.creditorCount' }, { const: 2 }] }, facts)).toBe(false);
    expect(evaluate({ and: [{ const: true }, { const: true }] }, facts)).toBe(true);
    expect(evaluate({ or: [{ const: false }, { const: true }] }, facts)).toBe(true);
    expect(evaluate({ not: { const: false } }, facts)).toBe(true);
    expect(evaluate({ add: [{ const: 1 }, { const: 2 }, { const: 3 }] }, facts)).toBe(6);
    expect(evaluate({ subtract: [{ const: 10 }, { const: 4 }] }, facts)).toBe(6);
    expect(evaluate({ between: [{ const: 5 }, { const: 1 }, { const: 10 }] }, facts)).toBe(true);
    expect(evaluate({ in: [{ fact: 'client.jurisdiction' }, [{ const: 'scotland' }, { const: 'england-wales' }]] }, facts)).toBe(true);
    expect(evaluate({ includes: [{ fact: 'vulnerability.drivers' }, { const: 'health' }] }, facts)).toBe(true);
  });

  it('treats an unknown fact as null rather than failing', () => {
    // "Not yet gathered" is a normal state on a live case, not an error.
    expect(evaluate({ fact: 'nothing.here' }, facts)).toBeNull();
    expect(evaluate({ isNull: { fact: 'nothing.here' } }, facts)).toBe(true);
  });

  it('returns false when comparing against information not yet known', () => {
    expect(evaluate({ gte: [{ fact: 'nothing.here' }, { const: 1 }] }, facts)).toBe(false);
    expect(evaluate({ lte: [{ fact: 'nothing.here' }, { const: 1 }] }, facts)).toBe(false);
  });

  it('refuses an unrecognised operator instead of guessing', () => {
    expect(() => evaluate({ launchMissiles: [] } as never, facts)).toThrow(RuleEvaluationError);
  });

  it('stops runaway nesting', () => {
    let expression: unknown = { const: true };
    for (let i = 0; i < 40; i++) expression = { not: expression };
    expect(() => evaluate(expression as never, facts)).toThrow(/nested too deeply/);
  });
});

describe('rule sets', () => {
  const rules: Rule[] = [
    { key: 'min-debt', description: '', requirement: 'Debt at least £6,000',
      when: { gte: [{ fact: 'debt.qualifyingPence' }, { const: 600_000 }] },
      failMessage: 'Too little debt', severity: 'blocking' },
    { key: 'min-surplus', description: '', requirement: 'Surplus at least £200',
      when: { gte: [{ fact: 'sfs.surplusPence' }, { const: 20_000 }] },
      failMessage: 'Surplus too low', severity: 'blocking' },
    { key: 'recent-bs', description: '', requirement: 'No recent Breathing Space',
      when: { isNull: { fact: 'history.monthsSinceBreathingSpace' } },
      failMessage: 'Breathing Space used recently', severity: 'warning' },
  ];

  it('separates blocking failures from warnings', () => {
    const outcome = evaluateRules(rules, facts);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.blockedBy).toEqual(['min-surplus']);
    expect(outcome.warnings).toEqual([]);
  });

  it('reports each rule with the requirement and the message', () => {
    const outcome = evaluateRules(rules, facts);
    const failed = outcome.outcomes.find((o) => o.key === 'min-surplus')!;
    expect(failed.satisfied).toBe(false);
    expect(failed.requirement).toBe('Surplus at least £200');
    expect(failed.message).toBe('Surplus too low');
  });

  it('blocks on a broken rule rather than treating it as passed', () => {
    // A configuration mistake must surface as an obstacle, never as a quietly
    // approved case.
    const broken: Rule[] = [
      { key: 'broken', description: '', requirement: 'Something',
        when: { nonsense: true } as never, failMessage: 'Cannot evaluate', severity: 'advisory' },
    ];
    const outcome = evaluateRules(broken, facts);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.blockedBy).toEqual(['broken']);
    expect(outcome.outcomes[0]!.error).toMatch(/Unrecognised expression/);
    expect(outcome.outcomes[0]!.severity).toBe('blocking');
  });
});
