/**
 * Shared pieces for streamed completions.
 *
 * - completeWithStream(): call a provider's completeStream() when it has one,
 *   complete() otherwise.
 * - parseSSE(): server-sent-events reader for raw fetch bodies (OpenRouter).
 * - ChatCompletionStreamAssembler: folds OpenAI-style chat.completion.chunk
 *   objects into one non-streamed chat.completion object, so each provider can
 *   run it through its existing formatResponse() and get exactly what
 *   complete() would have returned.
 */

import type { CompletionRequest, CompletionResponse, LLMProvider, StreamHandlers } from './types.js';

/** Stream when the provider can, otherwise a plain complete(). */
export function completeWithStream(
  provider: LLMProvider,
  request: CompletionRequest,
  handlers: StreamHandlers,
): Promise<CompletionResponse> {
  return provider.completeStream
    ? provider.completeStream(request, handlers)
    : provider.complete(request);
}

/**
 * Wrap handlers so the caller can tell whether anything visible was
 * delivered yet. A retry is only safe before the first delta; after it, the
 * error must surface so the caller can reset what it showed.
 */
export function trackingHandlers(handlers: StreamHandlers): { handlers: StreamHandlers; delivered: () => boolean } {
  let delivered = false;
  return {
    delivered: () => delivered,
    handlers: {
      onTextDelta: (text) => {
        if (!text) return;
        delivered = true;
        handlers.onTextDelta?.(text);
      },
      onToolUseStart: (name) => handlers.onToolUseStart?.(name),
      onTextReset: () => handlers.onTextReset?.(),
    },
  };
}

/** Marks an error raised after text was already streamed: not retryable in place. */
export class StreamInterruptedError extends Error {
  constructor(cause: unknown) {
    super(`Stream interrupted: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = 'StreamInterruptedError';
  }
}

/**
 * Read a text/event-stream body and yield each event's data payload.
 * Handles events split across network chunks, CRLF line endings, comment
 * lines (OpenRouter's ": OPENROUTER PROCESSING" keep-alives) and multi-line
 * data fields. Stops at the "[DONE]" sentinel.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const takeLine = (line: string): string | undefined => {
    if (line === '') {
      if (dataLines.length === 0) return undefined;
      const data = dataLines.join('\n');
      dataLines = [];
      return data;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return undefined;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
    return undefined;
  };

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      const width = buffer.startsWith('\r\n', newline) ? 2 : 1;
      // A lone trailing '\r' may be the first half of a CRLF split across chunks.
      if (width === 1 && buffer[newline] === '\r' && newline === buffer.length - 1) break;
      buffer = buffer.slice(newline + width);
      const data = takeLine(line);
      if (data === undefined) continue;
      if (data.trim() === '[DONE]') return;
      yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer) takeLine(buffer.replace(/\r$/, ''));
  const tail = takeLine('');
  if (tail !== undefined && tail.trim() !== '[DONE]') yield tail;
}

/** The subset of an OpenAI-style streaming chunk the assembler reads. */
export interface ChatCompletionChunkLike {
  id?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
    /** Moonshot puts usage on the final choice instead of the chunk. */
    usage?: Record<string, unknown> | null;
  }>;
  usage?: Record<string, unknown> | null;
  error?: { message?: string; code?: number | string } | string;
}

interface ToolCallDraft {
  id: string;
  name: string;
  arguments: string;
  announced: boolean;
}

/** A chat.completion-shaped object assembled from stream chunks. */
export interface AssembledChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: 'assistant';
      content: string | null;
      refusal: null;
      reasoning_content?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
    logprobs: null;
  }>;
  usage: Record<string, unknown> & { prompt_tokens: number; completion_tokens: number };
}

export interface AssemblerOptions {
  /** Keep reasoning/reasoning_content deltas (as message.reasoning_content). */
  keepReasoning?: boolean;
}

export class ChatCompletionStreamAssembler {
  private text = '';
  private reasoning = '';
  private readonly toolCalls = new Map<number, ToolCallDraft>();
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private model = '';
  private id = '';
  private created = 0;

  constructor(
    private readonly handlers: StreamHandlers = {},
    private readonly options: AssemblerOptions = {},
  ) {}

  push(chunk: ChatCompletionChunkLike): void {
    if (chunk.error) {
      const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error);
      throw new Error(`Stream error: ${message}`);
    }
    if (chunk.model) this.model = chunk.model;
    if (chunk.id) this.id = chunk.id;
    if (chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      if (choice.usage) this.usage = choice.usage;
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) this.reasoning += reasoning;

      if (typeof delta.content === 'string' && delta.content) {
        this.text += delta.content;
        this.handlers.onTextDelta?.(delta.content);
      }

      for (const [position, call] of (delta.tool_calls ?? []).entries()) {
        const index = call.index ?? position;
        let draft = this.toolCalls.get(index);
        if (!draft) {
          draft = { id: '', name: '', arguments: '', announced: false };
          this.toolCalls.set(index, draft);
        }
        if (call.id) draft.id = call.id;
        const name = call.function?.name;
        if (name) {
          // Most servers send the whole name once; some repeat it per chunk.
          if (!draft.name) draft.name = name;
          else if (name !== draft.name) draft.name += name;
        }
        if (call.function?.arguments) draft.arguments += call.function.arguments;
        if (!draft.announced && draft.name) {
          draft.announced = true;
          this.handlers.onToolUseStart?.(draft.name);
        }
      }
    }
  }

  /** The assembled response in chat.completion form. */
  result(): AssembledChatCompletion {
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, draft]) => ({
        id: draft.id || `call_${index}`,
        type: 'function' as const,
        function: { name: draft.name, arguments: draft.arguments || '{}' },
      }));
    const usage = this.usage ?? {};
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: this.text || null,
          refusal: null,
          ...(this.options.keepReasoning && this.reasoning && { reasoning_content: this.reasoning }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: this.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        logprobs: null,
      }],
      usage: {
        ...usage,
        prompt_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        completion_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      },
    };
  }
}
