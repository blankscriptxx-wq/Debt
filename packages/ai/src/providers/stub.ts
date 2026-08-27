import { createHash } from 'node:crypto';
import type { AiProvider, AiRequest, AiResponse } from '../provider.js';

/**
 * A deterministic provider used when no model credentials are configured.
 *
 * It is not a mock in the testing sense - it is the platform's behaviour when a
 * firm has not enabled a model, and it is what CI runs against. Output is
 * derived from a hash of the request, so the same input always produces the
 * same answer and a test can assert on it without a network call.
 *
 * Everything above it - the ledger, the permitted-field allowlist, the proposal
 * gate, the human approval requirement - behaves identically whichever provider
 * is in use. That is the point: the safety model is not a property of the
 * model vendor.
 */
export class StubAiProvider implements AiProvider {
  readonly name = 'stub';

  async complete(request: AiRequest): Promise<AiResponse> {
    const seed = createHash('sha256')
      .update(`${request.capabilityKey}:${request.promptVersion}:${request.userPrompt}`)
      .digest();

    const output = synthesise(request, seed);

    return {
      output,
      model: 'stub-deterministic',
      inputTokens: Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4),
      outputTokens: Math.ceil(JSON.stringify(output).length / 4),
      latencyMs: 0,
      confidence: 0.5 + (seed[0]! / 255) * 0.4,
    };
  }
}

/**
 * Produces a value satisfying the capability's JSON Schema. Deliberately
 * simple: it walks the schema and fills each property with a stable value
 * derived from the seed, so validation exercises the real path.
 */
function synthesise(request: AiRequest, seed: Buffer): unknown {
  return fill(request.outputSchema as JsonSchema, seed, 0, request.capabilityKey);
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  required?: string[];
  minItems?: number;
}

function fill(schema: JsonSchema | undefined, seed: Buffer, depth: number, capability: string): unknown {
  if (!schema || depth > 8) return null;
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[seed[depth % seed.length]! % schema.enum.length];
  }

  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        out[key] = fill(child, seed, depth + 1, `${capability}.${key}`);
      }
      return out;
    }
    case 'array': {
      const count = Math.max(schema.minItems ?? 0, 1);
      return Array.from({ length: count }, (_, i) =>
        fill(schema.items, seed, depth + 1 + i, capability));
    }
    case 'number':
      return Number(((seed[depth % seed.length]! / 255) * 0.9 + 0.05).toFixed(3));
    case 'integer':
      return seed[depth % seed.length]! % 100;
    case 'boolean':
      return seed[depth % seed.length]! % 2 === 0;
    case 'string':
    default:
      return `[stub output for ${capability}; no model is configured]`;
  }
}
