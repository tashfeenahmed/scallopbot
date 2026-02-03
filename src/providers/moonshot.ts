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
  ToolResultContent,
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

const DEFAULT_MODEL = 'kimi-k2.5';
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
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private maxRetries: number;
  private baseUrl: string;
  private timeout?: number;

  constructor(options: ProviderOptions) {
    // Support both single apiKey and multiple apiKeys
    this.apiKeys = options.apiKeys?.length ? options.apiKeys : [options.apiKey];
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeout = options.timeout;

    this.client = new OpenAI({
      apiKey: this.apiKeys[0],
      baseURL: this.baseUrl,
      ...(this.timeout && { timeout: this.timeout }),
    });
  }

  isAvailable(): boolean {
    return this.apiKeys.length > 0 && this.apiKeys[0].length > 0;
  }

  /**
   * Rotate to next API key on auth errors
   * Returns true if there are more keys to try
   */
  private rotateApiKey(): boolean {
    if (this.apiKeys.length <= 1) return false;

    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    const newKey = this.apiKeys[this.currentKeyIndex];

    this.client = new OpenAI({
      apiKey: newKey,
      baseURL: this.baseUrl,
      ...(this.timeout && { timeout: this.timeout }),
    });

    console.log(`[MOONSHOT] Rotated to API key ${this.currentKeyIndex + 1}/${this.apiKeys.length}`);
    return this.currentKeyIndex !== 0; // true if we haven't cycled back to start
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);

    const isKimiK2 = this.model.includes('kimi-k2');
    // Enable thinking mode if explicitly requested AND model supports it
    const enableThinking = request.enableThinking === true && isKimiK2;

    const params: OpenAI.ChatCompletionCreateParams & { thinking?: { type: string } } = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens || DEFAULT_MAX_TOKENS,
      // Temperature: 1.0 for thinking mode, 0.6 for instant mode
      temperature: request.temperature ?? (isKimiK2 ? (enableThinking ? 1.0 : 0.6) : undefined),
      ...(request.stopSequences && { stop: request.stopSequences }),
      ...(request.tools && { tools: this.formatTools(request.tools) }),
      // Only disable thinking if NOT enabling it (for Kimi K2 models)
      ...(isKimiK2 && !enableThinking && { thinking: { type: 'disabled' } }),
    };

    // Debug logging - log the full request
    console.log('[MOONSHOT DEBUG] Request params:', JSON.stringify({
      model: params.model,
      messageCount: messages.length,
      hasTools: !!request.tools,
      toolCount: request.tools?.length || 0,
    }));
    console.log('[MOONSHOT DEBUG] Messages:', JSON.stringify(messages, null, 2));

    try {
      const response = await this.executeWithRetry(() =>
        this.client.chat.completions.create(params)
      );

      // Debug logging - log the response
      console.log('[MOONSHOT DEBUG] Response:', JSON.stringify({
        model: response.model,
        finishReason: response.choices[0]?.finish_reason,
        hasToolCalls: !!response.choices[0]?.message?.tool_calls,
        toolCallCount: response.choices[0]?.message?.tool_calls?.length || 0,
        toolCalls: response.choices[0]?.message?.tool_calls?.map(tc => ({
          id: tc.id,
          type: tc.type,
          functionName: 'function' in tc ? tc.function?.name : 'unknown',
        })),
        contentLength: response.choices[0]?.message?.content?.length || 0,
        usage: response.usage,
      }));

      return this.formatResponse(response);
    } catch (error) {
      // Debug logging - log any errors
      console.error('[MOONSHOT DEBUG] Error:', {
        message: (error as Error).message,
        name: (error as Error).name,
        stack: (error as Error).stack?.split('\n').slice(0, 3).join('\n'),
      });
      throw error;
    }
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
        const toolResults = msg.content.filter((c): c is ToolResultContent => c.type === 'tool_result');
        if (toolResults.length > 0 && msg.role === 'user') {
          for (const toolResult of toolResults) {
            // Validate tool_use_id exists and is not empty
            if (!toolResult.tool_use_id) {
              console.error('[MOONSHOT] Missing tool_use_id in tool_result:', JSON.stringify(toolResult));
              continue;
            }
            messages.push({
              role: 'tool',
              tool_call_id: toolResult.tool_use_id,
              content: toolResult.content || '',
            });
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

    // Add text content - ONLY use 'content' field, NOT reasoning_content
    // reasoning_content contains internal thinking which should not be shown to users
    const message = choice.message as OpenAI.ChatCompletionMessage & { reasoning_content?: string };
    const textContent = message.content;
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
    let keyRotationAttempts = 0;
    const maxKeyRotations = this.apiKeys.length;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof OpenAI.APIError) {
          // Retry on rate limits and server errors
          if (RETRY_STATUS_CODES.includes(error.status)) {
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt));
            continue;
          }

          // Rotate API key on auth errors (401, 403)
          if ((error.status === 401 || error.status === 403) && keyRotationAttempts < maxKeyRotations) {
            keyRotationAttempts++;
            if (this.rotateApiKey()) {
              attempt--; // Don't count this as a retry attempt
              continue;
            }
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
