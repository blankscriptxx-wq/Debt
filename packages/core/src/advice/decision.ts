import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { EligibilityResult } from './eligibility.js';

/**
 * Recording regulated advice.
 *
 * This is the narrowest and most heavily guarded write in the platform. Four
 * things must be true before a decision exists:
 *
 *   1. A person is making it. `requirePermission` refuses `advice:decide` to any
 *      API key, workflow or AI principal, so there is no code path by which
 *      automation reaches this function successfully.
 *   2. They hold the competency the firm has signed them off for, and have
 *      completed a second factor. Both are enforced by the same call.
 *   3. The evidence exists: a current financial statement and an eligibility
 *      evaluation. Advice without a picture of the finances is not advice.
 *   4. The alternatives are recorded, with why each was rejected.
 *
 * Advising against the rules is allowed - an adviser can reach a defensible
 * conclusion the engine did not - but it requires an explicit override reason,
 * and the departure is recorded rather than smoothed over.
 */

export class AdviceValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Advice decision cannot be recorded:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AdviceValidationError';
  }
}

export interface RejectedOption {
  caseTypeKey: string;
  reason: string;
}

export interface AdviceDecisionInput {
  caseId: string;
  clientId: string;
  recommendedCaseType: string;
  rationale: string;
  optionsConsidered: string[];
  rejectedOptions: RejectedOption[];
  risksExplained: string[];
  statementId: string | null;
  eligibilityEvaluationId: string | null;
  affordabilityAssessmentId?: string | null;
  clientResponse?: 'accepted' | 'declined' | 'deferred' | 'considering' | 'no-response';
  /** Required when advising a solution the eligibility engine ruled out. */
  overrideReason?: string;
  ai?: {
    invocationId: string;
    contribution: 'drafted' | 'suggested-options' | 'summarised';
    outcome: 'accepted' | 'modified' | 'rejected';
  };
}

export interface RecordedAdviceDecision {
  id: string;
  auditEventId: string;
  departedFromEligibility: boolean;
}

const MINIMUM_RATIONALE_LENGTH = 40;

export async function recordAdviceDecision(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: AdviceDecisionInput,
  eligibility: EligibilityResult | null,
): Promise<RecordedAdviceDecision> {
  // Refuses non-human principals, insufficient competency and unsatisfied MFA.
  requirePermission(principal, 'advice:decide', { tenantId: ctx.tenantId });

  if (principal.kind !== 'user') {
    // Unreachable given the check above; kept so the invariant is explicit at
    // the point where the person's identity is about to be written down.
    throw new AdviceValidationError(['Only a person can record an advice decision']);
  }

  const issues: string[] = [];

  if (!input.rationale || input.rationale.trim().length < MINIMUM_RATIONALE_LENGTH) {
    issues.push(
      `a rationale of at least ${MINIMUM_RATIONALE_LENGTH} characters is required, explaining why this solution suits this client`,
    );
  }
  if (!input.statementId) {
    issues.push('a current financial statement is required before advice can be recorded');
  }
  if (!input.eligibilityEvaluationId) {
    issues.push('an eligibility evaluation is required before advice can be recorded');
  }
  if (input.optionsConsidered.length === 0) {
    issues.push('at least one option must be recorded as considered');
  }
  if (!input.optionsConsidered.includes(input.recommendedCaseType)) {
    issues.push('the recommended solution must appear in the options considered');
  }

  // Every alternative that was on the table needs a reason it was not chosen.
  const rejectedKeys = new Set(input.rejectedOptions.map((r) => r.caseTypeKey));
  for (const option of input.optionsConsidered) {
    if (option === input.recommendedCaseType) continue;
    if (!rejectedKeys.has(option)) {
      issues.push(`option "${option}" was considered but no reason for rejecting it was recorded`);
    }
  }
  for (const rejected of input.rejectedOptions) {
    if (!rejected.reason || rejected.reason.trim().length < 10) {
      issues.push(`the reason for rejecting "${rejected.caseTypeKey}" is too brief to be meaningful`);
    }
  }

  let departedFromEligibility = false;
  if (eligibility) {
    const assessment = eligibility.assessments.find((a) => a.caseTypeKey === input.recommendedCaseType);
    if (!assessment) {
      issues.push(`"${input.recommendedCaseType}" was not assessed for this client`);
    } else if (!assessment.available) {
      departedFromEligibility = true;
      if (!input.overrideReason || input.overrideReason.trim().length < 20) {
        issues.push(
          `"${input.recommendedCaseType}" did not meet ${assessment.blockers.map((b) => b.key).join(', ')}. ` +
            `Advising it anyway requires an override reason of at least 20 characters.`,
        );
      }
    }
  }

  if (issues.length) throw new AdviceValidationError(issues);

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM advice_decisions WHERE case_id = ${input.caseId} AND status = 'active'`);
  if (existing.rows.length > 0) {
    throw new AdviceValidationError([
      'this case already has an active advice decision; supersede it rather than recording a second',
    ]);
  }

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO advice_decisions (
      case_id, client_id, decided_by, decided_by_competencies,
      recommended_case_type, options_considered, rejected_options, rationale,
      risks_explained, client_response, statement_id, eligibility_evaluation_id,
      affordability_assessment_id, ai_invocation_id, ai_contribution, ai_output_accepted
    ) VALUES (
      ${input.caseId}, ${input.clientId}, ${principal.userId},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(principal.competencies)}::jsonb)),
      ${input.recommendedCaseType},
      ${JSON.stringify(input.optionsConsidered)}::jsonb,
      ${JSON.stringify(input.rejectedOptions)}::jsonb,
      ${input.rationale},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.risksExplained)}::jsonb)),
      ${input.clientResponse ?? null},
      ${input.statementId}, ${input.eligibilityEvaluationId},
      ${input.affordabilityAssessmentId ?? null},
      ${input.ai?.invocationId ?? null},
      ${input.ai ? input.ai.contribution : 'none'},
      ${input.ai?.outcome ?? null}
    ) RETURNING id`);

  const decisionId = inserted.rows[0]!.id;

  const audit = await recordAudit(db, ctx, {
    action: 'advice.decision.recorded',
    resourceType: 'advice_decision',
    resourceId: decisionId,
    caseId: input.caseId,
    reason: input.overrideReason
      ? `${input.rationale} [departure from eligibility: ${input.overrideReason}]`
      : input.rationale,
    source: 'console',
    severity: 'regulated',
    aiInvocationId: input.ai?.invocationId ?? null,
    after: {
      recommendedCaseType: input.recommendedCaseType,
      optionsConsidered: input.optionsConsidered,
      rejectedOptions: input.rejectedOptions,
      departedFromEligibility,
      decidedBy: principal.userId,
      competencies: principal.competencies,
      aiContribution: input.ai?.contribution ?? 'none',
      aiOutcome: input.ai?.outcome ?? null,
    },
  });

  return { id: decisionId, auditEventId: audit.id, departedFromEligibility };
}

/**
 * Supersedes an active decision with a new one. The original is never edited -
 * a database trigger refuses any change to its substance - so the file shows
 * both what was advised and what replaced it.
 */
export async function supersedeAdviceDecision(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: {
    previousDecisionId: string;
    reason: string;
    replacement: AdviceDecisionInput;
  },
  eligibility: EligibilityResult | null,
): Promise<RecordedAdviceDecision> {
  requirePermission(principal, 'advice:supersede', { tenantId: ctx.tenantId });

  if (!input.reason || input.reason.trim().length < 20) {
    throw new AdviceValidationError([
      'superseding advice requires a reason of at least 20 characters explaining what changed',
    ]);
  }

  const previous = await db.execute<Record<string, unknown>>(sql`
    SELECT recommended_case_type, rationale, decided_at
      FROM advice_decisions WHERE id = ${input.previousDecisionId} AND status = 'active'`);
  if (previous.rows.length === 0) {
    throw new AdviceValidationError(['there is no active decision with that identifier to supersede']);
  }

  await db.execute(sql`
    UPDATE advice_decisions
       SET status = 'superseded', supersede_reason = ${input.reason}
     WHERE id = ${input.previousDecisionId}`);

  const replacement = await recordAdviceDecision(db, ctx, principal, input.replacement, eligibility);

  await db.execute(sql`
    UPDATE advice_decisions SET superseded_by = ${replacement.id}
     WHERE id = ${input.previousDecisionId}`);

  await recordAudit(db, ctx, {
    action: 'advice.decision.superseded',
    resourceType: 'advice_decision',
    resourceId: input.previousDecisionId,
    caseId: input.replacement.caseId,
    reason: input.reason,
    source: 'console',
    severity: 'regulated',
    before: previous.rows[0]!,
    after: { supersededBy: replacement.id, newRecommendation: input.replacement.recommendedCaseType },
  });

  return replacement;
}
