import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import type { EligibilityResult } from './eligibility.js';

/**
 * Persisting an eligibility evaluation.
 *
 * `evaluateEligibility` is a pure function, and Case Intelligence runs it on
 * every page load to show the comparison. That is right for a display, and
 * useless as a record: the rules, the trigger figures and the client's own
 * figures all move, so "which solutions were open to this person when that
 * advice was given" cannot be answered by running it again later.
 *
 * So the evaluation an adviser was looking at is written down at the moment
 * they act on it, and the advice decision points at that row. The full fact set
 * and every rule outcome are stored, not a summary, because the question a file
 * reviewer asks is why a solution was ruled out — and that has to be answerable
 * without the case as it stands now.
 */
export async function saveEligibilityEvaluation(
  db: Database,
  ctx: TenantContext,
  input: {
    caseId: string;
    statementId: string | null;
    result: EligibilityResult;
  },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO eligibility_evaluations
      (case_id, statement_id, facts, results, ruleset_fingerprint, evaluated_by)
    VALUES (${input.caseId}, ${input.statementId},
            ${JSON.stringify(input.result.facts)}::jsonb,
            ${JSON.stringify(input.result.assessments)}::jsonb,
            ${input.result.rulesetFingerprint}, ${ctx.userId ?? null})
    RETURNING id`);
  const id = rows.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'eligibility.evaluated',
    resourceType: 'eligibility_evaluation',
    resourceId: id,
    caseId: input.caseId,
    reason: 'Eligibility evaluated and recorded as the basis for a decision',
    source: 'console',
    after: {
      available: input.result.available,
      assessed: input.result.assessments.length,
      rulesetFingerprint: input.result.rulesetFingerprint,
    },
  });

  return id;
}
