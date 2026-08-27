import { sql, type Database, type TenantContext } from '@solvenda/db';

/**
 * A Postgres-backed job queue.
 *
 * Chosen over Redis for two reasons. The deployment target is serverless, so
 * there is no long-lived process to hold a connection; and enqueueing in the
 * same transaction as the work means a job is never queued for a change that
 * subsequently rolled back - a class of bug that in this domain would mean
 * telling a creditor about a payment plan that does not exist.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so several drains can run concurrently
 * without processing the same job twice.
 */

export interface EnqueueInput {
  jobType: string;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export async function enqueue(
  db: Database,
  input: EnqueueInput,
): Promise<{ jobId: string | null; deduplicated: boolean }> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO job_queue (job_type, payload, run_after, idempotency_key, max_attempts)
    VALUES (${input.jobType}, ${JSON.stringify(input.payload ?? {})}::jsonb,
            ${input.runAfter?.toISOString() ?? sql`now()`},
            ${input.idempotencyKey ?? null}, ${input.maxAttempts ?? 5})
    ON CONFLICT DO NOTHING
    RETURNING id`);

  const row = res.rows[0];
  return { jobId: row?.id ?? null, deduplicated: !row };
}

export interface ClaimedJob {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Claims up to `limit` jobs for this worker.
 *
 * Note the tenancy consequence: because RLS scopes the application role to one
 * tenant, a drain runs per tenant. The scheduler enumerates active tenants
 * through the platform connection and then drains each within its own tenant
 * context, so no worker ever holds a connection that can see two firms at once.
 */
export async function claimJobs(
  db: Database,
  workerId: string,
  limit = 10,
): Promise<ClaimedJob[]> {
  const res = await db.execute<{
    id: string; job_type: string; payload: Record<string, unknown>;
    attempts: number; max_attempts: number;
  }>(sql`
    WITH claimable AS (
      SELECT id FROM job_queue
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY run_after
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE job_queue j
       SET status = 'running', locked_by = ${workerId}, locked_at = now(),
           attempts = j.attempts + 1
      FROM claimable c
     WHERE j.id = c.id
    RETURNING j.id, j.job_type, j.payload, j.attempts, j.max_attempts`);

  return res.rows.map((r) => ({
    id: r.id, jobType: r.job_type, payload: r.payload,
    attempts: r.attempts, maxAttempts: r.max_attempts,
  }));
}

export async function completeJob(db: Database, jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE job_queue SET status = 'succeeded', completed_at = now(), locked_by = NULL
     WHERE id = ${jobId}`);
}

/**
 * Records a failure and either schedules a retry with exponential backoff or
 * moves the job to the dead letter state. A dead job is visible in the console
 * rather than merely absent, because a silently dropped job in a regulated
 * process is a compliance problem, not just an engineering one.
 */
export async function failJob(
  db: Database,
  job: ClaimedJob,
  error: string,
): Promise<{ retrying: boolean; nextAttemptAt: Date | null }> {
  if (job.attempts >= job.maxAttempts) {
    await db.execute(sql`
      UPDATE job_queue SET status = 'dead', last_error = ${error}, locked_by = NULL,
                           completed_at = now()
       WHERE id = ${job.id}`);
    return { retrying: false, nextAttemptAt: null };
  }

  const backoffSeconds = Math.min(3600, 2 ** job.attempts * 15);
  const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);
  await db.execute(sql`
    UPDATE job_queue
       SET status = 'queued', last_error = ${error}, locked_by = NULL,
           run_after = ${nextAttemptAt.toISOString()}
     WHERE id = ${job.id}`);
  return { retrying: true, nextAttemptAt };
}

/** Releases jobs whose worker died mid-flight. */
export async function reclaimStalled(db: Database, olderThanMinutes = 15): Promise<number> {
  const res = await db.execute(sql`
    UPDATE job_queue
       SET status = 'queued', locked_by = NULL, locked_at = NULL
     WHERE status = 'running'
       AND locked_at < now() - (${String(olderThanMinutes)} || ' minutes')::interval
    RETURNING id`);
  return res.rows.length;
}

/**
 * Emits a domain event and queues any workflows that subscribe to it.
 *
 * Enqueueing inside the caller's transaction is the point: the event and the
 * work it triggers commit together, or neither does.
 */
export async function emitEvent(
  db: Database,
  _ctx: TenantContext,
  input: {
    eventType: string;
    caseId?: string | null;
    clientId?: string | null;
    resourceType?: string;
    resourceId?: string | null;
    payload?: Record<string, unknown>;
    source?: string;
  },
): Promise<{ eventId: string; workflowsQueued: number }> {
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO domain_events (event_type, case_id, client_id, resource_type, resource_id,
                               payload, emitted_by_type, source)
    VALUES (${input.eventType}, ${input.caseId ?? null}, ${input.clientId ?? null},
            ${input.resourceType ?? null}, ${input.resourceId ?? null},
            ${JSON.stringify(input.payload ?? {})}::jsonb, 'system',
            ${input.source ?? 'system'})
    RETURNING id`);
  const eventId = res.rows[0]!.id;

  const subscribers = await db.execute<{ id: string; key: string; version: number }>(sql`
    SELECT id, key, version FROM workflow_definitions
     WHERE trigger_event = ${input.eventType} AND status = 'active'`);

  let queued = 0;
  for (const subscriber of subscribers.rows) {
    const { deduplicated } = await enqueue(db, {
      jobType: 'workflow.start',
      payload: {
        definitionId: subscriber.id,
        definitionKey: subscriber.key,
        eventId,
        caseId: input.caseId ?? null,
        clientId: input.clientId ?? null,
        triggerPayload: input.payload ?? {},
      },
      idempotencyKey: `${subscriber.id}:${eventId}`,
    });
    if (!deduplicated) queued++;
  }

  return { eventId, workflowsQueued: queued };
}
