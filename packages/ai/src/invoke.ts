import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import { assembleContext } from './context.js';
import { capability, jsonSchemaOf, systemPromptOf, type CapabilityDefinition } from './capabilities/registry.js';
import { validateOutput, AiProviderError, AiOutputInvalidError, type AiProvider } from './provider.js';

export class CapabilityNotEnabledError extends Error {
  constructor(key: string) {
    super(`AI capability "${key}" is not enabled for this firm`);
    this.name = 'CapabilityNotEnabledError';
  }
}

export class CapabilityUnknownError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a known AI capability`);
    this.name = 'CapabilityUnknownError';
  }
}

export interface InvocationResult<T = unknown> {
  invocationId: string;
  output: T;
  provider: string;
  model: string;
  /** True when the deterministic stub answered because no model is configured. */
  simulated: boolean;
  withheldFields: string[];
  redactionsApplied: string[];
  costPence: number;
}

export interface InvokeOptions {
  capabilityKey: string;
  caseId?: string | null;
  clientId?: string | null;
  /** Everything the caller has. The capability's allowlist decides what is used. */
  context: Record<string, unknown>;
  source: string;
}

/**
 * Runs an AI capability and records it.
 *
 * The order matters: permission, then enablement, then the allowlist, then the
 * model. Nothing reaches a provider before the platform has established that
 * this principal may ask, that this firm has switched the capability on, and
 * exactly which fields it is entitled to see.
 *
 * The invocation is written whether the call succeeded or failed. A failed
 * invocation is still a fact about the case.
 */
export async function invokeCapability<T = unknown>(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  provider: AiProvider,
  options: InvokeOptions,
): Promise<InvocationResult<T>> {
  requirePermission(principal, 'ai:invoke', { tenantId: ctx.tenantId });

  const definition = capability(options.capabilityKey);
  if (!definition) throw new CapabilityUnknownError(options.capabilityKey);

  await assertEnabled(db, definition);

  const assembled = assembleContext(options.context, definition.permittedFields);

  const request = {
    capabilityKey: definition.key,
    promptVersion: definition.promptVersion,
    systemPrompt: systemPromptOf(definition),
    userPrompt: definition.buildUserPrompt(assembled.payload),
    outputSchema: jsonSchemaOf(definition),
    model: await modelFor(db, definition),
  };

  let output: T | null = null;
  let status: 'completed' | 'failed' = 'completed';
  let errorDetail: string | null = null;
  let model = request.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let confidence: number | null = null;

  try {
    const response = await provider.complete(request);
    output = validateOutput(definition.outputSchema, response.output) as T;
    model = response.model;
    inputTokens = response.inputTokens;
    outputTokens = response.outputTokens;
    latencyMs = response.latencyMs;
    confidence = response.confidence ?? null;
  } catch (error) {
    status = 'failed';
    errorDetail =
      error instanceof AiOutputInvalidError || error instanceof AiProviderError
        ? error.message
        : (error as Error).message;
  }

  const costPence = estimateCostPence(model, inputTokens, outputTokens);

  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO ai_invocations (
      capability_key, prompt_version, provider, model, case_id, client_id,
      requested_by, requested_by_type, source,
      input_references, input_fingerprint, redactions_applied,
      output, output_valid, confidence, status, error_detail,
      input_tokens, output_tokens, cost_pence, latency_ms
    ) VALUES (
      ${definition.key}, ${definition.promptVersion}, ${provider.name}, ${model},
      ${options.caseId ?? null}, ${options.clientId ?? null},
      ${principal.kind === 'user' ? principal.userId : null},
      ${principal.kind === 'user' ? 'user' : principal.kind === 'workflow' ? 'workflow' : 'system'},
      ${options.source},
      ${JSON.stringify(definition.permittedFields.filter((f) => !assembled.missing.includes(f)))}::jsonb,
      ${assembled.fingerprint},
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(assembled.redactionsApplied)}::jsonb)),
      ${output ? JSON.stringify(output) : null}::jsonb,
      ${output !== null}, ${confidence}, ${status}, ${errorDetail},
      ${inputTokens}, ${outputTokens}, ${costPence}, ${latencyMs}
    ) RETURNING id`);

  const invocationId = inserted.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: status === 'completed' ? 'ai.invocation.completed' : 'ai.invocation.requested',
    resourceType: 'ai_invocation',
    resourceId: invocationId,
    caseId: options.caseId ?? null,
    source: `ai:${definition.key}@v${definition.promptVersion}`,
    aiInvocationId: invocationId,
    reason: status === 'failed' ? `Capability failed: ${errorDetail}` : null,
    after: {
      capability: definition.key,
      provider: provider.name,
      model,
      status,
      fieldsProvided: definition.permittedFields.length - assembled.missing.length,
      fieldsWithheld: assembled.withheld.length,
      redactions: assembled.redactionsApplied,
    },
  });

  if (output === null) {
    throw new AiProviderError(errorDetail ?? 'The capability produced no usable output', false);
  }

  return {
    invocationId,
    output,
    provider: provider.name,
    model,
    simulated: provider.name === 'stub',
    withheldFields: assembled.withheld,
    redactionsApplied: assembled.redactionsApplied,
    costPence,
  };
}

async function assertEnabled(db: Database, definition: CapabilityDefinition): Promise<void> {
  const res = await db.execute<{ enabled: boolean }>(sql`
    SELECT enabled FROM ai_capabilities WHERE capability_key = ${definition.key}`);
  const row = res.rows[0];
  const enabled = row ? row.enabled : definition.defaultEnabled;
  if (!enabled) throw new CapabilityNotEnabledError(definition.key);
}

async function modelFor(db: Database, definition: CapabilityDefinition): Promise<string> {
  const res = await db.execute<{ model: string | null }>(sql`
    SELECT model FROM ai_capabilities WHERE capability_key = ${definition.key}`);
  return res.rows[0]?.model ?? process.env['SOLVENDA_AI_MODEL'] ?? 'claude-opus-5';
}

/**
 * Per-million-token rates in pence, so a firm can see what its AI usage costs
 * per case rather than as one line on an invoice.
 */
const RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 400, output: 2_000 },
  'claude-sonnet-5': { input: 160, output: 800 },
  'claude-haiku-4-5': { input: 80, output: 400 },
  'stub-deterministic': { input: 0, output: 0 },
};

export function estimateCostPence(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES[model] ?? RATES['claude-opus-5']!;
  return Math.round((inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output);
}
