import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';
import { DEFAULT_MAX_RETRIES, RETRY_DELAY_MS } from './constants.js';

const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
  pricingType: 'fixed' | 'routed';
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  model: string;
}

export class OpenRouterProvider implements LLMProvider {
  public readonly name = 'openrouter';
  public readonly model: string;
  public readonly characteristics: ProviderCharacteristics = {
    speed: 'standard',
    costPerMillionTokens: 3, // Varies by model
    isLocal: false,
    pricingType: 'routed',
  };

  private apiKey: string;
  private maxRetries: number;
  private siteUrl: string;
  private siteName: string;

  constructor(options: ProviderOptions & { siteUrl?: string; siteName?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.siteUrl = options.siteUrl || 'https://scallopbot.local';
    this.siteName = options.siteName || 'ScallopBot';
  }

  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens || 4096,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.stopSequences) {
      body.stop = request.stopSequences;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
    }

    const response = await this.executeWithRetry(() =>
      fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.siteUrl,
          'X-Title': this.siteName,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
      );
    }

    const data = (await response.json()) as OpenRouterResponse;
    return this.formatResponse(data);
  }

  private formatMessages(request: CompletionRequest): OpenRouterMessage[] {
    const messages: OpenRouterMessage[] = [];

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
        });
      } else {
        // Handle content blocks
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
            messages.push({
              role: 'assistant',
              content: textContent || null,
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
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

  private formatResponse(data: OpenRouterResponse): CompletionResponse {
    const choice = data.choices[0];
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
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

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      model: data.model,
    };
  }

  private mapStopReason(reason: string): CompletionResponse['stopReason'] {
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

  private async executeWithRetry(fn: () => Promise<Response>): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fn();

        // Retry on rate limit
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : RETRY_DELAY_MS * Math.pow(2, attempt);
          await this.delay(delay);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
