/**
 * xAI (Grok) Provider
 *
 * xAI provides the Grok model family with OpenAI-compatible API.
 * https://x.ai/api
 *
 * Models (as of 2025):
 * - grok-4: Latest flagship reasoning model
 * - grok-4-1-fast-reasoning: Optimized for agentic tasks with reasoning
 * - grok-4-1-fast-non-reasoning: Fast responses without reasoning
 * - grok-3: Previous flagship, 10x compute vs grok-2
 * - grok-3-mini: Smaller, faster grok-3
 * - grok-2-vision-1212: Vision model
 * - grok-2-image-1212: Image generation
 *
 * Context: Up to 2M tokens for grok-4-1-fast
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';
import { DEFAULT_MAX_RETRIES, RETRY_STATUS_CODES, RETRY_DELAY_MS } from './constants.js';

/**
 * xAI/Grok Model IDs
 */
export const XAI_MODELS = {
  // Grok 4 (Latest)
  'grok-4': 'grok-4',
  'grok-4-1-fast': 'grok-4-1-fast-reasoning',
  'grok-4-1-fast-reasoning': 'grok-4-1-fast-reasoning',
  'grok-4-1-fast-non-reasoning': 'grok-4-1-fast-non-reasoning',
  // Grok 3
  'grok-3': 'grok-3',
  'grok-3-mini': 'grok-3-mini',
  // Grok 2
  'grok-2': 'grok-2-1212',
  'grok-2-vision': 'grok-2-vision-1212',
  // Aliases
  'grok': 'grok-4',
  'grok-fast': 'grok-4-1-fast-non-reasoning',
} as const;

const DEFAULT_MODEL = 'grok-4';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MAX_TOKENS = 4096;

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
}

export class XAIProvider implements LLMProvider {
  public readonly name = 'xai';
  public readonly model: string;
  public readonly characteristics: ProviderCharacteristics = {
    speed: 'fast', // Grok 4 is optimized for fast reasoning
    costPerMillionTokens: 5, // Approximate pricing
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
          // Handle image content for vision models
          const imageContent = contentBlocks.filter((c) => c.type === 'image');
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
            messages.push({
              role: 'assistant',
              content: textContent || null,
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            });
          } else if (imageContent.length > 0) {
            // Vision message with images
            const contentParts: OpenAI.ChatCompletionContentPart[] = [];

            if (textContent) {
              contentParts.push({ type: 'text', text: textContent });
            }

            for (const img of imageContent) {
              const imgBlock = img as {
                type: 'image';
                source: { type: string; data?: string; url?: string; media_type: string };
              };
              if (imgBlock.source.type === 'base64' && imgBlock.source.data) {
                contentParts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`,
                  },
                });
              } else if (imgBlock.source.url) {
                contentParts.push({
                  type: 'image_url',
                  image_url: { url: imgBlock.source.url },
                });
              }
            }

            messages.push({
              role: 'user',
              content: contentParts,
            });
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

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
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
