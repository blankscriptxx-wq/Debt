import { evaluateRules, type Rule, type RuleSetOutcome } from '../rules/engine.js';
import type { CaseTypeDefinition } from '../case-types/schema.js';
import { buildFacts, type CaseSnapshot } from './facts.js';
import type { Facts } from '../rules/engine.js';

export interface SolutionAssessment {
  caseTypeKey: string;
  name: string;
  category: string;
  available: boolean;
  /** Why this solution is not available, in the adviser's words. */
  blockers: { key: string; requirement: string; message: string; authority: string | null }[];
  warnings: { key: string; requirement: string; message: string; authority: string | null }[];
  outcome: RuleSetOutcome;
}

export interface EligibilityResult {
  facts: Facts;
  assessments: SolutionAssessment[];
  /** Solutions with no blocking failures, in configured order. */
  available: string[];
  rulesetFingerprint: string;
}

/**
 * Evaluates every configured case type against one case.
 *
 * Deliberately not a recommendation. The output is "which solutions are open to
 * this person, and precisely what stands in the way of the others" - the
 * comparison an adviser needs in order to advise, and the record that shows a
 * reviewer the alternatives were genuinely considered.
 */
export function evaluateEligibility(input: {
  snapshot: CaseSnapshot;
  caseTypes: readonly CaseTypeDefinition[];
  thresholdConfig?: Readonly<Record<string, number>>;
}): EligibilityResult {
  const facts = buildFacts(input.snapshot, input.thresholdConfig ?? {});

  const candidates = input.caseTypes.filter((ct) =>
    ct.jurisdictions.includes(input.snapshot.client.jurisdiction),
  );

  const assessments = candidates.map<SolutionAssessment>((caseType) => {
    const outcome = evaluateRules(caseType.eligibilityRules as unknown as Rule[], facts);
    const failing = outcome.outcomes.filter((o) => !o.satisfied);
    return {
      caseTypeKey: caseType.key,
      name: caseType.name,
      category: caseType.category,
      available: outcome.satisfied,
      blockers: failing
        .filter((o) => o.severity === 'blocking')
        .map((o) => ({ key: o.key, requirement: o.requirement, message: o.message ?? '', authority: o.authority })),
      warnings: failing
        .filter((o) => o.severity === 'warning')
        .map((o) => ({ key: o.key, requirement: o.requirement, message: o.message ?? '', authority: o.authority })),
      outcome,
    };
  });

  return {
    facts,
    assessments,
    available: assessments.filter((a) => a.available).map((a) => a.caseTypeKey),
    rulesetFingerprint: fingerprint(candidates),
  };
}

/**
 * Identifies the ruleset that produced an evaluation, so a stored result can be
 * matched to the configuration that generated it even after the rules change.
 */
function fingerprint(caseTypes: readonly CaseTypeDefinition[]): string {
  const parts = caseTypes
    .map((ct) => `${ct.key}@${ct.eligibilityRules.map((r) => r.key).sort().join('|')}`)
    .sort();
  let hash = 0n;
  for (const char of parts.join(';')) {
    hash = (hash * 31n + BigInt(char.codePointAt(0)!)) % 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
