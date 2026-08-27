import type { z } from 'zod';

/**
 * The provider boundary.
 *
 * Everything above this interface is the platform's safety model - permitted
 * fields, redaction, the invocation ledger, the proposal gate. Everything below
 * is a model vendor. Keeping them separate means a firm can change model or
 * vendor without any of the controls moving, and means the entire suite runs
 * offline against the deterministic stub.
 */

export interface AiRequest {
  capabilityKey: string;
  promptVersion: number;
  systemPrompt: string;
  userPrompt: string;
  /** JSON Schema the response must satisfy. */
  outputSchema: unknown;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiResponse {
  output: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** The provider's own confidence, where it reports one. */
  confidence?: number | null;
}

export interface AiProvider {
  readonly name: string;
  complete(request: AiRequest): Promise<AiResponse>;
}

export class AiProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class AiOutputInvalidError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Model output did not match the capability's schema:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AiOutputInvalidError';
  }
}

export function validateOutput<T>(schema: z.ZodType<T>, output: unknown): T {
  const parsed = schema.safeParse(output);
  if (!parsed.success) {
    throw new AiOutputInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}
