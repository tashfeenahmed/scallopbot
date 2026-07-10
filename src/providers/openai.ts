import OpenAI from 'openai';
import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';
import { flattenSystem } from './types.js';
import { DEFAULT_MAX_RETRIES, RETRY_STATUS_CODES, RETRY_DELAY_MS } from './constants.js';
import { buildCredentialPool, type CredentialPool } from './credential-pool.js';

/** Status codes that mean "this key is exhausted/blocked — try another." */
const KEY_ROTATION_STATUS = new Set([401, 403, 429]);

/**
 * OpenAI Model IDs
 */
export const OPENAI_MODELS = {
  // GPT-5.2 (Latest reasoning)
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.2-pro': 'gpt-5.2-pro',
  // GPT-4.1 (Standard)
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1-nano': 'gpt-4.1-nano',
  // Reasoning models
  'o4-mini': 'o4-mini',
  'o3': 'o3',
  // Legacy
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
} as const;

/** Models that support reasoning_effort parameter */
const REASONING_MODELS = new Set(['gpt-5.2', 'gpt-5.2-pro', 'o3', 'o4-mini']);

const DEFAULT_MODEL = 'gpt-4.1';
// Bumped from 4096 so thinking-heavy models (qwen3.6 on Dell) don't burn the whole
// budget on reasoning_content and return empty visible output. 8192 leaves room for
// ~4k thinking + ~4k actual reply.
const DEFAULT_MAX_TOKENS = 8192;

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
}

export class OpenAIProvider implements LLMProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly characteristics: ProviderCharacteristics = {
    speed: 'standard',
    costPerMillionTokens: 5, // GPT-4o pricing approximate
    isLocal: false,
  };

  private client: OpenAI;
  private apiKey: string;
  private maxRetries: number;
  private baseUrl?: string;
  private timeout?: number;
  /** Multi-key rotation pool (null when only one key is configured). */
  private credentialPool: CredentialPool | null;

  constructor(options: ProviderOptions) {
    this.name = options.name || 'openai';
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout;

    // Credential pool: rotate across multiple free keys to dodge rate limits.
    // Falls back to the single-key path when ≤1 key is supplied.
    this.credentialPool = buildCredentialPool(options.apiKey, options.apiKeys);
    this.apiKey = this.credentialPool ? this.credentialPool.next() : options.apiKey;

    this.client = this.buildClient(this.apiKey);
  }

  private buildClient(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      ...(this.baseUrl && { baseURL: this.baseUrl }),
      ...(this.timeout && { timeout: this.timeout }),
      // Retries, credential rotation, and Router fallback are handled above
      // this SDK. Hidden SDK retries multiply configured request timeouts and
      // can otherwise stall a chat turn for several minutes.
      maxRetries: 0,
    });
  }

  isAvailable(): boolean {
    if (this.credentialPool) return this.credentialPool.availableCount() > 0;
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);
    const isReasoning = REASONING_MODELS.has(this.model);

    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      // Reasoning models use max_completion_tokens instead of max_tokens
      // thinkingBudgetTokens from granular thinking levels can override the default
      ...(isReasoning
        ? { max_completion_tokens: request.thinkingBudgetTokens || request.maxTokens || DEFAULT_MAX_TOKENS }
        : { max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS }),
      ...(request.temperature !== undefined && !isReasoning && { temperature: request.temperature }),
      ...(request.stopSequences && { stop: request.stopSequences }),
      ...(request.tools && { tools: this.formatTools(request.tools) }),
      // Enable reasoning for thinking-capable models
      ...(isReasoning && { reasoning_effort: request.enableThinking ? 'high' : 'medium' }),
    };

    const response = await this.executeWithRetry(() =>
      request.signal
        ? this.client.chat.completions.create(params, { signal: request.signal })
        : this.client.chat.completions.create(params)
    );

    return this.formatResponse(response);
  }

  private formatMessages(
    request: CompletionRequest
  ): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system message if present
    if (request.system) {
      messages.push({ role: 'system', content: flattenSystem(request.system) });
    }

    // Add conversation messages
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({
          role: msg.role,
          content: msg.content,
        } as OpenAI.ChatCompletionMessageParam);
      } else {
        // Filter out 'thinking' blocks from other providers (e.g., Moonshot)
        const contentBlocks = msg.content.filter((b) => b.type !== 'thinking');
        // Handle content blocks (tool results, etc.)
        const toolResults = contentBlocks.filter((c) => c.type === 'tool_result');
        if (toolResults.length > 0 && msg.role === 'user') {
          for (const result of toolResults) {
            if (result.type === 'tool_result') {
              messages.push({
                role: 'tool',
                tool_call_id: result.tool_use_id,
                content: result.content,
              });
            }
          }
        } else {
          // Text and tool_use content
          const textContent = contentBlocks
            .filter((c) => c.type === 'text')
            .map((c) => (c as { type: 'text'; text: string }).text)
            .join('\n');

          const toolCalls = contentBlocks
            .filter((c) => c.type === 'tool_use')
            .map((c) => {
              const toolUse = c as {
                type: 'tool_use';
                id: string;
                name: string;
                input: Record<string, unknown>;
              };
              return {
                id: toolUse.id,
                type: 'function' as const,
                function: {
                  name: toolUse.name,
                  arguments: JSON.stringify(toolUse.input),
                },
              };
            });

          if (msg.role === 'assistant') {
            // Assistant messages can have null content when tool_calls are present
            if (textContent || toolCalls.length > 0) {
              messages.push({
                role: 'assistant',
                content: textContent || null,
                ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
              });
            }
          } else {
            // User messages must have non-empty content — use placeholder if empty
            messages.push({
              role: 'user',
              content: textContent || '[continue]',
            });
          }
        }
      }
    }

    return messages;
  }

  private formatTools(tools: NonNullable<CompletionRequest['tools']>): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private formatResponse(response: OpenAI.ChatCompletion): CompletionResponse {
    const choice = response.choices[0];
    const content: ContentBlock[] = [];

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        // Only handle function tool calls (not custom tool calls)
        if ('function' in toolCall && toolCall.function) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(toolCall.function.arguments);
          } catch {
            // API returned malformed/truncated JSON - use empty input
          }
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          });
        }
      }
    }

    // Extract reasoning tokens if present (GPT-5.2, o3, o4-mini)
    const completionDetails = response.usage?.completion_tokens_details as
      | { reasoning_tokens?: number } | undefined;

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        ...(completionDetails?.reasoning_tokens && {
          reasoningTokens: completionDetails.reasoning_tokens,
        }),
      },
      model: response.model,
    };
  }

  private mapStopReason(
    reason: OpenAI.ChatCompletion.Choice['finish_reason']
  ): CompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await fn();
        // Successful call — mark the active key healthy so it leaves cooldown.
        this.credentialPool?.reportSuccess(this.apiKey);
        return result;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof OpenAI.APIError) {
          const status = error.status;

          // Key-level failure (auth/rate-limit): bench this key and rotate to
          // the next one in the pool before retrying, so one exhausted free key
          // doesn't sink the whole request.
          if (KEY_ROTATION_STATUS.has(status) && this.credentialPool?.canRotate()) {
            this.credentialPool.reportFailure(this.apiKey);
            const nextKey = this.credentialPool.next();
            if (nextKey !== this.apiKey) {
              this.apiKey = nextKey;
              this.client = this.buildClient(nextKey);
            }
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt));
            continue;
          }

          if (RETRY_STATUS_CODES.includes(status)) {
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt));
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
