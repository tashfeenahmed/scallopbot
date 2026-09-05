import type {
  LLMProvider,
  ProviderOptions,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
} from './types.js';
import { flattenSystem } from './types.js';
import { DEFAULT_MAX_RETRIES, RETRY_DELAY_MS } from './constants.js';

const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Models that support extended thinking/reasoning via OpenRouter */
const REASONING_MODELS = new Set([
  'qwen/qwen3-235b-a22b',
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen3-30b-a3b',
  'qwen/qwen3-30b-a3b:free',
  'qwen/qwen3-32b',
  'qwen/qwen3-32b:free',
  'qwen/qwen3.6-plus',
  'qwen/qwen3.6-plus-04-02',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-r1:free',
]);

/**
 * Reasoning effort sent when a caller sets enableThinking:false.
 *
 * OpenRouter's contract is `reasoning: { effort: 'none', exclude: true }`, but
 * some backends reject or ignore 'none' (Gemini did from 31 Aug 2026; the
 * working value there is 'minimal'). Rather than hard-code per-model guesses,
 * the effort is resolved from:
 *   1. env OPENROUTER_REASONING_OFF_EFFORT — either a single effort applied to
 *      every model (`minimal`) or a comma-separated map of `model=effort`
 *      entries with an optional bare default, e.g.
 *      `none,qwen/qwen3.6-plus=minimal,google/gemini*=minimal`
 *      (a trailing `*` matches a model-id prefix; matching is case-insensitive);
 *   2. the built-in map below (Gemini → 'minimal', known-broken with 'none');
 *   3. 'none'.
 */
export type ReasoningOffEffort = 'none' | 'minimal' | 'low';
const REASONING_OFF_EFFORTS = new Set<ReasoningOffEffort>(['none', 'minimal', 'low']);
const DEFAULT_REASONING_OFF_EFFORT: ReasoningOffEffort = 'none';
const BUILTIN_REASONING_OFF_OVERRIDES: Array<[prefix: string, effort: ReasoningOffEffort]> = [
  ['google/gemini', 'minimal'],
];

function parseReasoningOffEffort(value: string | undefined): ReasoningOffEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && REASONING_OFF_EFFORTS.has(normalized as ReasoningOffEffort)
    ? (normalized as ReasoningOffEffort)
    : undefined;
}

/** Resolve the reasoning effort to send for enableThinking:false on `model`. */
export function reasoningOffEffortForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env
): ReasoningOffEffort {
  const id = model.trim().toLowerCase();
  let envDefault: ReasoningOffEffort | undefined;
  const raw = env.OPENROUTER_REASONING_OFF_EFFORT;
  if (raw) {
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        envDefault = parseReasoningOffEffort(trimmed) ?? envDefault;
        continue;
      }
      const pattern = trimmed.slice(0, eq).trim().toLowerCase();
      const effort = parseReasoningOffEffort(trimmed.slice(eq + 1));
      if (!effort || !pattern) continue;
      const matches = pattern.endsWith('*')
        ? id.startsWith(pattern.slice(0, -1))
        : id === pattern;
      if (matches) return effort;
    }
  }
  if (envDefault) return envDefault;
  const builtin = BUILTIN_REASONING_OFF_OVERRIDES.find(([prefix]) => id.startsWith(prefix));
  return builtin ? builtin[1] : DEFAULT_REASONING_OFF_EFFORT;
}

export interface ProviderCharacteristics {
  speed: 'fast' | 'standard' | 'slow';
  costPerMillionTokens: number;
  isLocal: boolean;
  pricingType: 'fixed' | 'routed';
}

/**
 * Content part for messages. OpenRouter accepts either a plain string or an
 * array of text parts. For Claude models, we use the array form with
 * cache_control to trigger Anthropic prompt caching through OpenRouter.
 */
interface OpenRouterContentPart {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenRouterContentPart[] | null;
  tool_call_id?: string;
  reasoning_content?: string;
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
      reasoning_content?: string | null;
      reasoning?: string | null;
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
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
  private timeout?: number;
  private siteUrl: string;
  private siteName: string;

  constructor(options: ProviderOptions & { siteUrl?: string; siteName?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.timeout = options.timeout;
    this.siteUrl = options.siteUrl || 'https://scallopbot.local';
    this.siteName = options.siteName || 'ScallopBot';
  }

  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  private isReasoningModel(): boolean {
    return REASONING_MODELS.has(this.model) || this.model.includes('qwen3');
  }

  /**
   * Claude models routed via OpenRouter support Anthropic-style prompt caching
   * when cache_control is attached to content parts. OpenRouter passes the
   * directive through to Anthropic unchanged.
   */
  private supportsCacheControl(): boolean {
    return this.model.startsWith('anthropic/');
  }

  /**
   * Format the system prompt. For Claude models, emit structured content parts
   * with cache_control on the stable portion. For other models, fall back to a
   * plain string — OpenRouter ignores cache_control for non-Anthropic backends
   * and some of them reject the array form entirely.
   */
  private formatSystemContent(
    system: NonNullable<CompletionRequest['system']>
  ): string | OpenRouterContentPart[] {
    if (!this.supportsCacheControl()) {
      return flattenSystem(system);
    }

    // Claude model via OpenRouter: emit structured form with cache boundary.
    if (typeof system === 'string') {
      return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    const parts: OpenRouterContentPart[] = [
      { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
    ];
    if (system.dynamic && system.dynamic.length > 0) {
      parts.push({ type: 'text', text: system.dynamic });
    }
    return parts;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = this.formatMessages(request);
    const isReasoning = this.isReasoningModel();

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: isReasoning ? (request.maxTokens || 8192) : (request.maxTokens || 4096),
      usage: { include: true },
      // OpenRouter otherwise infers reasoning from the model. An explicit
      // false is a hard route contract for schema-only background work; the
      // effort used for "off" is per-model (see reasoningOffEffortForModel).
      ...(request.enableThinking !== undefined && {
        reasoning: request.enableThinking
          ? { effort: 'high' }
          : { effort: reasoningOffEffortForModel(this.model), exclude: true },
      }),
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

    if (request.structuredOutput) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.structuredOutput.name,
          strict: request.structuredOutput.strict ?? true,
          schema: request.structuredOutput.schema,
        },
      };
    }

    const { response, bodyData, bodyError } = await this.executeWithRetry(
      (signal) =>
        fetch(API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': this.siteUrl,
            'X-Title': this.siteName,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        }),
      request.signal
    );

    if (!response.ok) {
      const errorData = bodyError === undefined ? bodyData : {};
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
      );
    }

    // Parsing errors were not provider-retryable before body timeout handling;
    // preserve that behavior after the bounded body read completes.
    if (bodyError !== undefined) throw bodyError;
    const data = bodyData as OpenRouterResponse;
    return this.formatResponse(data);
  }

  private formatMessages(request: CompletionRequest): OpenRouterMessage[] {
    const messages: OpenRouterMessage[] = [];
    const isReasoning = this.isReasoningModel() && request.enableThinking !== false;

    // Add system message if present
    if (request.system) {
      messages.push({ role: 'system', content: this.formatSystemContent(request.system) });
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
            // Skip thinking-only assistant messages (no text, no tool_use).
            // These come from aborted/interrupted LLM calls. Sending content:null
            // triggers "got an object" from Alibaba (typeof null === 'object')
            // and "assistant must not be empty" from OpenAI-compat strict
            // implementations. Dropping them is safe — reasoning content alone
            // has no downstream value.
            if (!textContent && toolCalls.length === 0) continue;

            // For reasoning models, preserve thinking content in history
            let reasoningContent: string | undefined;
            if (isReasoning) {
              const thinkingBlocks = msg.content
                .filter((c) => c.type === 'thinking')
                .map((c) => (c as { type: 'thinking'; thinking: string }).thinking);
              reasoningContent = thinkingBlocks.length > 0 ? thinkingBlocks.join('\n') : undefined;
            }

            messages.push({
              role: 'assistant',
              content: textContent || null,
              ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
              ...(isReasoning && reasoningContent && { reasoning_content: reasoningContent }),
            } as OpenRouterMessage);
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

    // Extract reasoning/thinking content if present (Qwen3, DeepSeek-R1, etc.)
    // OpenRouter returns reasoning in either `reasoning_content` or `reasoning` depending on model
    const reasoning = choice.message.reasoning_content || choice.message.reasoning;
    if (reasoning) {
      content.push({ type: 'thinking', thinking: reasoning });
    }

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

    const cachedInputTokens = data.usage.prompt_tokens_details?.cached_tokens;
    // Reasoning tokens count against max_tokens even when `exclude: true`
    // hides them from the response, so surface them for truncation diagnostics.
    const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        ...(cachedInputTokens !== undefined && { cachedInputTokens }),
        ...(typeof reasoningTokens === 'number' && { reasoningTokens }),
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

  private async executeWithRetry(
    fn: (signal?: AbortSignal) => Promise<Response>,
    callerSignal?: AbortSignal
  ): Promise<{ response: Response; bodyData?: unknown; bodyError?: unknown }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // Consume the response body before the attempt timer is cleared. Fetch
        // resolves as soon as response headers arrive, so timing only `fn()`
        // would still allow a stalled body stream to hang the provider forever.
        const result = await this.executeAttempt(async (signal) => {
          const response = await fn(signal);
          // A 429 body is not used and should not delay the retry decision.
          if (response.status === 429) return { response };
          try {
            return { response, bodyData: await response.json() as unknown };
          } catch (bodyError) {
            return { response, bodyError };
          }
        }, callerSignal);
        const { response } = result;

        // Retry on rate limit
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const retryAfterSecs = retryAfter ? parseInt(retryAfter, 10) : NaN;
          const delay = !isNaN(retryAfterSecs)
            ? retryAfterSecs * 1000
            : RETRY_DELAY_MS * Math.pow(2, attempt);
          await this.delay(delay, callerSignal);
          continue;
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        // Cancellation is a control-flow signal, not a transient provider
        // failure. Retrying it would multiply the configured timeout and delay
        // Router fallback (or ignore an explicit caller cancellation).
        if (callerSignal?.aborted || this.isAbortOrTimeoutError(error)) {
          throw error;
        }

        await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt), callerSignal);
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /** Run one provider attempt with its own timeout and caller cancellation. */
  private async executeAttempt<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const timeoutController = this.timeout !== undefined ? new AbortController() : undefined;
    const timeoutMs = this.timeout;
    const signals = [callerSignal, timeoutController?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    if (timeoutController && timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timeoutController.abort(
          new DOMException(`Provider request timed out after ${timeoutMs}ms`, 'TimeoutError')
        );
      }, timeoutMs);
    }

    try {
      signal?.throwIfAborted();

      if (!signal) {
        return await fn();
      }

      // Native fetch rejects on abort, but racing the signal also guarantees
      // the provider returns promptly if a custom fetch implementation fails
      // to settle after receiving cancellation.
      const aborted = new Promise<never>((_, reject) => {
        abortHandler = () => reject(signal.reason ?? this.createAbortError());
        signal.addEventListener('abort', abortHandler, { once: true });
      });

      return await Promise.race([fn(signal), aborted]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  private isAbortOrTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('name' in error)) return false;
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError' || name === 'TimeoutError';
  }

  private createAbortError(): DOMException {
    return new DOMException('Request aborted', 'AbortError');
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(signal.reason ?? this.createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
