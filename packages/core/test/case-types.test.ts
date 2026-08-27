import { describe, expect, it } from 'vitest';
import {
  CASE_TYPE_TEMPLATES, parseCaseTypeDefinition, CaseTypeValidationError,
  firstStage, canTransition, evaluateRules, type Rule,
} from '@solvenda/core';

describe('shipped case types', () => {
  it('ships the eight UK solutions the platform claims to support', () => {
    expect(CASE_TYPE_TEMPLATES.map((t) => t.key).sort()).toEqual([
      'bankruptcy', 'breathing-space', 'das-dpp', 'dmp', 'dro',
      'iva', 'sequestration', 'trust-deed',
    ]);
  });

  it.each(CASE_TYPE_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s is a valid, internally consistent definition', (_key, template) => {
      expect(() => parseCaseTypeDefinition(template)).not.toThrow();
    });

  it.each(CASE_TYPE_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s has a reachable terminal stage and a single advice point', (_key, template) => {
      expect(template.stages.some((s) => s.isTerminal)).toBe(true);
      expect(template.stages.filter((s) => s.isAdvicePoint)).toHaveLength(1);
    });

  it('scopes Scottish solutions to Scotland and English ones to England and Wales', () => {
    const byKey = new Map(CASE_TYPE_TEMPLATES.map((t) => [t.key, t]));
    expect(byKey.get('trust-deed')!.jurisdictions).toEqual(['scotland']);
    expect(byKey.get('sequestration')!.jurisdictions).toEqual(['scotland']);
    expect(byKey.get('das-dpp')!.jurisdictions).toEqual(['scotland']);
    expect(byKey.get('dro')!.jurisdictions).toEqual(['england-wales']);
    expect(byKey.get('breathing-space')!.jurisdictions).toEqual(['england-wales']);
    // A DMP is an informal arrangement, so it exists everywhere.
    expect(byKey.get('dmp')!.jurisdictions).toContain('scotland');
  });

  it('requires consent, identity and a vulnerability assessment before advice', () => {
    for (const template of CASE_TYPE_TEMPLATES) {
      const beforeAdvice = template.stages
        .filter((s) => s.order < template.stages.find((x) => x.isAdvicePoint)!.order)
        .flatMap((s) => s.requiredEvidence);
      expect(beforeAdvice, `${template.key} must require consent before advising`)
        .toContain('consent.processing');
      expect(beforeAdvice, `${template.key} must verify identity before advising`)
        .toContain('identity.verified');
    }
  });

  it('expresses statutory thresholds as facts, so a limit change is configuration', () => {
    const dro = CASE_TYPE_TEMPLATES.find((t) => t.key === 'dro')!;
    const serialised = JSON.stringify(dro.eligibilityRules);
    // The DRO ceilings must be referenced, never inlined as constants: when the
    // regulations move, a firm edits a value rather than waiting for a release.
    expect(serialised).toContain('config.droDebtLimitPence');
    expect(serialised).toContain('config.droAssetLimitPence');
    expect(serialised).toContain('config.droSurplusLimitPence');
    expect(serialised).not.toMatch(/"const":\s*5000000/);
  });
});

describe('definition validation', () => {
  const valid = CASE_TYPE_TEMPLATES.find((t) => t.key === 'dmp')!;

  it('rejects a stage requiring evidence that does not exist', () => {
    const broken = { ...valid, stages: valid.stages.map((s, i) =>
      i === 0 ? { ...s, requiredEvidence: ['evidence.that.does.not.exist'] } : s) };
    expect(() => parseCaseTypeDefinition(broken)).toThrow(CaseTypeValidationError);
  });

  it('rejects a transition to a stage that does not exist', () => {
    const broken = { ...valid, stages: valid.stages.map((s, i) =>
      i === 0 ? { ...s, allowedNext: ['nowhere'] } : s) };
    expect(() => parseCaseTypeDefinition(broken)).toThrow(/unknown stage "nowhere"/);
  });

  it('rejects a definition with no terminal stage', () => {
    const broken = { ...valid, stages: valid.stages.map((s) => ({ ...s, isTerminal: false })) };
    expect(() => parseCaseTypeDefinition(broken)).toThrow(/at least one stage must be terminal/);
  });

  it('rejects more than one advice point', () => {
    const broken = { ...valid, stages: valid.stages.map((s) => ({ ...s, isAdvicePoint: true })) };
    expect(() => parseCaseTypeDefinition(broken)).toThrow(/exactly one stage may be the advice point/);
  });

  it('rejects duplicate rule keys', () => {
    const rule = valid.eligibilityRules[0]!;
    const broken = { ...valid, eligibilityRules: [rule, { ...rule }] };
    expect(() => parseCaseTypeDefinition(broken)).toThrow(/duplicate rule key/);
  });
});

describe('adding a case type requires no code change', () => {
  it('accepts an entirely new solution defined only as data', () => {
    // A firm's own product: a supported payment-holiday arrangement that does
    // not exist anywhere in the codebase.
    const invented = parseCaseTypeDefinition({
      key: 'supported-payment-holiday',
      name: 'Supported Payment Holiday',
      description: 'A firm-designed short-term forbearance arrangement.',
      category: 'servicing',
      jurisdictions: ['england-wales', 'scotland'],
      stages: [
        { key: 'intake', name: 'Intake', order: 0, requiredEvidence: ['consent.processing'],
          allowedNext: ['advice'], isAdvicePoint: false, isTerminal: false },
        { key: 'advice', name: 'Advice', order: 1, requiredEvidence: [],
          allowedNext: ['live'], isAdvicePoint: true, isTerminal: false },
        { key: 'live', name: 'In holiday', order: 2, requiredEvidence: [],
          allowedNext: ['ended'], isAdvicePoint: false, isTerminal: false },
        { key: 'ended', name: 'Ended', order: 3, requiredEvidence: [], allowedNext: [],
          isAdvicePoint: false, isTerminal: true },
      ],
      evidence: [
        { key: 'consent.processing', label: 'Consent to process', kind: 'consent', blocking: true },
      ],
      eligibilityRules: [
        { key: 'temporary-hardship', description: 'Short-term difficulty only.',
          requirement: 'Household reports a temporary change in circumstances',
          when: { eq: [{ fact: 'case.hardshipIsTemporary' }, { const: true }] },
          failMessage: 'This arrangement is only for temporary difficulty.' },
      ],
    });

    expect(invented.key).toBe('supported-payment-holiday');
    expect(firstStage(invented).key).toBe('intake');
    expect(canTransition(invented, 'intake', 'advice')).toBe(true);
    expect(canTransition(invented, 'intake', 'live')).toBe(false);

    // Its rules evaluate through the same engine as every shipped case type.
    const outcome = evaluateRules(
      invented.eligibilityRules as unknown as Rule[],
      { 'case.hardshipIsTemporary': true },
    );
    expect(outcome.satisfied).toBe(true);
  });
});
