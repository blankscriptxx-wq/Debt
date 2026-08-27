import { z } from 'zod';

/**
 * The shape of a case type.
 *
 * A DMP, an IVA, a DRO, a bankruptcy, a Scottish Trust Deed, a sequestration
 * and a Breathing Space are all instances of this structure. Adding another -
 * a new statutory solution, a firm's own servicing product - is a row, not a
 * release.
 */

export const expressionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length === 1, {
    message: 'An expression must have exactly one operator key',
  }),
);

export const ruleSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  requirement: z.string().min(1),
  when: expressionSchema,
  failMessage: z.string().min(1),
  severity: z.enum(['blocking', 'warning', 'advisory']).default('blocking'),
  authority: z.string().optional(),
});

export const evidenceRequirementSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum([
    'consent', 'identity', 'financial-statement', 'document', 'bank-data',
    'credit-file', 'vulnerability-assessment', 'signature', 'payment-mandate', 'declaration',
  ]),
  description: z.string().default(''),
  /** Blocking evidence prevents the case leaving the stage that requires it. */
  blocking: z.boolean().default(true),
  documentType: z.string().optional(),
});

export const stageSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  order: z.number().int().min(0),
  /** Evidence that must be present before the case can leave this stage. */
  requiredEvidence: z.array(z.string()).default([]),
  /** Target time in this stage, used for SLA reporting and escalation. */
  slaHours: z.number().int().positive().optional(),
  /** Stage keys this stage may move to. Empty means any stage. */
  allowedNext: z.array(z.string()).default([]),
  /** True for the stage at which regulated advice is recorded. */
  isAdvicePoint: z.boolean().default(false),
  isTerminal: z.boolean().default(false),
});

export const caseTypeDefinitionSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.enum(['debt-management', 'insolvency', 'statutory-moratorium', 'servicing', 'other']),
  jurisdictions: z.array(z.enum(['england-wales', 'scotland', 'northern-ireland'])).min(1),
  /** Reference to the statutory or protocol source, shown in the console. */
  authority: z.string().optional(),
  stages: z.array(stageSchema).min(1),
  evidence: z.array(evidenceRequirementSchema).default([]),
  eligibilityRules: z.array(ruleSchema).default([]),
  /** Rules checked continuously once a case is live, not just at advice. */
  complianceRules: z.array(ruleSchema).default([]),
  reviewCadence: z.object({
    everyMonths: z.number().int().positive().nullable().default(null),
    description: z.string().default(''),
  }).default({ everyMonths: null, description: '' }),
  /** Where the solution requires ongoing payments from the client. */
  hasPaymentPlan: z.boolean().default(false),
  /** Whether creditors vote, which drives the proposal and voting surfaces. */
  requiresCreditorApproval: z.boolean().default(false),
  referenceFormat: z.string().default('{TYPE}-{SEQ}'),
});

export type CaseTypeDefinition = z.infer<typeof caseTypeDefinitionSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type EvidenceRequirement = z.infer<typeof evidenceRequirementSchema>;

export class CaseTypeValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Case type definition is not valid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'CaseTypeValidationError';
  }
}

/**
 * Validates structure, then the internal consistency a schema cannot express:
 * unique and contiguous stages, transitions that point somewhere real, evidence
 * references that resolve, and exactly one advice point.
 */
export function parseCaseTypeDefinition(input: unknown): CaseTypeDefinition {
  const parsed = caseTypeDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new CaseTypeValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const def = parsed.data;
  const issues: string[] = [];

  const stageKeys = new Set<string>();
  for (const stage of def.stages) {
    if (stageKeys.has(stage.key)) issues.push(`duplicate stage key "${stage.key}"`);
    stageKeys.add(stage.key);
  }

  const orders = def.stages.map((s) => s.order).sort((a, b) => a - b);
  if (new Set(orders).size !== orders.length) issues.push('stage order values must be unique');

  const evidenceKeys = new Set(def.evidence.map((e) => e.key));
  for (const stage of def.stages) {
    for (const key of stage.requiredEvidence) {
      if (!evidenceKeys.has(key)) {
        issues.push(`stage "${stage.key}" requires unknown evidence "${key}"`);
      }
    }
    for (const next of stage.allowedNext) {
      if (!stageKeys.has(next)) {
        issues.push(`stage "${stage.key}" allows transition to unknown stage "${next}"`);
      }
    }
  }

  const advicePoints = def.stages.filter((s) => s.isAdvicePoint);
  if (advicePoints.length > 1) {
    issues.push(`exactly one stage may be the advice point; found ${advicePoints.length}`);
  }
  if (!def.stages.some((s) => s.isTerminal)) {
    issues.push('at least one stage must be terminal, or a case can never close');
  }

  const ruleKeys = new Set<string>();
  for (const rule of [...def.eligibilityRules, ...def.complianceRules]) {
    if (ruleKeys.has(rule.key)) issues.push(`duplicate rule key "${rule.key}"`);
    ruleKeys.add(rule.key);
  }

  if (issues.length) throw new CaseTypeValidationError(issues);
  return def;
}

export function firstStage(def: CaseTypeDefinition): Stage {
  return [...def.stages].sort((a, b) => a.order - b.order)[0]!;
}

export function stageByKey(def: CaseTypeDefinition, key: string): Stage | undefined {
  return def.stages.find((s) => s.key === key);
}

/** Whether a transition is permitted by the definition. */
export function canTransition(def: CaseTypeDefinition, from: string, to: string): boolean {
  const source = stageByKey(def, from);
  const target = stageByKey(def, to);
  if (!source || !target) return false;
  if (source.allowedNext.length === 0) return true;
  return source.allowedNext.includes(to);
}
