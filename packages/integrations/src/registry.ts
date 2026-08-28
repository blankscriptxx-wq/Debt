import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { AdapterContext, AdapterResult, AnyAdapter } from './contracts.js';
import { SIMULATED_PROVIDERS } from './simulators/index.js';

/**
 * The integration registry and runner.
 *
 * Two responsibilities. It resolves an installed provider to an adapter, and it
 * records every call a firm makes to a third party - operation, summary,
 * outcome, duration - so "what did you send about me to the credit reference
 * agency" has an answer.
 *
 * Adapters never hold credentials. They ask the context for a named secret, and
 * the context asks the database, which decrypts inside a SECURITY DEFINER
 * function scoped to that firm. An adapter with a bug cannot exfiltrate a key
 * it was never given.
 */

export class IntegrationError extends Error {
  constructor(message: string, public readonly code:
    'not-installed' | 'paused' | 'unknown-provider' | 'no-secret') {
    super(message);
    this.name = 'IntegrationError';
  }
}

interface ProviderEntry {
  key: string;
  name: string;
  category: string;
  description: string;
  requiredSecrets: readonly string[];
  simulated: boolean;
  adapter: () => AnyAdapter;
}

const ADAPTERS = new Map<string, ProviderEntry>(
  SIMULATED_PROVIDERS.map((p) => [p.key, p as unknown as ProviderEntry]),
);

export function knownProviders() {
  return SIMULATED_PROVIDERS.map((p) => ({
    key: p.key, name: p.name, category: p.category,
    description: p.description, requiredSecrets: p.requiredSecrets, simulated: p.simulated,
  }));
}

/** Publishes the provider catalogue. Idempotent. */
export async function publishProviderCatalogue(db: Database): Promise<void> {
  for (const provider of SIMULATED_PROVIDERS) {
    await db.execute(sql`
      INSERT INTO integration_providers (key, name, category, description,
                                         required_secrets, simulated, status)
      VALUES (${provider.key}, ${provider.name}, ${provider.category}, ${provider.description},
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(provider.requiredSecrets)}::jsonb)),
              ${provider.simulated}, 'available')
      ON CONFLICT (key) DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description,
            required_secrets = EXCLUDED.required_secrets, simulated = EXCLUDED.simulated`);
  }
}

export interface InstallInput {
  providerKey: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export async function installIntegration(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: InstallInput,
): Promise<{ installId: string; missingSecrets: string[] }> {
  requirePermission(principal, 'integration:configure', { tenantId: ctx.tenantId });

  const provider = ADAPTERS.get(input.providerKey);
  if (!provider) throw new IntegrationError(`Unknown provider "${input.providerKey}"`, 'unknown-provider');

  const supplied = new Set(Object.keys(input.secrets ?? {}));
  const missingSecrets = provider.requiredSecrets.filter((s) => !supplied.has(s));

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO integration_installs (provider_key, status, config, installed_by)
    VALUES (${input.providerKey},
            ${missingSecrets.length === 0 ? 'active' : 'configuring'},
            ${JSON.stringify(input.config ?? {})}::jsonb,
            ${principal.kind === 'user' ? principal.userId : null})
    ON CONFLICT (tenant_id, provider_key) DO UPDATE
      SET config = EXCLUDED.config,
          status = EXCLUDED.status
    RETURNING id`);

  const installId = res.rows[0]!.id;

  if (input.secrets && Object.keys(input.secrets).length > 0) {
    // Written through a function that encrypts; the plaintext is a parameter,
    // never a column value.
    await db.execute(sql`
      SELECT app.store_integration_secrets(${installId}, ${JSON.stringify(input.secrets)}::jsonb)`);
  }

  await recordAudit(db, ctx, {
    action: 'access.role.granted',
    resourceType: 'integration_install',
    resourceId: installId,
    source: 'console',
    severity: 'security',
    reason: `Integration "${input.providerKey}" configured`,
    after: {
      provider: input.providerKey,
      simulated: provider.simulated,
      // Names only. Values never reach the ledger.
      secretsProvided: Object.keys(input.secrets ?? {}),
      missingSecrets,
    },
  });

  return { installId, missingSecrets };
}

export async function resolveAdapter(
  db: Database,
  providerKey: string,
): Promise<{ adapter: AnyAdapter; installId: string; config: Record<string, unknown>;
             simulated: boolean }> {
  const res = await db.execute<{ id: string; status: string; config: Record<string, unknown> }>(sql`
    SELECT id, status, config FROM integration_installs WHERE provider_key = ${providerKey}`);
  const install = res.rows[0];
  if (!install) {
    throw new IntegrationError(`"${providerKey}" is not installed for this firm`, 'not-installed');
  }
  if (install.status !== 'active') {
    throw new IntegrationError(`"${providerKey}" is ${install.status}`, 'paused');
  }

  const provider = ADAPTERS.get(providerKey);
  if (!provider) throw new IntegrationError(`Unknown provider "${providerKey}"`, 'unknown-provider');

  return {
    adapter: provider.adapter(),
    installId: install.id,
    config: install.config ?? {},
    simulated: provider.simulated,
  };
}

export function adapterContext(
  db: Database,
  ctx: TenantContext,
  install: { installId: string; config: Record<string, unknown> },
  caseId?: string | null,
  clientId?: string | null,
): AdapterContext {
  return {
    tenantId: ctx.tenantId,
    caseId: caseId ?? null,
    clientId: clientId ?? null,
    config: install.config,
    secret: async (name: string) => {
      const res = await db.execute<{ secret: string | null }>(sql`
        SELECT app.integration_secret(${install.installId}, ${name}) AS secret`);
      return res.rows[0]?.secret ?? null;
    },
  };
}

/**
 * Runs one adapter operation and records it. Every third-party call goes
 * through here so none of them can be invisible.
 */
export async function runIntegration<T>(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: {
    providerKey: string;
    operation: string;
    caseId?: string | null;
    clientId?: string | null;
  },
  call: (adapter: AnyAdapter, adapterCtx: AdapterContext) => Promise<AdapterResult<T>>,
): Promise<AdapterResult<T>> {
  requirePermission(principal, 'case:read', { tenantId: ctx.tenantId });

  const resolved = await resolveAdapter(db, input.providerKey);
  const adapterCtx = adapterContext(db, ctx, resolved, input.caseId, input.clientId);

  const started = Date.now();
  let result: AdapterResult<T>;
  try {
    result = await call(resolved.adapter, adapterCtx);
  } catch (error) {
    result = {
      ok: false, data: null, error: (error as Error).message,
      requestSummary: { operation: input.operation },
      responseSummary: { threw: true },
    };
  }
  const duration = Date.now() - started;

  await db.execute(sql`
    INSERT INTO integration_calls (install_id, provider_key, operation, case_id, client_id,
                                   request_summary, response_summary, status, error_detail,
                                   duration_ms, simulated, requested_by)
    VALUES (${resolved.installId}, ${input.providerKey}, ${input.operation},
            ${input.caseId ?? null}, ${input.clientId ?? null},
            ${JSON.stringify(result.requestSummary)}::jsonb,
            ${JSON.stringify(result.responseSummary)}::jsonb,
            ${result.ok ? 'succeeded' : 'failed'}, ${result.error ?? null},
            ${duration}, ${resolved.simulated},
            ${principal.kind === 'user' ? principal.userId : null})`);

  await db.execute(sql`
    UPDATE integration_installs SET last_used_at = now(),
           last_error = ${result.ok ? null : (result.error ?? 'failed')}
     WHERE id = ${resolved.installId}`);

  return result;
}
