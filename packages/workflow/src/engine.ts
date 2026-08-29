import { createHash } from 'node:crypto';
import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, workflowPrincipal, isRegulatedPermission, type Principal } from '@solvenda/auth';
import { evaluate, type Expression, type Facts } from '@solvenda/core';
import { createProposals, proposalsFromOutput, invokeCapability, capability,
         type AiProvider } from '@solvenda/ai';
import type { WorkflowDefinition, WorkflowStep } from './schema.js';

/**
 * The workflow engine.
 *
 * Two properties are load bearing.
 *
 * It is durable. Every step transition is committed before the next begins, so
 * a run interrupted by a deployment, a timeout or a crash resumes from where it
 * stopped rather than starting again or stopping silently. A step that already
 * succeeded is never re-executed.
 *
 * It cannot write regulated information. A step configured to change a
 * regulated field raises a proposal or an approval instead - the write simply
 * is not reachable from here. An administrator who configures such a step is
 * not doing anything dangerous; they are configuring something that will ask a
 * person. This is checked in the engine and tested against a workflow that
 * explicitly tries.
 */

export interface EngineDependencies {
  aiProvider: AiProvider;
  /** Called for send-communication steps. Absent, the step records intent only. */
  sendCommunication?: (input: {
    channel: string; templateKey: string; to: string; caseId: string | null;
    context: Record<string, unknown>;
  }) => Promise<{ messageId: string }>;
  now?: () => Date;
}

export interface StartRunInput {
  definition: WorkflowDefinition;
  definitionId: string;
  definitionVersion: number;
  caseId?: string | null;
  clientId?: string | null;
  triggerPayload: Record<string, unknown>;
  /** Facts available to conditions, in addition to the trigger payload. */
  facts?: Facts;
  dryRun?: boolean;
}

export interface RunOutcome {
  runId: string;
  status: 'running' | 'waiting' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled';
  stepsExecuted: number;
  currentStep: string | null;
  resumeAt: Date | null;
  error: string | null;
  /** On a dry run, what each step would have done. */
  simulated: { step: string; effect: Record<string, unknown> }[];
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * Starts a run, or returns the existing one if this event has already started
 * it. Idempotency is on (workflow key, trigger event, payload) so an event
 * delivered twice does not produce two runs.
 */
export async function startWorkflowRun(
  db: Database,
  ctx: TenantContext,
  input: StartRunInput,
): Promise<{ runId: string; created: boolean }> {
  const idempotencyKey = createHash('sha256')
    .update(JSON.stringify([
      input.definition.key, input.definitionVersion,
      input.definition.triggerEvent, input.caseId ?? null, input.triggerPayload,
    ]))
    .digest('hex');

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM workflow_runs WHERE idempotency_key = ${idempotencyKey}`);
  if (existing.rows[0]) return { runId: existing.rows[0].id, created: false };

  // The trigger's own conditions decide whether a run starts at all.
  if (input.definition.triggerConditions) {
    const facts = { ...flatten(input.triggerPayload, 'trigger'), ...(input.facts ?? {}) };
    if (!evaluate(input.definition.triggerConditions as Expression, facts)) {
      throw new WorkflowError('Trigger conditions were not met');
    }
  }

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO workflow_runs (
      definition_id, definition_key, definition_version, case_id, client_id,
      trigger_event, trigger_payload, idempotency_key, status, current_step, context, dry_run
    ) VALUES (
      ${input.definitionId}, ${input.definition.key}, ${input.definitionVersion},
      ${input.caseId ?? null}, ${input.clientId ?? null},
      ${input.definition.triggerEvent}, ${JSON.stringify(input.triggerPayload)}::jsonb,
      ${idempotencyKey}, 'running', ${input.definition.startStep},
      ${JSON.stringify({ trigger: input.triggerPayload, facts: input.facts ?? {} })}::jsonb,
      ${input.dryRun ?? false}
    ) RETURNING id`);

  const runId = inserted.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'workflow.run.started',
    resourceType: 'workflow_run',
    resourceId: runId,
    caseId: input.caseId ?? null,
    source: `workflow:${input.definition.key}@v${input.definitionVersion}`,
    after: {
      workflow: input.definition.key,
      trigger: input.definition.triggerEvent,
      dryRun: input.dryRun ?? false,
    },
  });

  return { runId, created: true };
}

/**
 * Runs the workflow forward until it finishes, needs to wait, or needs a
 * person. Safe to call repeatedly: a step that has already succeeded is
 * skipped, and the step budget stops a definition that loops.
 */
export async function advanceRun(
  db: Database,
  ctx: TenantContext,
  runId: string,
  definition: WorkflowDefinition,
  deps: EngineDependencies,
): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const run = await loadRun(db, runId);
  if (!run) throw new WorkflowError('No such workflow run');

  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return outcomeFrom(run, 0, []);
  }
  if (run.status === 'waiting' && run.resume_at && new Date(run.resume_at) > now()) {
    return outcomeFrom(run, 0, []);
  }
  if (run.status === 'awaiting-approval') return outcomeFrom(run, 0, []);

  const byKey = new Map(definition.steps.map((s) => [s.key, s]));
  const principal = workflowPrincipal(ctx.tenantId, runId, WORKFLOW_PERMISSIONS);

  let context = (run.context ?? {}) as Record<string, unknown>;
  let currentKey: string | null = run.current_step ?? definition.startStep;
  let executed = 0;
  const simulated: { step: string; effect: Record<string, unknown> }[] = [];

  while (currentKey && executed < definition.maxSteps) {
    const step: WorkflowStep | undefined = byKey.get(currentKey);
    if (!step) {
      await failRun(db, ctx, runId, `Step "${currentKey}" does not exist in this definition`);
      return { runId, status: 'failed', stepsExecuted: executed, currentStep: currentKey,
               resumeAt: null, error: `Step "${currentKey}" does not exist`, simulated };
    }

    // A step that already succeeded on an earlier pass is not re-run.
    const prior = await db.execute<{ status: string; output: unknown }>(sql`
      SELECT status, output FROM workflow_step_runs
       WHERE run_id = ${runId} AND step_key = ${step.key} AND status = 'succeeded'
       ORDER BY sequence DESC LIMIT 1`);
    if (prior.rows[0] && step.type !== 'branch') {
      context = { ...context, [step.key]: prior.rows[0].output };

      // Resuming past an approval must follow the decision that was actually
      // made. Taking `next` unconditionally would carry the run down the
      // approved path after a rejection - the one place in the engine where
      // getting this wrong would silently override a person.
      if (step.type === 'approval') {
        const decision = await db.execute<{ status: string }>(sql`
          SELECT status FROM workflow_approvals
           WHERE run_id = ${runId} AND step_key = ${step.key}`);
        const status = decision.rows[0]?.status;
        if (status === 'pending') {
          await db.execute(sql`
            UPDATE workflow_runs SET status = 'awaiting-approval', current_step = ${step.key}
             WHERE id = ${runId}`);
          return { runId, status: 'awaiting-approval', stepsExecuted: executed,
                   currentStep: step.key, resumeAt: null, error: null, simulated };
        }
        if (status === 'rejected' || status === 'expired' || status === 'cancelled') {
          currentKey = step.onReject;
          if (!currentKey) {
            await db.execute(sql`
              UPDATE workflow_runs SET status = 'completed', completed_at = now()
               WHERE id = ${runId}`);
            return { runId, status: 'completed', stepsExecuted: executed,
                     currentStep: step.key, resumeAt: null, error: null, simulated };
          }
          continue;
        }
      }

      currentKey = step.next;
      continue;
    }

    const facts = { ...flatten(context, ''), ...flatten(context['facts'] ?? {}, '') } as Facts;

    if (step.when && !evaluate(step.when as Expression, facts)) {
      await recordStep(db, runId, step, executed, 'skipped', null, null, null);
      currentKey = step.next;
      executed++;
      continue;
    }

    const result = await executeStep({
      db, ctx, runId, run, step, context, facts, principal, deps, dryRun: run.dry_run, now: now(),
    });

    await recordStep(db, runId, step, executed, result.status, result.input ?? null,
      result.output ?? null, result.error ?? null, result.simulatedEffect ?? null);

    if (result.simulatedEffect) simulated.push({ step: step.key, effect: result.simulatedEffect });

    executed++;

    if (result.status === 'failed') {
      if (step.onError) { currentKey = step.onError; continue; }
      await failRun(db, ctx, runId, result.error ?? 'Step failed');
      return { runId, status: 'failed', stepsExecuted: executed, currentStep: step.key,
               resumeAt: null, error: result.error ?? 'Step failed', simulated };
    }

    context = { ...context, [step.key]: result.output ?? null };
    await db.execute(sql`
      UPDATE workflow_runs SET context = ${JSON.stringify(context)}::jsonb WHERE id = ${runId}`);

    if (result.wait) {
      await db.execute(sql`
        UPDATE workflow_runs
           SET status = ${result.wait.status}, current_step = ${step.key},
               resume_at = ${result.wait.resumeAt?.toISOString() ?? null}
         WHERE id = ${runId}`);
      return { runId, status: result.wait.status, stepsExecuted: executed,
               currentStep: step.key, resumeAt: result.wait.resumeAt ?? null, error: null, simulated };
    }

    if (step.type === 'end') {
      await db.execute(sql`
        UPDATE workflow_runs SET status = 'completed', completed_at = now(), current_step = ${step.key}
         WHERE id = ${runId}`);
      await recordAudit(db, ctx, {
        action: 'workflow.run.completed', resourceType: 'workflow_run', resourceId: runId,
        caseId: run.case_id, source: `workflow:${definition.key}`,
        after: { outcome: step.outcome, stepsExecuted: executed, dryRun: run.dry_run },
      });
      return { runId, status: 'completed', stepsExecuted: executed, currentStep: step.key,
               resumeAt: null, error: null, simulated };
    }

    currentKey = result.nextOverride !== undefined ? result.nextOverride : step.next;
    await db.execute(sql`
      UPDATE workflow_runs SET current_step = ${currentKey} WHERE id = ${runId}`);
  }

  if (executed >= definition.maxSteps) {
    await failRun(db, ctx, runId,
      `Run exceeded its ${definition.maxSteps} step budget, which usually means the definition loops`);
    return { runId, status: 'failed', stepsExecuted: executed, currentStep: currentKey,
             resumeAt: null, error: 'Step budget exceeded', simulated };
  }

  return { runId, status: 'completed', stepsExecuted: executed, currentStep: null,
           resumeAt: null, error: null, simulated };
}

/**
 * What a workflow principal may do. Notably absent: everything regulated. The
 * authorisation engine would refuse those anyway; listing only the safe set
 * here means a misconfigured workflow fails at its own boundary rather than
 * relying on the last line of defence.
 */
const WORKFLOW_PERMISSIONS = [
  'case:read', 'client:read', 'sfs:read', 'debt:read', 'document:read',
  'comms:read', 'comms:send', 'ai:invoke', 'workflow:read', 'report:read',
];

interface StepExecutionResult {
  status: 'succeeded' | 'failed';
  input?: unknown;
  output?: unknown;
  error?: string;
  wait?: { status: 'waiting' | 'awaiting-approval'; resumeAt?: Date };
  nextOverride?: string | null;
  simulatedEffect?: Record<string, unknown>;
}

async function executeStep(args: {
  db: Database; ctx: TenantContext; runId: string; run: RunRow; step: WorkflowStep;
  context: Record<string, unknown>; facts: Facts; principal: Principal;
  deps: EngineDependencies; dryRun: boolean; now: Date;
}): Promise<StepExecutionResult> {
  const { db, ctx, runId, run, step, context, facts, principal, deps, dryRun } = args;

  try {
    switch (step.type) {
      case 'branch': {
        for (const branch of step.branches) {
          if (evaluate(branch.when as Expression, facts)) {
            return { status: 'succeeded', output: { taken: branch.label || branch.next },
                     nextOverride: branch.next };
          }
        }
        return { status: 'succeeded', output: { taken: 'default' }, nextOverride: step.default };
      }

      case 'delay': {
        const resumeAt = step.forHours
          ? new Date(args.now.getTime() + step.forHours * 3_600_000)
          : resolveDate(context, step.untilField!);
        if (!resumeAt) {
          return { status: 'failed', error: `Could not resolve delay target "${step.untilField}"` };
        }
        if (dryRun) {
          return { status: 'succeeded', output: { wouldResumeAt: resumeAt.toISOString() },
                   simulatedEffect: { type: 'delay', until: resumeAt.toISOString() } };
        }
        return { status: 'succeeded', output: { resumeAt: resumeAt.toISOString() },
                 wait: { status: 'waiting', resumeAt } };
      }

      case 'ai-capability': {
        const definition = capability(step.capability);
        if (!definition) {
          return { status: 'failed', error: `Unknown AI capability "${step.capability}"` };
        }
        if (dryRun) {
          return { status: 'succeeded', output: null,
                   simulatedEffect: { type: 'ai-capability', capability: step.capability } };
        }

        const invocation = await invokeCapability(db, ctx, principal, deps.aiProvider, {
          capabilityKey: step.capability,
          caseId: run.case_id,
          clientId: run.client_id,
          context: (context['facts'] as Record<string, unknown>) ?? context,
          source: `workflow:${run.definition_key}#${step.key}`,
        });

        if (step.createProposals && definition.producesProposals) {
          const proposals = proposalsFromOutput({
            invocationId: invocation.invocationId,
            caseId: run.case_id, clientId: run.client_id,
            capabilityKey: step.capability, output: invocation.output,
          });
          if (proposals.length) await createProposals(db, ctx, proposals);
          return { status: 'succeeded',
                   output: { invocationId: invocation.invocationId, proposalCount: proposals.length } };
        }
        return { status: 'succeeded',
                 output: { invocationId: invocation.invocationId, result: invocation.output } };
      }

      case 'create-task': {
        if (dryRun) {
          return { status: 'succeeded', output: null,
                   simulatedEffect: { type: 'create-task', title: step.title } };
        }
        const dueAt = step.dueInHours
          ? new Date(args.now.getTime() + step.dueInHours * 3_600_000).toISOString()
          : null;
        const res = await db.execute<{ id: string }>(sql`
          INSERT INTO case_tasks (case_id, client_id, title, detail, priority,
                                  assigned_to, assigned_team, due_at, created_via, source_reference)
          VALUES (${run.case_id}, ${run.client_id}, ${step.title}, ${step.detail}, ${step.priority},
                  ${step.assignTo === 'case-owner' ? await caseOwner(db, run.case_id) : null},
                  ${step.assignTo === 'team' ? (step.team ?? null) : null},
                  ${dueAt}, 'workflow', ${`${run.definition_key}#${step.key}`})
          RETURNING id`);
        return { status: 'succeeded', output: { taskId: res.rows[0]!.id } };
      }

      case 'update-field': {
        // The engine cannot write regulated information. A step configured to
        // do so raises a proposal for a person instead. This is the reason an
        // administrator can safely be given a field-updating step at all.
        if (step.regulated) {
          if (dryRun) {
            return { status: 'succeeded', output: null,
                     simulatedEffect: { type: 'proposal', field: `${step.targetTable}.${step.targetField}`,
                                        reason: 'regulated field - would raise a proposal' } };
          }
          const invocationRes = await db.execute<{ id: string }>(sql`
            SELECT id FROM ai_invocations WHERE case_id = ${run.case_id}
             ORDER BY created_at DESC LIMIT 1`);
          if (!invocationRes.rows[0]) {
            return { status: 'failed',
                     error: 'A proposal must reference an invocation; none exists on this case' };
          }
          const [proposalId] = await createProposals(db, ctx, [{
            invocationId: invocationRes.rows[0].id,
            caseId: run.case_id,
            proposalType: 'workflow-field-change',
            targetTable: step.targetTable,
            targetField: step.targetField,
            proposedValue: step.value,
            reasoning:
              `Workflow "${run.definition_key}" step "${step.key}" proposes this change. ` +
              `It affects regulated information, so it needs your decision.`,
            touchesRegulatedField: true,
          }]);
          return { status: 'succeeded', output: { proposalId, applied: false } };
        }

        if (dryRun) {
          return { status: 'succeeded', output: null,
                   simulatedEffect: { type: 'update-field',
                                      field: `${step.targetTable}.${step.targetField}`, value: step.value } };
        }
        // Non-regulated updates are constrained to an allowlist of tables the
        // engine is permitted to touch.
        if (!WRITABLE_TABLES.has(step.targetTable)) {
          return { status: 'failed',
                   error: `Workflows may not write to "${step.targetTable}"` };
        }
        await db.execute(sql`
          UPDATE ${sql.identifier(step.targetTable)}
             SET ${sql.identifier(step.targetField)} = ${JSON.stringify(step.value)}::jsonb
           WHERE case_id = ${run.case_id}`);
        return { status: 'succeeded', output: { applied: true } };
      }

      case 'send-communication': {
        if (dryRun || !deps.sendCommunication) {
          return { status: 'succeeded',
                   output: { simulated: true, channel: step.channel, template: step.templateKey },
                   simulatedEffect: { type: 'send-communication', channel: step.channel,
                                      template: step.templateKey, to: step.to } };
        }
        const sent = await deps.sendCommunication({
          channel: step.channel, templateKey: step.templateKey, to: step.to,
          caseId: run.case_id, context,
        });
        return { status: 'succeeded', output: sent };
      }

      case 'approval': {
        if (dryRun) {
          return { status: 'succeeded', output: null,
                   simulatedEffect: { type: 'approval', title: step.title,
                                      requiredPermission: step.requiredPermission } };
        }
        const dueAt = new Date(args.now.getTime() + step.dueInHours * 3_600_000);
        const res = await db.execute<{ id: string }>(sql`
          INSERT INTO workflow_approvals (
            run_id, step_key, case_id, title, detail, required_permission,
            proposed_effect, assigned_to, assigned_team, due_at
          ) VALUES (
            ${runId}, ${step.key}, ${run.case_id}, ${step.title}, ${step.detail},
            ${step.requiredPermission}, ${JSON.stringify(context)}::jsonb,
            ${step.assignTo === 'case-owner' ? await caseOwner(db, run.case_id) : null},
            ${step.assignTo === 'team' ? (step.team ?? null) : null},
            ${dueAt.toISOString()}
          )
          ON CONFLICT (run_id, step_key) DO UPDATE SET title = EXCLUDED.title
          RETURNING id`);

        await recordAudit(db, ctx, {
          action: 'workflow.approval.requested', resourceType: 'workflow_approval',
          resourceId: res.rows[0]!.id, caseId: run.case_id,
          source: `workflow:${run.definition_key}#${step.key}`,
          after: { title: step.title, requiredPermission: step.requiredPermission,
                   regulated: isRegulatedPermission(step.requiredPermission) },
        });

        return { status: 'succeeded', output: { approvalId: res.rows[0]!.id },
                 wait: { status: 'awaiting-approval' } };
      }

      case 'emit-event': {
        if (dryRun) {
          return { status: 'succeeded', output: null,
                   simulatedEffect: { type: 'emit-event', eventType: step.eventType } };
        }
        await db.execute(sql`
          INSERT INTO domain_events (event_type, case_id, client_id, payload, emitted_by_type, source)
          VALUES (${step.eventType}, ${run.case_id}, ${run.client_id},
                  ${JSON.stringify(step.payload)}::jsonb, 'workflow',
                  ${`workflow:${run.definition_key}#${step.key}`})`);
        return { status: 'succeeded', output: { emitted: step.eventType } };
      }

      case 'end':
        return { status: 'succeeded', output: { outcome: step.outcome } };
    }
  } catch (error) {
    return { status: 'failed', error: (error as Error).message };
  }
}

const WRITABLE_TABLES = new Set(['cases', 'case_tasks']);

/**
 * Resolves an approval and resumes the run.
 *
 * The permission the workflow named is enforced here, which means a workflow
 * asking for a regulated sign-off can only be resolved by a person.
 */
export async function decideApproval(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: { approvalId: string; decision: 'approved' | 'rejected'; note?: string },
): Promise<{ runId: string; stepKey: string; nextStep: string | null }> {
  const found = await db.execute<{
    id: string; run_id: string; step_key: string; status: string;
    required_permission: string; case_id: string | null;
  }>(sql`SELECT * FROM workflow_approvals WHERE id = ${input.approvalId}`);

  const approval = found.rows[0];
  if (!approval) throw new WorkflowError('No such approval');
  if (approval.status !== 'pending') {
    throw new WorkflowError(`This approval was already ${approval.status}`);
  }

  requirePermission(principal, approval.required_permission, { tenantId: ctx.tenantId });

  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new WorkflowError('Rejecting an approval requires a note explaining why');
  }

  await db.execute(sql`
    UPDATE workflow_approvals
       SET status = ${input.decision},
           decided_by = ${principal.kind === 'user' ? principal.userId : null},
           decided_at = now(), decision_note = ${input.note ?? null}
     WHERE id = ${input.approvalId}`);

  await recordAudit(db, ctx, {
    action: 'workflow.approval.decided',
    resourceType: 'workflow_approval',
    resourceId: input.approvalId,
    caseId: approval.case_id,
    source: 'console',
    severity: isRegulatedPermission(approval.required_permission) ? 'regulated' : 'notable',
    reason: input.note ?? `Approval ${input.decision}`,
    after: { decision: input.decision, decidedBy: principal.kind === 'user' ? principal.userId : null },
  });

  await db.execute(sql`
    UPDATE workflow_runs SET status = 'running' WHERE id = ${approval.run_id}`);

  return { runId: approval.run_id, stepKey: approval.step_key, nextStep: null };
}

// ---------------------------------------------------------------------------

interface RunRow {
  [key: string]: unknown;
  id: string; status: string; current_step: string | null; context: unknown;
  case_id: string | null; client_id: string | null; definition_key: string;
  dry_run: boolean; resume_at: string | null;
}

async function loadRun(db: Database, runId: string): Promise<RunRow | null> {
  const res = await db.execute<RunRow>(sql`
    SELECT id, status, current_step, context, case_id, client_id, definition_key,
           dry_run, resume_at
      FROM workflow_runs WHERE id = ${runId}`);
  return res.rows[0] ?? null;
}

async function caseOwner(db: Database, caseId: string | null): Promise<string | null> {
  if (!caseId) return null;
  const res = await db.execute<{ owner_user_id: string | null }>(sql`
    SELECT owner_user_id FROM cases WHERE id = ${caseId}`);
  return res.rows[0]?.owner_user_id ?? null;
}

async function recordStep(
  db: Database, runId: string, step: WorkflowStep, sequence: number,
  status: string, input: unknown, output: unknown, error: string | null,
  simulatedEffect: Record<string, unknown> | null = null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO workflow_step_runs (run_id, step_key, step_type, sequence, status,
                                    input, output, error_detail, simulated_effect,
                                    attempts, completed_at)
    VALUES (${runId}, ${step.key}, ${step.type}, ${sequence}, ${status},
            ${input === null ? null : JSON.stringify(input)}::jsonb,
            ${output === null || output === undefined ? null : JSON.stringify(output)}::jsonb,
            ${error}, ${simulatedEffect ? JSON.stringify(simulatedEffect) : null}::jsonb,
            1, now())
    ON CONFLICT (run_id, step_key, sequence) DO NOTHING`);
}

async function failRun(db: Database, ctx: TenantContext, runId: string, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE workflow_runs SET status = 'failed', error_detail = ${error}, completed_at = now()
     WHERE id = ${runId}`);
  await recordAudit(db, ctx, {
    action: 'workflow.run.failed', resourceType: 'workflow_run', resourceId: runId,
    source: 'workflow', reason: error, after: { error },
  });
}

function outcomeFrom(run: RunRow, executed: number, simulated: RunOutcome['simulated']): RunOutcome {
  return {
    runId: run.id,
    status: run.status as RunOutcome['status'],
    stepsExecuted: executed,
    currentStep: run.current_step,
    resumeAt: run.resume_at ? new Date(run.resume_at) : null,
    error: null,
    simulated,
  };
}

function resolveDate(context: Record<string, unknown>, path: string): Date | null {
  const value = path.split('.').reduce<unknown>(
    (acc, seg) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[seg] : undefined),
    context);
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Flattens nested context into dotted fact names for the expression engine. */
function flatten(value: unknown, prefix: string): Record<string, never> {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      if (path) out[path] = node;
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(value, prefix);
  return out as Record<string, never>;
}

/** Turns a capability's structured output into proposals a person can decide. */
