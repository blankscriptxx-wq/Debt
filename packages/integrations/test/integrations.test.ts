import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, PERMISSIONS, type Principal } from '@solvenda/auth';
import {
  publishProviderCatalogue, installIntegration, runIntegration, resolveAdapter,
  createApiKey, resolveApiKey, revokeApiKey, checkRateLimit, ApiKeyError,
  createEndpoint, queueDeliveries, recordDeliveryOutcome, signPayload, verifySignature,
  knownProviders, IntegrationError,
  type OpenBankingAdapter, type CreditReferenceAdapter, type PaymentsAdapter,
} from '@solvenda/integrations';

let tenant: TestTenant;
let other: TestTenant;
let caseId: string;
let clientId: string;

function admin(t: TestTenant): Principal {
  return {
    kind: 'user', tenantId: t.id, userId: t.userId,
    permissions: new Set(['integration:configure', 'case:read']),
    competencies: [], mfaSatisfied: true, status: 'active',
  };
}

beforeAll(async () => {
  const operatorId = await ensureTestOperator();
  await seedGlobalCatalogues(operatorId);
  await withPlatform({ operatorId, reason: 'publish integration providers' },
    (db) => publishProviderCatalogue(db));

  tenant = await createTestTenant('integrations');
  other = await createTestTenant('integrations-other');

  const ids = await tenant.as(async (db) => {
    const c = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name, date_of_birth,
                           address_line1, address_postcode)
      VALUES ('CL-1','Joanne','Whitfield','1985-03-12','9 New Road','AB1 2CD') RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage)
      VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'fact-find') RETURNING id`);
    return { clientId: c.rows[0]!.id, caseId: k.rows[0]!.id };
  });
  clientId = ids.clientId;
  caseId = ids.caseId;
});

afterAll(async () => { await closeDatabase(); });

describe('the provider catalogue', () => {
  it('is honest that every shipped adapter is a simulator', () => {
    // Nothing here is live, and nothing pretends to be.
    expect(knownProviders().every((p) => p.simulated)).toBe(true);
    expect(knownProviders().map((p) => p.category)).toEqual(
      expect.arrayContaining(['open-banking', 'credit-reference',
                              'identity-verification', 'e-signature', 'payments']));
  });

  it('refuses to run a provider the firm has not installed', async () => {
    await expect(
      tenant.as((db) => resolveAdapter(db, 'sandbox-open-banking')),
    ).rejects.toThrow(IntegrationError);
  });
});

describe('installing', () => {
  it('reports which secrets are still missing rather than half-working', async () => {
    const partial = await tenant.as((db) => installIntegration(db, tenant.context, admin(tenant), {
      providerKey: 'sandbox-open-banking', secrets: { clientId: 'abc' },
    }));
    expect(partial.missingSecrets).toEqual(['clientSecret']);

    const status = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string }>(sql`
        SELECT status FROM integration_installs WHERE provider_key = 'sandbox-open-banking'`);
      return r.rows[0]!.status;
    });
    expect(status).toBe('configuring');
  });

  it('activates once every secret is supplied', async () => {
    const complete = await tenant.as((db) => installIntegration(db, tenant.context, admin(tenant), {
      providerKey: 'sandbox-open-banking',
      secrets: { clientId: 'abc', clientSecret: 'shhh' },
      config: { environment: 'sandbox' },
    }));
    expect(complete.missingSecrets).toEqual([]);
  });

  it('never writes a secret value into the audit ledger', async () => {
    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT after_state FROM audit_events
         WHERE resource_type = 'integration_install' ORDER BY seq DESC LIMIT 1`);
      return JSON.stringify(r.rows[0]!);
    });
    expect(event).toContain('secretsProvided');
    expect(event).toContain('clientSecret');   // the name
    expect(event).not.toContain('shhh');       // never the value
  });

  it('stores secrets encrypted, not as readable columns', async () => {
    const raw = await tenant.as(async (db) => {
      const r = await db.execute<{ blob: string | null }>(sql`
        SELECT encode(secrets_encrypted, 'escape') AS blob FROM integration_installs
         WHERE provider_key = 'sandbox-open-banking'`);
      return r.rows[0]!.blob ?? '';
    });
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain('shhh');
  });

  it('lets the adapter read its own secret, and no other firm read it', async () => {
    const mine = await tenant.as(async (db) => {
      const r = await db.execute<{ secret: string | null }>(sql`
        SELECT app.integration_secret(
          (SELECT id FROM integration_installs WHERE provider_key = 'sandbox-open-banking'),
          'clientSecret') AS secret`);
      return r.rows[0]!.secret;
    });
    expect(mine).toBe('shhh');

    // Another firm cannot even see the install row, so there is nothing to decrypt.
    const theirs = await other.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM integration_installs`);
      return Number(r.rows[0]!.n);
    });
    expect(theirs).toBe(0);
  });

  it('refuses installation without the configure permission', async () => {
    await expect(
      tenant.as((db) => installIntegration(db, tenant.context,
        { ...admin(tenant), permissions: new Set(['case:read']) },
        { providerKey: 'sandbox-identity' })),
    ).rejects.toThrow(/integration:configure/);
  });
});

describe('running an integration', () => {
  beforeAll(async () => {
    for (const providerKey of ['sandbox-credit-reference', 'sandbox-identity', 'sandbox-payments']) {
      await tenant.as((db) => installIntegration(db, tenant.context, admin(tenant), {
        providerKey,
        secrets: providerKey === 'sandbox-payments'
          ? { apiKey: 'k', creditorId: 'c' } : { apiKey: 'k' },
      }));
    }
  });

  it('returns bank data shaped for comparison against the declared statement', async () => {
    const result = await tenant.as((db) => runIntegration(db, tenant.context, admin(tenant),
      { providerKey: 'sandbox-open-banking', operation: 'fetchSnapshot', caseId, clientId },
      (adapter, ctx) => (adapter as OpenBankingAdapter)
        .fetchSnapshot(ctx, { consentId: 'consent_test', months: 3 })));

    expect(result.ok).toBe(true);
    expect(result.data!.periodMonths).toBe(3);
    expect(Object.keys(result.data!.categorisedMonthlyTotals))
      .toContain('food-and-housekeeping');
    // Categorisation carries a confidence: a suggestion is not a fact.
    expect(result.data!.transactions.every(
      (t) => t.suggestedCategory === null || typeof t.categoryConfidence === 'number')).toBe(true);
  });

  it('records every third-party call, with a summary rather than the payload', async () => {
    const call = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM integration_calls ORDER BY created_at DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(call['provider_key']).toBe('sandbox-open-banking');
    expect(call['operation']).toBe('fetchSnapshot');
    expect(call['status']).toBe('succeeded');
    expect(call['simulated']).toBe(true);
    expect(call['case_id']).toBe(caseId);
    expect(JSON.stringify(call['response_summary'])).toContain('transactionCount');
  });

  it('only ever performs a soft credit search', async () => {
    const result = await tenant.as((db) => runIntegration(db, tenant.context, admin(tenant),
      { providerKey: 'sandbox-credit-reference', operation: 'softSearch', caseId, clientId },
      (adapter, ctx) => (adapter as CreditReferenceAdapter).softSearch(ctx, {
        firstName: 'Joanne', lastName: 'Whitfield', dateOfBirth: '1985-03-12',
        postcode: 'AB1 2CD', addressLine1: '9 New Road',
      })));

    expect(result.ok).toBe(true);
    // A hard search leaves a footprint on the client's file and is never
    // appropriate for debt advice.
    expect(result.requestSummary['searchType']).toBe('soft');
    expect(result.data!.accounts.length).toBeGreaterThan(0);
  });

  it('records a failure rather than swallowing it', async () => {
    const result = await tenant.as((db) => runIntegration(db, tenant.context, admin(tenant),
      { providerKey: 'sandbox-payments', operation: 'createMandate', caseId, clientId },
      (adapter, ctx) => (adapter as PaymentsAdapter).createMandate(ctx, {
        accountName: 'J Whitfield', reference: 'DMP-1',
        amountPence: 22_000, dayOfMonth: 31,
      })));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/between 1 and 28/);

    const call = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; error_detail: string }>(sql`
        SELECT status, error_detail FROM integration_calls
         WHERE operation = 'createMandate' ORDER BY created_at DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(call.status).toBe('failed');
    expect(call.error_detail).toMatch(/between 1 and 28/);
  });
});

describe('API keys', () => {
  it('shows the key once and stores only its hash', async () => {
    const created = await tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
      name: 'Reporting integration', scopes: ['case:read', 'report:read'],
    }));
    expect(created.key).toContain(created.prefix);

    const stored = await tenant.as(async (db) => {
      const r = await db.execute<{ key_hash: string }>(sql`
        SELECT key_hash FROM api_keys WHERE id = ${created.id}`);
      return r.rows[0]!.key_hash;
    });
    expect(stored).not.toContain(created.key);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a regulated permission at creation, not only at use', async () => {
    // The authorisation engine would reject it anyway. Failing here means the
    // mistake surfaces while someone is looking at it.
    await expect(
      tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
        name: 'Too powerful', scopes: ['case:read', 'advice:decide'],
      })),
    ).rejects.toThrow(ApiKeyError);
  });

  it('rejects an unknown permission', async () => {
    await expect(
      tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
        name: 'Typo', scopes: ['case:raed'],
      })),
    ).rejects.toThrow(/Unknown permissions/);
  });

  it('resolves a valid key and refuses a revoked one', async () => {
    const created = await tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
      name: 'Revocable', scopes: ['case:read'],
    }));

    const resolved = await tenant.as((db) => resolveApiKey(db, created.key));
    expect(resolved?.tenantId).toBe(tenant.id);
    expect(resolved?.scopes.has('case:read')).toBe(true);

    await tenant.as((db) => revokeApiKey(db, tenant.context, admin(tenant),
      { apiKeyId: created.id, reason: 'Integration decommissioned' }));

    expect(await tenant.as((db) => resolveApiKey(db, created.key))).toBeNull();
  });

  it('refuses a key belonging to another firm', async () => {
    const created = await tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
      name: 'Mine', scopes: ['case:read'],
    }));
    // Presented in the wrong tenant's context, the row is simply not visible.
    expect(await other.as((db) => resolveApiKey(db, created.key))).toBeNull();
  });

  it('reports rate limit usage', async () => {
    const created = await tenant.as((db) => createApiKey(db, tenant.context, admin(tenant), {
      name: 'Rate limited', scopes: ['case:read'], rateLimitPerMinute: 2,
    }));
    for (let i = 0; i < 2; i++) {
      await tenant.as((db) => db.execute(sql`
        INSERT INTO api_requests (api_key_id, method, path, status_code)
        VALUES (${created.id}, 'GET', '/v1/cases', 200)`));
    }
    const limit = await tenant.as((db) => checkRateLimit(db, created.id, 2));
    expect(limit.allowed).toBe(false);
    expect(limit.used).toBe(2);
  });
});

describe('webhooks', () => {
  it('requires HTTPS, because payloads carry case data', async () => {
    await expect(
      tenant.as((db) => createEndpoint(db, tenant.context, admin(tenant), {
        url: 'http://example.test/hook', eventTypes: ['case.created'],
      })),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it('signs deliveries so a receiver can verify them', async () => {
    const endpoint = await tenant.as((db) => createEndpoint(db, tenant.context, admin(tenant), {
      url: 'https://example.test/hook', eventTypes: ['case.created'],
    }));

    const payload = JSON.stringify({ id: 'evt_1', type: 'case.created' });
    const now = Math.floor(Date.now() / 1000);
    const signature = signPayload(endpoint.signingSecret, payload, now);

    expect(verifySignature(endpoint.signingSecret, payload, signature, now).valid).toBe(true);
    expect(verifySignature('whsec_wrong', payload, signature, now).valid).toBe(false);
    expect(verifySignature(endpoint.signingSecret, '{"tampered":true}', signature, now).valid)
      .toBe(false);
  });

  it('refuses a replayed delivery outside the window', async () => {
    const secret = 'whsec_test';
    const payload = '{"id":"evt_1"}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = signPayload(secret, payload, old);
    const result = verifySignature(secret, payload, signature);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/replay window/);
  });

  it('queues one delivery per subscribed endpoint, and never twice for the same event', async () => {
    await tenant.as((db) => createEndpoint(db, tenant.context, admin(tenant), {
      url: 'https://example.test/second', eventTypes: ['case.created'],
    }));

    const eventId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO domain_events (event_type, case_id, payload)
        VALUES ('case.created', ${caseId}, '{"reference":"DMP-1"}'::jsonb) RETURNING id`);
      return r.rows[0]!.id;
    });

    const first = await tenant.as((db) => queueDeliveries(db, {
      eventId, eventType: 'case.created', payload: { reference: 'DMP-1' } }));
    expect(first).toBe(2);

    const again = await tenant.as((db) => queueDeliveries(db, {
      eventId, eventType: 'case.created', payload: { reference: 'DMP-1' } }));
    expect(again).toBe(0);
  });

  it('backs off on failure and eventually disables a dead endpoint', async () => {
    const endpoint = await tenant.as((db) => createEndpoint(db, tenant.context, admin(tenant), {
      url: 'https://dead.test/hook', eventTypes: ['case.closed'],
    }));

    const eventId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO domain_events (event_type, case_id, payload)
        VALUES ('case.closed', ${caseId}, '{}'::jsonb) RETURNING id`);
      return r.rows[0]!.id;
    });
    await tenant.as((db) => queueDeliveries(db, {
      eventId, eventType: 'case.closed', payload: {} }));

    const deliveryId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM webhook_deliveries WHERE endpoint_id = ${endpoint.id}`);
      return r.rows[0]!.id;
    });

    const first = await tenant.as((db) => recordDeliveryOutcome(db, {
      deliveryId, endpointId: endpoint.id, success: false, responseStatus: 500 }));
    expect(first.status).toBe('pending');
    expect(first.nextAttemptAt).toBeInstanceOf(Date);

    // A URL that keeps failing is disabled rather than retried forever.
    for (let i = 0; i < 20; i++) {
      await tenant.as((db) => recordDeliveryOutcome(db, {
        deliveryId, endpointId: endpoint.id, success: false, responseStatus: 500 }));
    }
    const status = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string }>(sql`
        SELECT status FROM webhook_endpoints WHERE id = ${endpoint.id}`);
      return r.rows[0]!.status;
    });
    expect(status).toBe('disabled');
  });

  it('clears the failure count on a successful delivery', async () => {
    const endpoint = await tenant.as((db) => createEndpoint(db, tenant.context, admin(tenant), {
      url: 'https://recovers.test/hook', eventTypes: [],
    }));
    const eventId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        INSERT INTO domain_events (event_type, payload)
        VALUES ('case.stage-changed', '{}'::jsonb) RETURNING id`);
      return r.rows[0]!.id;
    });
    await tenant.as((db) => queueDeliveries(db, {
      eventId, eventType: 'case.stage-changed', payload: {} }));
    const deliveryId = await tenant.as(async (db) => {
      const r = await db.execute<{ id: string }>(sql`
        SELECT id FROM webhook_deliveries WHERE endpoint_id = ${endpoint.id}`);
      return r.rows[0]!.id;
    });

    await tenant.as((db) => recordDeliveryOutcome(db, {
      deliveryId, endpointId: endpoint.id, success: false, responseStatus: 502 }));
    await tenant.as((db) => recordDeliveryOutcome(db, {
      deliveryId, endpointId: endpoint.id, success: true, responseStatus: 200 }));

    const state = await tenant.as(async (db) => {
      const r = await db.execute<{ status: string; consecutive_failures: number }>(sql`
        SELECT status, consecutive_failures FROM webhook_endpoints WHERE id = ${endpoint.id}`);
      return r.rows[0]!;
    });
    expect(state.status).toBe('active');
    expect(state.consecutive_failures).toBe(0);
  });
});
