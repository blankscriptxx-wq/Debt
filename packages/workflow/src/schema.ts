import { z } from 'zod';

/**
 * Workflow definitions.
 *
 * TRIGGER -> CONDITIONS -> ACTIONS -> APPROVALS -> FOLLOW-UP, expressed as
 * data an administrator edits rather than code a developer deploys.
 *
 * Conditions reuse the expression language from @solvenda/core, so an
 * administrator who has written an eligibility rule already knows how to write
 * a workflow condition.
 */

const expression = z.record(z.string(), z.unknown());

const baseStep = {
  key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** Evaluated before the step runs; a false condition skips it. */
  when: expression.optional(),
  next: z.string().nullable().default(null),
  /** Retries for a transient failure. Non-transient failures do not retry. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** Where to go if this step fails after its attempts. Null fails the run. */
  onError: z.string().nullable().default(null),
};

export const stepSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseStep, type: z.literal('ai-capability'),
    capability: z.string(),
    /** Turn the capability's output into proposals for a human to decide. */
    createProposals: z.boolean().default(false),
  }),
  z.object({
    ...baseStep, type: z.literal('create-task'),
    title: z.string(), detail: z.string().default(''),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    assignTo: z.enum(['case-owner', 'team', 'unassigned']).default('case-owner'),
    team: z.string().optional(),
    dueInHours: z.number().int().positive().optional(),
  }),
  z.object({
    ...baseStep, type: z.literal('send-communication'),
    channel: z.enum(['email', 'sms', 'whatsapp', 'letter', 'portal']),
    templateKey: z.string(),
    to: z.enum(['client', 'creditor', 'introducer']).default('client'),
  }),
  z.object({
    ...baseStep, type: z.literal('update-field'),
    targetTable: z.string(), targetField: z.string(),
    value: z.unknown(),
    /**
     * Set when the field carries regulatory weight. The engine refuses to write
     * these; it raises a proposal instead. Enforced, not advisory.
     */
    regulated: z.boolean().default(false),
  }),
  z.object({
    ...baseStep, type: z.literal('branch'),
    branches: z.array(z.object({
      when: expression,
      next: z.string(),
      label: z.string().default(''),
    })).min(1),
    default: z.string().nullable().default(null),
  }),
  z.object({
    ...baseStep, type: z.literal('delay'),
    forHours: z.number().positive().optional(),
    untilField: z.string().optional(),
  }),
  z.object({
    ...baseStep, type: z.literal('approval'),
    title: z.string(),
    detail: z.string().default(''),
    requiredPermission: z.string(),
    assignTo: z.enum(['case-owner', 'team', 'unassigned']).default('case-owner'),
    team: z.string().optional(),
    dueInHours: z.number().int().positive().default(48),
    /** Where to go when the approver says no. */
    onReject: z.string().nullable().default(null),
    /** Escalate to this team when the approval passes its due time. */
    escalateToTeam: z.string().optional(),
  }),
  z.object({
    ...baseStep, type: z.literal('emit-event'),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ ...baseStep, type: z.literal('end'), outcome: z.string().default('completed') }),
]);

export type WorkflowStep = z.infer<typeof stepSchema>;

export const workflowDefinitionSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  triggerEvent: z.string().min(1),
  /** Conditions on the trigger payload; a false condition means no run starts. */
  triggerConditions: expression.optional(),
  /** Applies only to these case types; empty means all. */
  caseTypes: z.array(z.string()).default([]),
  startStep: z.string().min(1),
  steps: z.array(stepSchema).min(1),
  /** Guards against a runaway definition looping forever. */
  maxSteps: z.number().int().min(1).max(200).default(50),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Workflow definition is not valid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'WorkflowValidationError';
  }
}

export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const def = parsed.data;
  const issues: string[] = [];
  const keys = new Set<string>();

  for (const step of def.steps) {
    if (keys.has(step.key)) issues.push(`duplicate step key "${step.key}"`);
    keys.add(step.key);
  }
  if (!keys.has(def.startStep)) issues.push(`startStep "${def.startStep}" is not a step`);

  const reference = (target: string | null | undefined, from: string, what: string) => {
    if (target && !keys.has(target)) {
      issues.push(`step "${from}" ${what} unknown step "${target}"`);
    }
  };

  for (const step of def.steps) {
    reference(step.next, step.key, 'continues to');
    reference(step.onError, step.key, 'routes errors to');
    if (step.type === 'branch') {
      for (const branch of step.branches) reference(branch.next, step.key, 'branches to');
      reference(step.default, step.key, 'defaults to');
    }
    if (step.type === 'approval') reference(step.onReject, step.key, 'routes rejection to');
    if (step.type === 'delay' && !step.forHours && !step.untilField) {
      issues.push(`delay step "${step.key}" needs either forHours or untilField`);
    }
    if (step.type !== 'end' && step.type !== 'branch' && !step.next) {
      issues.push(`step "${step.key}" has no continuation and is not an end step`);
    }
  }

  if (!def.steps.some((s) => s.type === 'end')) {
    issues.push('a workflow needs at least one end step');
  }

  // Unreachable steps are almost always an editing mistake, and a step that
  // silently never runs is worse than one that fails.
  const reachable = new Set<string>([def.startStep]);
  const queue = [def.startStep];
  const byKey = new Map(def.steps.map((s) => [s.key, s]));
  while (queue.length) {
    const step = byKey.get(queue.shift()!);
    if (!step) continue;
    const targets = [step.next, step.onError];
    if (step.type === 'branch') targets.push(...step.branches.map((b) => b.next), step.default);
    if (step.type === 'approval') targets.push(step.onReject);
    for (const target of targets) {
      if (target && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const step of def.steps) {
    if (!reachable.has(step.key)) issues.push(`step "${step.key}" is unreachable`);
  }

  if (issues.length) throw new WorkflowValidationError(issues);
  return def;
}
