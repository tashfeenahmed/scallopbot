/**
 * Moonshot AI (Kimi) Provider
 *
 * Moonshot AI provides the Kimi model family with OpenAI-compatible API.
 * https://platform.moonshot.ai/
 *
 * Models (as of 2026):
 * - kimi-k2.5: Latest multimodal agentic model, 1T params, agent swarm capable
 * - kimi-k2.5-thinking: Reasoning variant with extended thinking
 * - kimi-k2-0905: Previous MoE model, 256K context, good for agents
 * - kimi-k2-thinking: K2 reasoning model for complex tasks
 * - moonshot-v1-128k/32k/8k: Legacy models with varying context
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';

/**
 * Moonshot/Kimi Model IDs
 */
export const MOONSHOT_MODELS = {
  // Kimi K2.5 (Latest - multimodal agentic)
  'kimi-k2.5': 'kimi-k2.5',
  'kimi-k2.5-thinking': 'kimi-k2.5-thinking',
  // Kimi K2
  'kimi-k2': 'kimi-k2-0905',
  'kimi-k2-thinking': 'kimi-k2-thinking',
  // Legacy Moonshot models
  'moonshot-v1-128k': 'moonshot-v1-128k',
  'moonshot-v1-32k': 'moonshot-v1-32k',
  'moonshot-v1-8k': 'moonshot-v1-8k',
  // Aliases
  'kimi': 'kimi-k2.5',
} as const;

const DEFAULT_MODEL = 'moonshot-v1-128k';
const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_STATUS_CODES = [429, 500, 503];
const RETRY_DELAY_MS = 1000;

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
}

export class MoonshotProvider implements LLMProvider {
  public readonly name = 'moonshot';
  public readonly model: string;
  public readonly characteristics: ProviderCharacteristics = {
    speed: 'fast', // Kimi K2 is optimized for speed
    costPerMillionTokens: 1.5, // Approximate pricing
    isLocal: false,
  };

  private client: OpenAI;
  private apiKey: string;
  private maxRetries: number;

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;

    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: options.baseUrl || DEFAULT_BASE_URL,
      ...(options.timeout && { timeout: options.timeout }),
    });
  }

  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);

    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.stopSequences && { stop: request.stopSequences }),
      ...(request.tools && { tools: this.formatTools(request.tools) }),
    };

    const response = await this.executeWithRetry(() =>
      this.client.chat.completions.create(params)
    );

    return this.formatResponse(response);
  }

  private formatMessages(
    request: CompletionRequest
  ): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system message if present
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }

    // Add conversation messages
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({
          role: msg.role,
          content: msg.content,
        } as OpenAI.ChatCompletionMessageParam);
      } else {
        // Handle content blocks (tool results, etc.)
        const toolResults = msg.content.filter((c) => c.type === 'tool_result');
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
          const textContent = msg.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { type: 'text'; text: string }).text)
            .join('\n');

          const toolCalls = msg.content
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
            // Note: For Moonshot/Kimi, when assistant has tool_calls but no text,
            // we should omit content entirely rather than sending null,
            // to avoid triggering "thinking is enabled" validation errors.
            const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
              role: 'assistant',
              ...(textContent ? { content: textContent } : {}),
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            };
            messages.push(assistantMsg);
          } else {
            messages.push({
              role: 'user',
              content: textContent,
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

    // Add text content - Kimi K2.5 may use reasoning_content instead of content
    const message = choice.message as OpenAI.ChatCompletionMessage & { reasoning_content?: string };
    const textContent = message.content || message.reasoning_content;
    if (textContent) {
      content.push({ type: 'text', text: textContent });
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if ('function' in toolCall && toolCall.function) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          });
        }
      }
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
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
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof OpenAI.APIError) {
          if (RETRY_STATUS_CODES.includes(error.status)) {
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
