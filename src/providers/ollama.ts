import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';
import { nanoid } from 'nanoid';

const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_BASE_URL = 'http://localhost:11434';

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

interface OllamaResponse {
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LLMProvider {
  public readonly name = 'ollama';
  public readonly model: string;
  public readonly baseUrl: string;
  public readonly characteristics: ProviderCharacteristics = {
    speed: 'standard',
    costPerMillionTokens: 0, // Free - runs locally
    isLocal: true,
  };

  private timeout: number;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model || DEFAULT_MODEL;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeout = options.timeout || 120000; // 2 minutes default for local models
  }

  isAvailable(): boolean {
    // Ollama is available if we have a base URL configured
    // Actual availability is checked via checkHealth()
    return true;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { models: Array<{ name: string }> };
      const modelNames = data.models.map((m) => m.name.split(':')[0]);

      return modelNames.includes(this.model.split(':')[0]);
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };

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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaResponse;
    return this.formatResponse(data);
  }

  private formatMessages(request: CompletionRequest): OllamaMessage[] {
    const messages: OllamaMessage[] = [];

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
        // Filter out 'thinking' blocks from other providers (e.g., Moonshot)
        const contentBlocks = msg.content.filter((b) => b.type !== 'thinking');
        // Extract text content
        const textContent = contentBlocks
          .filter((c) => c.type === 'text')
          .map((c) => (c as { type: 'text'; text: string }).text)
          .join('\n');

        // For tool results, include them as user message content
        const toolResults = contentBlocks.filter((c) => c.type === 'tool_result');
        if (toolResults.length > 0) {
          const resultText = toolResults
            .map((r) => {
              if (r.type === 'tool_result') {
                return `Tool result (${r.tool_use_id}): ${r.content}`;
              }
              return '';
            })
            .join('\n');
          messages.push({
            role: 'user',
            content: resultText,
          });
        } else if (textContent) {
          messages.push({
            role: msg.role,
            content: textContent,
          });
        }
      }
    }

    return messages;
  }

  private formatResponse(data: OllamaResponse): CompletionResponse {
    const content: ContentBlock[] = [];
    let stopReason: CompletionResponse['stopReason'] = 'end_turn';

    // Add text content
    if (data.message.content) {
      content.push({ type: 'text', text: data.message.content });
    }

    // Add tool calls
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      stopReason = 'tool_use';
      for (const toolCall of data.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: nanoid(),
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        });
      }
    }

    return {
      content,
      stopReason,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      model: this.model,
    };
  }
}
