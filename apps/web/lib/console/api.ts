import { NextResponse } from 'next/server';
import { sql, withTenant, withPlatform, type Database, type TenantContext } from '@solvenda/db';
import { resolveApiKey, checkRateLimit } from '@solvenda/integrations';
import { authorize, type Principal } from '@solvenda/auth';

/**
 * The public API edge.
 *
 * Every request goes through the same path: resolve the key, check the scope,
 * check the rate limit, run inside the key's tenant, record the request. The
 * handler itself never sees a tenant id it could get wrong, because the
 * connection is already bound to one.
 *
 * Errors follow one shape. An integrator debugging at 2am should not have to
 * guess which of four error formats they are looking at.
 */

export interface ApiContext {
  db: Database;
  principal: Principal;
  tenantId: string;
  ctx: TenantContext;
  environment: string;
}

export type ApiHandler = (
  request: Request,
  context: ApiContext,
  params: Record<string, string>,
) => Promise<NextResponse>;

export function apiError(
  status: number,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...detail } }, { status });
}

const PLATFORM_OPERATOR = process.env['SOLVENDA_SIGNIN_OPERATOR_ID']
  ?? '00000000-0000-0000-0000-000000000000';

/**
 * Wraps a handler with authentication, authorisation, rate limiting and
 * request logging.
 *
 * `requiredScope` is a permission key. Regulated permissions are rejected at
 * key creation, so an endpoint can never be reached by a key that would have
 * needed one.
 */
export function withApiKey(requiredScope: string, handler: ApiHandler) {
  // Next requires the second argument to be non-optional and to carry a
  // `params` promise, even for routes with no dynamic segment.
  return async (
    request: Request,
    routeContext: { params: Promise<Record<string, string | string[]>> },
  ): Promise<NextResponse> => {
    const started = Date.now();
    const url = new URL(request.url);

    const header = request.headers.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!presented) {
      return apiError(401, 'unauthenticated',
        'Provide an API key as "Authorization: Bearer sk_...".');
    }

    // The key is all the caller presents, so the tenant is not yet known. The
    // lookup runs in platform context and returns an identifier only.
    const resolved = await withPlatform(
      { operatorId: PLATFORM_OPERATOR, reason: 'resolve API key at the public API edge' },
      (db) => resolveApiKey(db, presented),
    ).catch(() => null);

    if (!resolved) {
      return apiError(401, 'invalid_key', 'That API key is not valid, or has been revoked.');
    }

    const principal: Principal = {
      kind: 'api_key',
      tenantId: resolved.tenantId,
      keyId: resolved.id,
      scopes: resolved.scopes,
    };

    const decision = authorize(principal, requiredScope, { tenantId: resolved.tenantId });
    if (!decision.allowed) {
      await logRequest(resolved.tenantId, resolved.id, request.method, url.pathname, 403,
        Date.now() - started);
      return apiError(403, decision.code, decision.message, { requiredScope });
    }

    const ctx: TenantContext = {
      tenantId: resolved.tenantId,
      actorType: 'api_key',
      actorLabel: `api_key:${resolved.id}`,
      requestId: request.headers.get('x-request-id') ?? undefined,
    };

    const limit = await withTenant(ctx, (db) =>
      checkRateLimit(db, resolved.id, resolved.rateLimitPerMinute));
    if (!limit.allowed) {
      await logRequest(resolved.tenantId, resolved.id, request.method, url.pathname, 429,
        Date.now() - started);
      return NextResponse.json(
        { error: { code: 'rate_limited',
                   message: `Rate limit of ${limit.limit} requests a minute exceeded.` } },
        { status: 429, headers: {
          'retry-after': String(limit.resetsInSeconds),
          'x-ratelimit-limit': String(limit.limit),
          'x-ratelimit-remaining': '0',
        } },
      );
    }

    const raw = (await routeContext?.params) ?? {};
    const params = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : v]),
    ) as Record<string, string>;

    let response: NextResponse;
    try {
      response = await withTenant(ctx, (db) =>
        handler(request, {
          db, principal, tenantId: resolved.tenantId, ctx, environment: resolved.environment,
        }, params));
    } catch (error) {
      console.error('[api] handler failed', error);
      response = apiError(500, 'internal_error', 'Something went wrong handling that request.');
    }

    response.headers.set('x-ratelimit-limit', String(limit.limit));
    response.headers.set('x-ratelimit-remaining', String(Math.max(0, limit.limit - limit.used - 1)));

    await logRequest(resolved.tenantId, resolved.id, request.method, url.pathname,
      response.status, Date.now() - started,
      request.headers.get('idempotency-key'));

    return response;
  };
}

async function logRequest(
  tenantId: string, apiKeyId: string, method: string, path: string,
  statusCode: number, durationMs: number, idempotencyKey?: string | null,
): Promise<void> {
  await withTenant({ tenantId, actorType: 'api_key' }, (db) => db.execute(sql`
    INSERT INTO api_requests (api_key_id, method, path, status_code, duration_ms, idempotency_key)
    VALUES (${apiKeyId}, ${method}, ${path}, ${statusCode}, ${durationMs},
            ${idempotencyKey ?? null})`)).catch(() => undefined);
}

/** Cursor pagination: stable under insertion, unlike offsets. */
export function paginationFrom(url: URL): { limit: number; cursor: string | null } {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '25'), 1), 100);
  return { limit, cursor: url.searchParams.get('cursor') };
}
