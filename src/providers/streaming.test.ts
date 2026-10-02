import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompletionStreamAssembler,
  completeWithStream,
  parseSSE,
} from './streaming.js';
import { OpenRouterProvider } from './openrouter.js';
import { OpenAIProvider } from './openai.js';
import { MoonshotProvider } from './moonshot.js';
import { AnthropicProvider } from './anthropic.js';
import { DynamicProvider } from './dynamic-provider.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types.js';

const encoder = new TextEncoder();

/** A ReadableStream that delivers `parts` as separate network chunks. */
function bodyOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** Split a string into fixed-size pieces so events straddle chunk boundaries. */
function shred(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

const request: CompletionRequest = {
  messages: [{ role: 'user', content: 'hi' }],
  system: { stable: 'You are helpful.', dynamic: '' },
  tools: [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  cacheKey: 'session-1',
  maxTokens: 512,
};

/** The OpenAI-style chunks of a reply with text, a split tool call and usage last. */
const toolCallChunks = [
  { id: 'gen-1', model: 'qwen/qwen3.6-plus', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'thinking…' } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { content: 'Let me ' } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { content: 'check.' } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } }] } }] },
  { id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  {
    id: 'gen-1',
    choices: [],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 1024 },
      completion_tokens_details: { reasoning_tokens: 12 },
    },
  },
];

function sseOf(chunks: unknown[]): string {
  return `: OPENROUTER PROCESSING\n\n${chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')}data: [DONE]\n\n`;
}

describe('parseSSE', () => {
  it('reassembles events split across chunks, skips comments and stops at [DONE]', async () => {
    const raw = ': keep-alive\n\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\r\n\r\nevent: x\ndata: {"c":3}\n\ndata: [DONE]\n\ndata: {"after":true}\n\n';
    for (const size of [1, 3, 7, raw.length]) {
      expect(await collect(parseSSE(bodyOf(shred(raw, size))))).toEqual(['{"a":1}', '{"b":\n2}', '{"c":3}']);
    }
  });

  it('yields a final event that lacks the trailing blank line', async () => {
    expect(await collect(parseSSE(bodyOf(['data: {"x":1}'])))).toEqual(['{"x":1}']);
  });
});

describe('ChatCompletionStreamAssembler', () => {
  it('accumulates tool-call arguments across chunks and takes usage from the last chunk', () => {
    const deltas: string[] = [];
    const toolStarts: string[] = [];
    const assembler = new ChatCompletionStreamAssembler(
      { onTextDelta: (t) => deltas.push(t), onToolUseStart: (n) => toolStarts.push(n) },
      { keepReasoning: true },
    );
    for (const chunk of toolCallChunks) assembler.push(chunk);
    const result = assembler.result();

    expect(deltas).toEqual(['Let me ', 'check.']);
    expect(toolStarts).toEqual(['read_file', 'read_file']);
    expect(result.model).toBe('qwen/qwen3.6-plus');
    expect(result.choices[0].message).toMatchObject({
      content: 'Let me check.',
      reasoning_content: 'thinking…',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ],
    });
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.usage).toMatchObject({ prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1024 } });
  });

  it('reads Moonshot-style usage from the final choice', () => {
    const assembler = new ChatCompletionStreamAssembler();
    assembler.push({ model: 'kimi-k2.5', choices: [{ index: 0, delta: { content: 'Hi' } }] });
    assembler.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 2, cached_tokens: 40 } }] });
    expect(assembler.result().usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 2, cached_tokens: 40 });
  });

  it('throws on a mid-stream error chunk', () => {
    const assembler = new ChatCompletionStreamAssembler();
    expect(() => assembler.push({ error: { message: 'upstream overloaded' } })).toThrow(/upstream overloaded/);
  });
});

describe('OpenRouterProvider.completeStream', () => {
  const mockFetch = vi.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('streams text, assembles tool calls and usage, and sends complete()\'s body plus stream flags', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'qwen/qwen3.6-plus' });
    mockFetch.mockResolvedValueOnce(new Response(bodyOf(shred(sseOf(toolCallChunks), 37)), { status: 200 }));
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'qwen/qwen3.6-plus',
    }), { status: 200 }));

    const deltas: string[] = [];
    const response = await provider.completeStream(request, { onTextDelta: (t) => deltas.push(t) });
    await provider.complete(request);

    expect(deltas.join('')).toBe('Let me check.');
    expect(response).toEqual<CompletionResponse>({
      content: [
        { type: 'thinking', thinking: 'thinking…' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b.txt' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 12 },
      model: 'qwen/qwen3.6-plus',
    });

    const streamedBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const plainBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(streamedBody).toEqual({ ...plainBody, stream: true, stream_options: { include_usage: true } });
    // Everything before the stream flags is byte-identical (prompt caching).
    expect(mockFetch.mock.calls[0][1].body.startsWith(mockFetch.mock.calls[1][1].body.slice(0, -1))).toBe(true);
  });

  it('surfaces an HTTP error without retrying', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'openai/gpt-5' });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad' }), { status: 400, statusText: 'Bad Request' }));
    await expect(provider.completeStream(request, {})).rejects.toThrow(/OpenRouter API error: 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/** An async iterable of SDK chunks, like the OpenAI SDK's Stream. */
async function* sdkStream<T>(chunks: T[]): AsyncGenerator<T> {
  for (const chunk of chunks) yield chunk;
}

describe('OpenAIProvider.completeStream', () => {
  it('passes complete() params plus stream flags and returns the assembled response', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k', model: 'gpt-4.1' });
    const create = vi.fn().mockImplementation(async () => sdkStream(toolCallChunks));
    (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };

    const deltas: string[] = [];
    const response = await provider.completeStream(request, { onTextDelta: (t) => deltas.push(t) });

    expect(deltas).toEqual(['Let me ', 'check.']);
    expect(response.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b.txt' } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 12 });
    expect(response.stopReason).toBe('tool_use');
    const params = create.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(params.prompt_cache_key).toBe('session-1');
  });
});

describe('MoonshotProvider.completeStream', () => {
  it('keeps reasoning_content as a thinking block and reads usage from the final choice', async () => {
    const provider = new MoonshotProvider({ apiKey: 'k', model: 'kimi-k2.5' });
    const create = vi.fn().mockImplementation(async () => sdkStream([
      { model: 'kimi-k2.5', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Let me think' } }] },
      { choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { choices: [{ index: 0, delta: { content: ' there' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 300, completion_tokens: 9, cached_tokens: 256 } }] },
    ]));
    (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };

    const deltas: string[] = [];
    const response = await provider.completeStream({ ...request, enableThinking: true }, { onTextDelta: (t) => deltas.push(t) });

    expect(deltas).toEqual(['Hello', ' there']);
    expect(response.content).toEqual([
      { type: 'thinking', thinking: 'Let me think' },
      { type: 'text', text: 'Hello there' },
    ]);
    expect(response.usage).toEqual({ inputTokens: 300, outputTokens: 9, cachedInputTokens: 256 });
    const params = create.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.temperature).toBe(1.0);
    expect(params.thinking).toBeUndefined();
  });
});

describe('AnthropicProvider.completeStream', () => {
  it('streams text deltas, announces tool use, and formats the SDK final message', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-5' });
    const events = [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' now.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } },
    ];
    const finalMessage = {
      content: [
        { type: 'text', text: 'Checking now.' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      model: 'claude-sonnet-4-5',
    };
    const stream = vi.fn().mockImplementation(() => ({
      [Symbol.asyncIterator]: () => sdkStream(events),
      finalMessage: async () => finalMessage,
    }));
    (provider as unknown as { client: unknown }).client = { messages: { stream } };

    const deltas: string[] = [];
    const tools: string[] = [];
    const response = await provider.completeStream(
      { ...request, cacheMessages: true },
      { onTextDelta: (t) => deltas.push(t), onToolUseStart: (n) => tools.push(n) },
    );

    expect(deltas).toEqual(['Checking', ' now.']);
    expect(tools).toEqual(['read_file']);
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 910, outputTokens: 20, cachedInputTokens: 900 });
    const params = stream.mock.calls[0][0];
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  });
});

function fakeResponse(text: string): CompletionResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
}

describe('completeWithStream and DynamicProvider', () => {
  it('falls back to complete() for providers without streaming', async () => {
    const provider: LLMProvider = { name: 'plain', isAvailable: () => true, complete: vi.fn().mockResolvedValue(fakeResponse('ok')) };
    const onTextDelta = vi.fn();
    expect(await completeWithStream(provider, request, { onTextDelta })).toEqual(fakeResponse('ok'));
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('resets streamed text when a chain provider fails mid-stream, then streams the fallback', async () => {
    const broken: LLMProvider = {
      name: 'broken',
      isAvailable: () => true,
      complete: vi.fn(),
      completeStream: vi.fn().mockImplementation(async (_req, handlers) => {
        handlers.onTextDelta?.('half a rep');
        throw new Error('socket hang up');
      }),
    };
    const good: LLMProvider = {
      name: 'good',
      isAvailable: () => true,
      complete: vi.fn(),
      completeStream: vi.fn().mockImplementation(async (_req, handlers) => {
        handlers.onTextDelta?.('Full reply');
        return fakeResponse('Full reply');
      }),
    };
    const dynamic = new DynamicProvider(async () => broken, 'chat', async () => [broken, good]);
    const events: string[] = [];
    const response = await dynamic.completeStream(request, {
      onTextDelta: (t) => events.push(`delta:${t}`),
      onTextReset: () => events.push('reset'),
    });
    expect(response).toEqual(fakeResponse('Full reply'));
    expect(events).toEqual(['delta:half a rep', 'reset', 'delta:Full reply']);
  });
});
