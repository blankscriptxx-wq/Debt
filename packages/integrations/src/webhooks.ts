import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * Webhooks.
 *
 * Deliveries are signed so a receiver can prove a payload came from us and has
 * not been altered, and the signature covers a timestamp so an intercepted
 * delivery cannot be replayed days later. Failures back off and eventually
 * disable the endpoint rather than retrying forever into a dead URL.
 */

const SIGNATURE_VERSION = 'v1';
const REPLAY_WINDOW_SECONDS = 300;

export function signPayload(secret: string, payload: string, timestamp: number): string {
  const signed = `${timestamp}.${payload}`;
  const mac = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},${SIGNATURE_VERSION}=${mac}`;
}

/**
 * Verifies a signature. Exposed so the documentation can show receivers exactly
 * how to check one, and so the behaviour is tested rather than described.
 */
export function verifySignature(
  secret: string,
  payload: string,
  header: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2),
  ) as Record<string, string>;

  const timestamp = Number(parts['t']);
  const presented = parts[SIGNATURE_VERSION];
  if (!timestamp || !presented) return { valid: false, reason: 'malformed signature header' };

  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'timestamp outside the replay window' };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return { valid: false, reason: 'signature mismatch' };
  return timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: 'signature mismatch' };
}

export async function createEndpoint(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: { url: string; eventTypes: string[]; description?: string },
): Promise<{ id: string; signingSecret: string }> {
  requirePermission(principal, 'integration:configure', { tenantId: ctx.tenantId });

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error('Webhook URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook endpoints must use HTTPS: these payloads carry case data');
  }

  const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO webhook_endpoints (url, description, event_types, signing_secret, created_by)
    VALUES (${input.url}, ${input.description ?? ''},
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.eventTypes)}::jsonb)),
            ${signingSecret},
            ${principal.kind === 'user' ? principal.userId : null})
    RETURNING id`);

  await recordAudit(db, ctx, {
    action: 'access.role.granted', resourceType: 'webhook_endpoint',
    resourceId: res.rows[0]!.id, source: 'console', severity: 'security',
    reason: `Webhook endpoint registered for ${parsed.host}`,
    after: { host: parsed.host, eventTypes: input.eventTypes },
  });

  return { id: res.rows[0]!.id, signingSecret };
}

/** Queues a delivery to every endpoint subscribed to the event's type. */
export async function queueDeliveries(
  db: Database,
  input: { eventId: string; eventType: string; payload: Record<string, unknown> },
): Promise<number> {
  const endpoints = await db.execute<{ id: string; signing_secret: string }>(sql`
    SELECT id, signing_secret FROM webhook_endpoints
     WHERE status = 'active'
       AND (cardinality(event_types) = 0 OR ${input.eventType} = ANY(event_types))`);

  const body = JSON.stringify({
    id: input.eventId, type: input.eventType,
    createdAt: new Date().toISOString(), data: input.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);

  let queued = 0;
  for (const endpoint of endpoints.rows) {
    const res = await db.execute(sql`
      INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, signature,
                                      next_attempt_at)
      VALUES (${endpoint.id}, ${input.eventId}, ${input.eventType}, ${body}::jsonb,
              ${signPayload(endpoint.signing_secret, body, timestamp)}, now())
      ON CONFLICT (endpoint_id, event_id) DO NOTHING
      RETURNING id`);
    queued += res.rows.length;
  }
  return queued;
}

/**
 * Records the outcome of an attempt. Backoff is exponential, and an endpoint
 * that keeps failing is disabled rather than retried indefinitely - a dead URL
 * generating retries forever is how queues fill up unnoticed.
 */
export async function recordDeliveryOutcome(
  db: Database,
  input: {
    deliveryId: string; endpointId: string;
    success: boolean; responseStatus?: number; responseBody?: string;
  },
): Promise<{ status: string; nextAttemptAt: Date | null; endpointDisabled: boolean }> {
  if (input.success) {
    await db.execute(sql`
      UPDATE webhook_deliveries
         SET status = 'delivered', delivered_at = now(), attempt = attempt + 1,
             response_status = ${input.responseStatus ?? 200}, next_attempt_at = NULL
       WHERE id = ${input.deliveryId}`);
    await db.execute(sql`
      UPDATE webhook_endpoints SET consecutive_failures = 0, status = 'active'
       WHERE id = ${input.endpointId}`);
    return { status: 'delivered', nextAttemptAt: null, endpointDisabled: false };
  }

  const res = await db.execute<{ attempt: number }>(sql`
    UPDATE webhook_deliveries
       SET attempt = attempt + 1,
           response_status = ${input.responseStatus ?? null},
           response_body = ${input.responseBody?.slice(0, 2000) ?? null}
     WHERE id = ${input.deliveryId}
    RETURNING attempt`);

  const attempt = res.rows[0]?.attempt ?? 1;
  const maxAttempts = 8;

  if (attempt >= maxAttempts) {
    await db.execute(sql`
      UPDATE webhook_deliveries SET status = 'abandoned', next_attempt_at = NULL
       WHERE id = ${input.deliveryId}`);
  } else {
    const backoffSeconds = Math.min(3600, 2 ** attempt * 10);
    await db.execute(sql`
      UPDATE webhook_deliveries
         SET status = 'pending',
             next_attempt_at = now() + (${String(backoffSeconds)} || ' seconds')::interval
       WHERE id = ${input.deliveryId}`);
  }

  const endpoint = await db.execute<{ consecutive_failures: number }>(sql`
    UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1
     WHERE id = ${input.endpointId}
    RETURNING consecutive_failures`);

  const failures = endpoint.rows[0]?.consecutive_failures ?? 0;
  const disabled = failures >= 20;
  if (disabled) {
    await db.execute(sql`
      UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ${input.endpointId}`);
  } else if (failures >= 5) {
    await db.execute(sql`
      UPDATE webhook_endpoints SET status = 'failing' WHERE id = ${input.endpointId}`);
  }

  return {
    status: attempt >= maxAttempts ? 'abandoned' : 'pending',
    nextAttemptAt: attempt >= maxAttempts
      ? null : new Date(Date.now() + Math.min(3600, 2 ** attempt * 10) * 1000),
    endpointDisabled: disabled,
  };
}
