import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type AiProvider, type AiRequest, type AiResponse } from '../provider.js';
import { StubAiProvider } from './stub.js';

/**
 * Anthropic-backed provider.
 *
 * Structured output is obtained through strict tool use rather than by asking
 * for JSON in the prompt: the capability's schema becomes a tool the model is
 * required to call, so the response either validates or the call fails. Parsing
 * prose for JSON is not an acceptable failure mode when the output feeds a
 * proposal an adviser will act on.
 */

const DEFAULT_MODEL = 'claude-opus-5';
const RESPONSE_TOOL = 'record_result';

export interface AnthropicProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(options: AnthropicProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new AiProviderError(
        'ANTHROPIC_API_KEY is not configured. The platform falls back to the ' +
          'deterministic stub provider when no model is available.',
        false,
      );
    }
    this.client = new Anthropic({
      apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 120_000,
    });
    this.defaultModel = options.defaultModel ?? process.env['SOLVENDA_AI_MODEL'] ?? DEFAULT_MODEL;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const model = request.model || this.defaultModel;
    const started = Date.now();

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens ?? 8_000,
        system: request.systemPrompt,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        tools: [
          {
            name: RESPONSE_TOOL,
            description:
              'Record the structured result. Every field must be populated from the ' +
              'case information provided; do not infer facts that are not present.',
            input_schema: request.outputSchema as Anthropic.Tool.InputSchema,
            strict: true,
          },
        ],
        tool_choice: { type: 'tool', name: RESPONSE_TOOL },
        messages: [{ role: 'user', content: request.userPrompt }],
      });

      if (response.stop_reason === 'refusal') {
        throw new AiProviderError(
          `The model declined this request (${response.stop_details?.category ?? 'unspecified'}). ` +
            'The capability returns no output; the adviser continues unassisted.',
          false,
        );
      }

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use' && block.name === RESPONSE_TOOL,
      );
      if (!toolUse) {
        throw new AiProviderError('The model returned no structured result', true);
      }

      return {
        // Tool inputs are parsed JSON already; never string-match on them.
        output: toolUse.input,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
        confidence: null,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Anthropic.RateLimitError) {
        throw new AiProviderError('Model provider rate limit reached', true);
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new AiProviderError('Could not reach the model provider', true);
      }
      if (error instanceof Anthropic.APIError) {
        throw new AiProviderError(`Model provider error ${error.status}: ${error.message}`,
          error.status !== undefined && error.status >= 500);
      }
      throw new AiProviderError((error as Error).message, false);
    }
  }
}

/**
 * Chooses a provider. Absent credentials the platform does not fail - it uses
 * the deterministic stub, and the console labels output accordingly. A firm
 * without a model configured still gets a working platform, minus the
 * assistance.
 */
export function resolveProvider(options: AnthropicProviderOptions = {}): AiProvider {
  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  // Imported statically. A lazy `require` here was unreachable in an ES module
  // and would have thrown the first time anything called this — which nothing
  // did, until now.
  if (!apiKey) return new StubAiProvider();
  return new AnthropicAiProvider(options);
}
