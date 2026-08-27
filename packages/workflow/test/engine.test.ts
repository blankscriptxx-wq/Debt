import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, aiPrincipal, workflowPrincipal, PERMISSIONS, type Principal } from '@solvenda/auth';
import { StubAiProvider, CAPABILITIES, pendingProposals } from '@solvenda/ai';
import {
  startWorkflowRun, advanceRun, decideApproval, enqueue, claimJobs, completeJob,
  failJob, reclaimStalled, emitEvent, BANK_DATA_RECEIVED, parseWorkflowDefinition,
  type WorkflowDefinition,
} from '@solvenda/workflow';

let tenant: TestTenant;
let caseId: string;
let clientId: string;
let definitionId: string;
const deps = { aiProvider: new StubAiProvider() };

function adviser(overrides: Partial<Extract<Principal, { kind: 'user' }>> = {}): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(['ai:invoke', 'ai:accept_proposal', 'workflow:approve', 'case:read']),
    competencies: ['debt-advice'], mfaSatisfied: true, status: 'active', ...overrides,
  };
}

async function installDefinition(definition: WorkflowDefinition): Promise<string> {
  return tenant.as(async (db) => {
    const r = await db.execute<{ id: string }>(sql`
      INSERT INTO workflow_definitions (key, name, description, version, status,
                                        trigger_event, definition)
      VALUES (${definition.key}, ${definition.name}, ${definition.description}, 1, 'active',
              ${definition.triggerEvent}, ${JSON.stringify(definition)}::jsonb)
      ON CONFLICT (tenant_id, key, version) DO UPDATE SET status = 'active'
      RETURNING id`);
    return r.rows[0]!.id;
  });
}

beforeAll(async () => {
  const operatorId = await ensureTestOperator();
  await seedGlobalCatalogues(operatorId);
  await withPlatform({ operatorId, reason: 'publish AI capabilities for workflow tests' }, async (db) => {
    for (const c of CAPABILITIES) {
      await db.execute(sql`
        INSERT INTO ai_capability_catalogue
          (key, name, description, category, produces_proposals, touches_regulated_fields, default_enabled)
        VALUES (${c.key}, ${c.name}, ${c.description}, ${c.category},
                ${c.producesProposals}, ${c.touchesRegulatedFields}, ${c.defaultEnabled})
        ON CONFLICT (key) DO NOTHING`);
    }
  });

  tenant = await createTestTenant('wf');
  const ids = await tenant.as(async (db) => {
    const c = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name) VALUES ('CL-1','Jo','W') RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
      VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'fact-find', ${tenant.userId}) RETURNING id`);
    return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id };
  });
  clientId = ids.clientId;
  caseId = ids.caseId;

  definitionId = await installDefinition(BANK_DATA_RECEIVED);
});

afterAll(async () => { await closeDatabase(); });

describe('the brief\'s worked example, end to end', () => {
  let runId: string;

  it('starts when bank information arrives', async () => {
    const started = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition: BANK_DATA_RECEIVED, definitionId, definitionVersion: 1,
      caseId, clientId,
      triggerPayload: { provider: 'sandbox', accountCount: 2, periodMonths: 3 },
      facts: {
        'sfs.lines': 'present', 'sfs.totalIncomePence': 198_000,
        'sfs.totalExpenditurePence': 176_000,
      },
    }));
    expect(started.created).toBe(true);
    runId = started.runId;
  });

  it('does not start a second run for the same event', async () => {
    const again = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition: BANK_DATA_RECEIVED, definitionId, definitionVersion: 1,
      caseId, clientId,
      triggerPayload: { provider: 'sandbox', accountCount: 2, periodMonths: 3 },
    }));
    expect(again.created).toBe(false);
    expect(again.runId).toBe(runId);
  });

  it('analyses, branches, raises a task and stops at the approval', async () => {
    const outcome = await tenant.as((db) =>
      advanceRun(db, tenant.context, runId, BANK_DATA_RECEIVED, deps));

    // It runs itself forward and then waits for a person - it does not carry on
    // past the point where a regulated decision is needed.
    expect(outcome.status).toBe('awaiting-approval');
    expect(outcome.currentStep).toBe('await-decision');

    const steps = await tenant.as(async (db) => {
      const r = await db.execute<{ step_key: string; status: string }>(sql`
        SELECT step_key, status FROM workflow_step_runs WHERE run_id = ${runId} ORDER BY sequence`);
      return r.rows;
    });
    expect(steps.map((s) => s.step_key)).toEqual([
      'analyse', 'material-differences', 'raise-task', 'await-decision',
    ]);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
  });

  it('raised a task for the adviser that says nothing has been changed', async () => {
    const task = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT title, detail, priority, assigned_to, created_via, source_reference
          FROM case_tasks WHERE case_id = ${caseId}`);
      return r.rows[0]!;
    });
    expect(task['priority']).toBe('high');
    expect(task['assigned_to']).toBe(tenant.userId);
    expect(task['created_via']).toBe('workflow');
    expect(task['detail']).toMatch(/questions to put to the client, not corrections/);
    expect(task['detail']).toMatch(/Nothing has been changed on the case/);
  });

  it('turned the analysis into proposals rather than edits', async () => {
    const proposals = await tenant.as((db) => pendingProposals(db, caseId));
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.status === 'pending')).toBe(true);
    expect(proposals.some((p) => p.touchesRegulatedField)).toBe(true);
  });

  it('refuses to let automation resolve the approval', async () => {
    const approvalId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM workflow_approvals WHERE run_id = ${runId}`);
      return r.rows[0]!.id;
    });

    for (const principal of [
      aiPrincipal(tenant.id, 'ie-discrepancy', 'inv'),
      workflowPrincipal(tenant.id, runId, PERMISSIONS.map((p) => p.key)),
      { kind: 'api_key', tenantId: tenant.id, keyId: 'k',
        scopes: new Set(PERMISSIONS.map((p) => p.key)) } as Principal,
    ]) {
      await expect(
        tenant.as((db) => decideApproval(db, tenant.context, principal,
          { approvalId, decision: 'approved' })),
      ).rejects.toThrow(/can only be exercised by an authenticated person/);
    }
  });

  it('resumes once a person approves, and records the decision as regulated', async () => {
    const approvalId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM workflow_approvals WHERE run_id = ${runId}`);
      return r.rows[0]!.id;
    });

    await tenant.as((db) => decideApproval(db, tenant.context, adviser(), {
      approvalId, decision: 'approved',
      note: 'Client confirmed higher food spending; statement to be updated at the review.',
    }));

    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT severity, actor_user_id FROM audit_events
         WHERE action = 'workflow.approval.decided' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['severity']).toBe('regulated');
    expect(event['actor_user_id']).toBe(tenant.userId);

    const outcome = await tenant.as((db) =>
      advanceRun(db, tenant.context, runId, BANK_DATA_RECEIVED, deps));
    expect(outcome.status).toBe('completed');

    const emitted = await tenant.as(async (db) => {
      const r = await db.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`
        SELECT event_type, payload FROM domain_events
         WHERE event_type = 'financial-statement.reviewed'`);
      return r.rows;
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload['outcome']).toBe('adviser-approved');
  });

  it('takes the rejection path when the adviser says no', async () => {
    const secondCase = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
        VALUES ('DMP-2', ${clientId}, 'dmp', 1, 'fact-find', ${tenant.userId}) RETURNING id`);
      return r.rows[0]!.id;
    });

    const { runId: secondRun } = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition: BANK_DATA_RECEIVED, definitionId, definitionVersion: 1,
      caseId: secondCase, clientId, triggerPayload: { provider: 'sandbox', accountCount: 1 },
    }));
    await tenant.as((db) => advanceRun(db, tenant.context, secondRun, BANK_DATA_RECEIVED, deps));

    const approvalId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM workflow_approvals WHERE run_id = ${secondRun}`);
      return r.rows[0]!.id;
    });

    await expect(
      tenant.as((db) => decideApproval(db, tenant.context, adviser(),
        { approvalId, decision: 'rejected' })),
    ).rejects.toThrow(/requires a note explaining why/);

    await tenant.as((db) => decideApproval(db, tenant.context, adviser(), {
      approvalId, decision: 'rejected',
      note: 'Differences explained by a one-off cost; declared figures stand.',
    }));

    const outcome = await tenant.as((db) =>
      advanceRun(db, tenant.context, secondRun, BANK_DATA_RECEIVED, deps));
    expect(outcome.status).toBe('completed');

    const emitted = await tenant.as(async (db) => {
      const r = await db.execute<{ payload: Record<string, unknown> }>(sql`
        SELECT payload FROM domain_events
         WHERE event_type = 'financial-statement.reviewed' AND case_id = ${secondCase}`);
      return r.rows;
    });
    expect(emitted[0]!.payload['outcome']).toBe('declared-figures-retained');
  });
});

describe('the engine cannot write regulated information', () => {
  it('turns a regulated field update into a proposal, however it is configured', async () => {
    // A workflow that explicitly tries to change a regulated figure. It is not
    // rejected at configuration time - it is neutralised at execution time.
    const definition = parseWorkflowDefinition({
      key: 'attempts-regulated-write',
      name: 'Attempts a regulated write',
      triggerEvent: 'test.regulated-write',
      startStep: 'write',
      steps: [
        { type: 'update-field', key: 'write', name: 'Change the surplus',
          targetTable: 'financial_statements', targetField: 'surplus_pence',
          value: 999_999, regulated: true, next: 'done', maxAttempts: 1, onError: null },
        { type: 'end', key: 'done', name: 'Done', next: null, maxAttempts: 1, onError: null },
      ],
    });
    const id = await installDefinition(definition);

    const beforeSurplus = await tenant.as(async (db) => {
      await db.execute(sql`
        INSERT INTO financial_statements (case_id, client_id, version, status, surplus_pence)
        VALUES (${caseId}, ${clientId}, 99, 'draft', 22000)`);
      const r = await db.execute<{ surplus_pence: string }>(sql`
        SELECT surplus_pence FROM financial_statements WHERE case_id = ${caseId} AND version = 99`);
      return Number(r.rows[0]!.surplus_pence);
    });
    expect(beforeSurplus).toBe(22_000);

    const { runId } = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition, definitionId: id, definitionVersion: 1, caseId, clientId,
      triggerPayload: { attempt: 1 },
    }));
    const outcome = await tenant.as((db) => advanceRun(db, tenant.context, runId, definition, deps));

    expect(outcome.status).toBe('completed');

    // The figure is untouched.
    const afterSurplus = await tenant.as(async (db) => {
      const r = await db.execute<{ surplus_pence: string }>(sql`
        SELECT surplus_pence FROM financial_statements WHERE case_id = ${caseId} AND version = 99`);
      return Number(r.rows[0]!.surplus_pence);
    });
    expect(afterSurplus).toBe(22_000);

    // A proposal was raised instead, for a person to decide.
    const proposals = await tenant.as((db) => pendingProposals(db, caseId));
    const raised = proposals.find((p) => p.proposalType === 'workflow-field-change')!;
    expect(raised).toBeDefined();
    expect(raised.touchesRegulatedField).toBe(true);
    expect(raised.proposedValue).toBe(999_999);
    expect(raised.reasoning).toMatch(/needs your decision/);
  });

  it('refuses to write to a table outside its allowlist', async () => {
    const definition = parseWorkflowDefinition({
      key: 'writes-anywhere', name: 'Writes anywhere', triggerEvent: 'test.anywhere',
      startStep: 'write',
      steps: [
        { type: 'update-field', key: 'write', name: 'Change a user',
          targetTable: 'users', targetField: 'competencies', value: ['debt-advice'],
          regulated: false, next: 'done', maxAttempts: 1, onError: null },
        { type: 'end', key: 'done', name: 'Done', next: null, maxAttempts: 1, onError: null },
      ],
    });
    const id = await installDefinition(definition);
    const { runId } = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition, definitionId: id, definitionVersion: 1, caseId, clientId,
      triggerPayload: { attempt: 1 },
    }));
    const outcome = await tenant.as((db) => advanceRun(db, tenant.context, runId, definition, deps));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/may not write to "users"/);
  });
});

describe('dry run', () => {
  it('reports what it would do without doing any of it', async () => {
    const dryCase = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage, owner_user_id)
        VALUES ('DMP-DRY', ${clientId}, 'dmp', 1, 'fact-find', ${tenant.userId}) RETURNING id`);
      return r.rows[0]!.id;
    });

    const { runId } = await tenant.as((db) => startWorkflowRun(db, tenant.context, {
      definition: BANK_DATA_RECEIVED, definitionId, definitionVersion: 1,
      caseId: dryCase, clientId, triggerPayload: { dry: true }, dryRun: true,
    }));
    const outcome = await tenant.as((db) =>
      advanceRun(db, tenant.context, runId, BANK_DATA_RECEIVED, deps));

    expect(outcome.simulated.map((s) => s.effect['type'])).toContain('ai-capability');

    // Nothing actually happened.
    const effects = await tenant.as(async (db) => {
      const tasks = await db.execute(sql`SELECT id FROM case_tasks WHERE case_id = ${dryCase}`);
      const invocations = await db.execute(sql`SELECT id FROM ai_invocations WHERE case_id = ${dryCase}`);
      const approvals = await db.execute(sql`SELECT id FROM workflow_approvals WHERE case_id = ${dryCase}`);
      return { tasks: tasks.rows.length, invocations: invocations.rows.length,
               approvals: approvals.rows.length };
    });
    expect(effects).toEqual({ tasks: 0, invocations: 0, approvals: 0 });
  });
});

describe('job queue', () => {
  it('deduplicates on an idempotency key', async () => {
    const first = await tenant.as((db) => enqueue(db, {
      jobType: 'test.job', payload: { n: 1 }, idempotencyKey: 'once' }));
    const second = await tenant.as((db) => enqueue(db, {
      jobType: 'test.job', payload: { n: 1 }, idempotencyKey: 'once' }));
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it('claims a job once, even under concurrent drains', async () => {
    await tenant.as((db) => enqueue(db, { jobType: 'test.concurrent', payload: { n: 1 } }));
    const [a, b] = await Promise.all([
      tenant.as((db) => claimJobs(db, 'worker-a', 10)),
      tenant.as((db) => claimJobs(db, 'worker-b', 10)),
    ]);
    const claimedIds = [...a, ...b].filter((j) => j.jobType === 'test.concurrent').map((j) => j.id);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds).toHaveLength(1);
  });

  it('retries with backoff, then gives up loudly rather than silently', async () => {
    await tenant.as((db) => enqueue(db, {
      jobType: 'test.failing', payload: {}, maxAttempts: 2 }));

    let job = (await tenant.as((db) => claimJobs(db, 'w', 50)))
      .find((j) => j.jobType === 'test.failing')!;
    const firstFailure = await tenant.as((db) => failJob(db, job, 'transient'));
    expect(firstFailure.retrying).toBe(true);
    expect(firstFailure.nextAttemptAt).toBeInstanceOf(Date);

    await tenant.as((db) => db.execute(sql`
      UPDATE job_queue SET run_after = now() WHERE id = ${job.id}`));
    job = (await tenant.as((db) => claimJobs(db, 'w', 50)))
      .find((j) => j.id === job.id)!;
    const secondFailure = await tenant.as((db) => failJob(db, job, 'still broken'));
    expect(secondFailure.retrying).toBe(false);

    const status = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; last_error: string }>(sql`
        SELECT status, last_error FROM job_queue WHERE id = ${job.id}`);
      return r.rows[0]!;
    });
    // Dead, not deleted: a dropped job in a regulated process must be visible.
    expect(status.status).toBe('dead');
    expect(status.last_error).toBe('still broken');
  });

  it('reclaims jobs whose worker died', async () => {
    await tenant.as((db) => enqueue(db, { jobType: 'test.stalled', payload: {} }));
    const claimed = (await tenant.as((db) => claimJobs(db, 'doomed', 50)))
      .find((j) => j.jobType === 'test.stalled')!;
    await tenant.as((db) => db.execute(sql`
      UPDATE job_queue SET locked_at = now() - interval '30 minutes' WHERE id = ${claimed.id}`));

    const reclaimed = await tenant.as((db) => reclaimStalled(db, 15));
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    await tenant.as((db) => completeJob(db, claimed.id));
  });

  it('queues subscribing workflows when an event is emitted', async () => {
    const result = await tenant.as((db) => emitEvent(db, tenant.context, {
      eventType: 'open-banking.data-received',
      caseId, clientId, payload: { provider: 'sandbox' },
    }));
    expect(result.workflowsQueued).toBe(1);

    // The same event does not queue the same workflow twice.
    const jobs = await tenant.as(async (db) => {
      const r = await db.execute<{ payload: Record<string, unknown> }>(sql`
        SELECT payload FROM job_queue WHERE job_type = 'workflow.start'`);
      return r.rows;
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload['definitionKey']).toBe('bank-data-received');
  });
});
