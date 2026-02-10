import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StreamEvent,
} from './types.js';
import { DEFAULT_MAX_RETRIES, RETRY_STATUS_CODES, RETRY_DELAY_MS } from './constants.js';

/**
 * Claude Model IDs (as of 2025)
 *
 * Claude 4.5 Family (Latest):
 * - claude-opus-4-5-20251101: Most capable, best for complex tasks
 * - claude-sonnet-4-5-20250929: Balanced performance/cost, 1M context (preview)
 *
 * Claude 4 Family:
 * - claude-opus-4-1-20250801: Industry leader for coding and agents
 * - claude-sonnet-4-20250514: Standard balanced model
 *
 * Aliases (auto-migrate to latest):
 * - claude-opus-4-5-latest
 * - claude-sonnet-4-5-latest
 * - claude-opus-4-latest
 * - claude-sonnet-4-latest
 */
export const ANTHROPIC_MODELS = {
  // Claude 4.5 (Latest)
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  // Claude 4
  'claude-opus-4-1': 'claude-opus-4-1-20250801',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  // Aliases
  'opus': 'claude-opus-4-5-20251101',
  'sonnet': 'claude-sonnet-4-5-20250929',
} as const;

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicProvider implements LLMProvider {
  public readonly name = 'anthropic';
  public readonly model: string;

  private client: Anthropic;
  private apiKey: string;
  private maxRetries: number;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;

    this.client = new Anthropic({
      apiKey: this.apiKey,
      ...(options.baseUrl && { baseURL: options.baseUrl }),
      ...(options.timeout && { timeout: options.timeout }),
    });
  }

  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      messages: this.formatMessages(request.messages),
      max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS,
      ...(request.system && { system: request.system }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.stopSequences && { stop_sequences: request.stopSequences }),
      ...(request.tools && { tools: this.formatTools(request.tools) }),
    };

    const response = await this.executeWithRetry(() =>
      this.client.messages.create(params)
    );

    return this.formatResponse(response);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      messages: this.formatMessages(request.messages),
      max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS,
      stream: true,
      ...(request.system && { system: request.system }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.stopSequences && { stop_sequences: request.stopSequences }),
      ...(request.tools && { tools: this.formatTools(request.tools) }),
    };

    const stream = await this.client.messages.create(params);

    for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
      yield this.formatStreamEvent(event);
    }
  }

  private formatMessages(messages: CompletionRequest['messages']): Anthropic.MessageParam[] {
    return messages.map((msg) => ({
      role: msg.role,
      // Filter out 'thinking' blocks from other providers (e.g., Moonshot)
      content: Array.isArray(msg.content)
        ? msg.content.filter((b) => b.type !== 'thinking') as unknown as Anthropic.ContentBlockParam[]
        : msg.content,
    }));
  }

  private formatTools(tools: NonNullable<CompletionRequest['tools']>): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
    }));
  }

  private formatResponse(response: Anthropic.Message): CompletionResponse {
    return {
      content: response.content as ContentBlock[],
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }

  private mapStopReason(
    reason: Anthropic.Message['stop_reason']
  ): CompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }

  private formatStreamEvent(event: Anthropic.MessageStreamEvent): StreamEvent {
    switch (event.type) {
      case 'content_block_start':
        return {
          type: 'content_block_start',
          index: event.index,
          contentBlock: event.content_block as ContentBlock,
        };
      case 'content_block_delta':
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: event.delta as StreamEvent['delta'],
        };
      case 'content_block_stop':
        return {
          type: 'content_block_stop',
          index: event.index,
        };
      case 'message_stop':
        return {
          type: 'message_stop',
        };
      default:
        return { type: 'message_stop' };
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Check if it's a retryable error
        if (error instanceof Anthropic.APIError) {
          if (RETRY_STATUS_CODES.includes(error.status)) {
            // Wait before retrying
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt));
            continue;
          }
        }

        // Non-retryable error, throw immediately
        throw error;
      }
    }

    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
