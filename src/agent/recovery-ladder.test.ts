import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { ContentFilterFinishReasonError } from 'openai/core/error';
import Anthropic from '@anthropic-ai/sdk';
import {
  classifyProviderError,
  parseRetryAfterMs,
  extractStatus,
  retryDelayMs,
  backoffDelayMs,
  stripThinkingFromRequest,
  stripProblemParams,
  callWithStallGuard,
  ProviderStallError,
  isLocalProvider,
  stallLimitMs,
  CLOUD_STALL_MS,
  LOCAL_STALL_MS,
  isEmptyResponse,
  RepeatedResponseGuard,
  runRecoveryLadder,
  RecoveryExhaustedError,
  MAX_RETRY_AFTER_MS,
  type RecoveryRouter,
} from './recovery-ladder.js';
import { Router } from '../routing/router.js';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';

const openaiError = (status: number, message: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  OpenAI.APIError.generate(status, { error: { message, ...body } }, message, new Headers(headers ?? {}));
const anthropicError = (status: number, message: string, headers?: Record<string, string>) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, message, new Headers(headers ?? {}));

const ok = (text = 'ok'): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
});

function fakeProvider(name: string, outcomes: Array<Error | CompletionResponse>, extra: Record<string, unknown> = {}) {
  const calls: CompletionRequest[] = [];
  const provider = {
    name,
    calls,
    isAvailable: () => true,
    complete: vi.fn(async (req: CompletionRequest) => {
      calls.push(req);
      const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    ...extra,
  };
  return provider as LLMProvider & { calls: CompletionRequest[]; complete: ReturnType<typeof vi.fn> };
}

const baseRequest = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

const noSleep = vi.fn(async () => {});

describe('classifyProviderError', () => {
  it('OpenAI SDK 429 is rate_limit and honours retry-after headers', () => {
    const c = classifyProviderError(openaiError(429, 'Rate limit reached', {}, { 'retry-after': '7' }));
    expect(c.errorClass).toBe('rate_limit');
    expect(c.status).toBe(429);
    expect(c.retryAfterMs).toBe(7000);
  });

  it('retry-after-ms wins over retry-after', () => {
    const c = classifyProviderError(openaiError(429, 'slow down', {}, { 'retry-after-ms': '1500', 'retry-after': '9' }));
    expect(c.retryAfterMs).toBe(1500);
  });

  it('Anthropic 529 overloaded is rate_limit', () => {
    expect(classifyProviderError(anthropicError(529, 'Overloaded')).errorClass).toBe('rate_limit');
  });

  it('OpenRouter string errors carry the status in the message', () => {
    const err = new Error('OpenRouter API error: 429 Too Many Requests - {"error":{"message":"Rate limit exceeded"}}');
    expect(extractStatus(err)).toBe(429);
    expect(classifyProviderError(err).errorClass).toBe('rate_limit');
    expect(classifyProviderError(new Error('OpenRouter API error: 502 Bad Gateway - {}')).errorClass).toBe('server');
    expect(classifyProviderError(new Error('OpenRouter API error: 402 Payment Required - {"error":{"message":"Insufficient credits"}}')).errorClass).toBe('billing');
  });

  it('insufficient_quota on a 429 is billing, not a rate limit', () => {
    const err = openaiError(429, 'You exceeded your current quota', { code: 'insufficient_quota', type: 'insufficient_quota' });
    expect(classifyProviderError(err).errorClass).toBe('billing');
  });

  it('402 is billing', () => {
    expect(classifyProviderError(openaiError(402, 'Payment required')).errorClass).toBe('billing');
  });

  it('401/403 are auth', () => {
    expect(classifyProviderError(openaiError(401, 'Incorrect API key provided')).errorClass).toBe('auth');
    expect(classifyProviderError(anthropicError(403, 'Permission denied')).errorClass).toBe('auth');
  });

  it('context overflow from several providers', () => {
    expect(classifyProviderError(openaiError(400, "This model's maximum context length is 128000 tokens", { code: 'context_length_exceeded' })).errorClass).toBe('context_overflow');
    expect(classifyProviderError(anthropicError(400, 'prompt is too long: 210000 tokens > 200000 maximum')).errorClass).toBe('context_overflow');
    expect(classifyProviderError(anthropicError(413, 'Request too large')).errorClass).toBe('context_overflow');
  });

  it('Anthropic thinking signature errors', () => {
    const err = anthropicError(400, 'messages.1.content.0: Invalid `signature` in `thinking` block');
    expect(classifyProviderError(err).errorClass).toBe('thinking_signature');
  });

  it('5xx is server', () => {
    expect(classifyProviderError(openaiError(500, 'Internal server error')).errorClass).toBe('server');
    expect(classifyProviderError(new Error('Ollama API error: 503 Service Unavailable')).errorClass).toBe('server');
  });

  it('network and fetch errors are timeout', () => {
    expect(classifyProviderError(new TypeError('fetch failed')).errorClass).toBe('timeout');
    expect(classifyProviderError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).errorClass).toBe('timeout');
    expect(classifyProviderError(new OpenAI.APIConnectionError({ message: 'Connection error.' })).errorClass).toBe('timeout');
    expect(classifyProviderError(new OpenAI.APIConnectionTimeoutError()).errorClass).toBe('timeout');
    expect(classifyProviderError(new ProviderStallError('anthropic', 1000)).errorClass).toBe('timeout');
    const cause = Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(classifyProviderError(new TypeError('fetch failed', { cause })).errorClass).toBe('timeout');
  });

  it('an AbortError is user_abort only when the caller aborted', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(classifyProviderError(abort, { callerAborted: true }).errorClass).toBe('user_abort');
    expect(classifyProviderError(abort, { callerAborted: false }).errorClass).toBe('timeout');
    expect(classifyProviderError(new OpenAI.APIUserAbortError(), { callerAborted: false }).errorClass).toBe('timeout');
  });

  it('400 with tool/schema wording is bad_request and flags it', () => {
    const c = classifyProviderError(openaiError(400, "Invalid schema for function 'web_search': array schema missing items"));
    expect(c.errorClass).toBe('bad_request');
    expect(c.mentionsToolsOrSchema).toBe(true);
    expect(classifyProviderError(openaiError(400, 'Something odd')).mentionsToolsOrSchema).toBe(false);
  });

  it('content filter', () => {
    expect(classifyProviderError(openaiError(400, 'The response was filtered due to the prompt triggering content management policy', { code: 'content_filter' })).errorClass).toBe('content_filter');
    expect(classifyProviderError(new ContentFilterFinishReasonError()).errorClass).toBe('content_filter');
  });

  it('local budget errors are local_policy', () => {
    expect(classifyProviderError(Object.assign(new Error('budget'), { code: 'LOCAL_BUDGET_EXCEEDED' })).errorClass).toBe('local_policy');
  });

  it('unknown errors fall through', () => {
    expect(classifyProviderError(new Error('weird')).errorClass).toBe('unknown');
    expect(classifyProviderError('plain string').errorClass).toBe('unknown');
  });
});

describe('retry timing', () => {
  it('parses headers as records, Headers and HTTP dates', () => {
    expect(parseRetryAfterMs({ 'Retry-After': '3' })).toBe(3000);
    expect(parseRetryAfterMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    const now = Date.parse('2026-10-02T10:00:00Z');
    expect(parseRetryAfterMs({ 'retry-after': 'Fri, 02 Oct 2026 10:00:05 GMT' }, now)).toBe(5000);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('caps Retry-After at 60s and backs off exponentially otherwise', () => {
    expect(retryDelayMs({ errorClass: 'rate_limit', retryAfterMs: 600_000, mentionsToolsOrSchema: false, message: '' }, 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(backoffDelayMs(0, undefined, () => 0)).toBe(2000);
    expect(backoffDelayMs(2, undefined, () => 0)).toBe(8000);
    expect(backoffDelayMs(10, undefined, () => 0)).toBe(30_000);
  });
});

describe('request rewrites', () => {
  it('stripThinkingFromRequest removes thinking blocks and disables thinking', () => {
    const req = baseRequest({
      enableThinking: true,
      thinkingBudgetTokens: 4096,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a' }] },
      ],
    });
    const out = stripThinkingFromRequest(req);
    expect(out.enableThinking).toBe(false);
    expect(out.thinkingBudgetTokens).toBeUndefined();
    expect(out.messages[1].content).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('stripProblemParams drops a named tool but never all tools', () => {
    const tools = ['web_search', 'read_file', 'bash'].map(name => ({ name, description: '', input_schema: { type: 'object' as const, properties: {} } }));
    const c = classifyProviderError(openaiError(400, "Invalid schema for function 'web_search'"));
    const fixed = stripProblemParams(baseRequest({ tools }), c);
    expect(fixed?.removed).toEqual(['tool:web_search']);
    expect(fixed?.request.tools?.map(t => t.name)).toEqual(['read_file', 'bash']);

    const indexed = classifyProviderError(openaiError(400, 'tools.2.function.parameters: invalid json schema'));
    expect(stripProblemParams(baseRequest({ tools }), indexed)?.removed).toEqual(['tool:bash']);

    const vague = classifyProviderError(openaiError(400, 'tools are invalid'));
    expect(stripProblemParams(baseRequest({ tools }), vague)).toBeNull();
  });

  it('stripProblemParams drops temperature when it is the complaint', () => {
    const c = classifyProviderError(openaiError(400, "Unsupported parameter: 'temperature' is not supported with this model."));
    const fixed = stripProblemParams(baseRequest({ temperature: 0.2 }), c);
    expect(fixed?.removed).toEqual(['temperature']);
    expect(fixed?.request.temperature).toBeUndefined();
  });
});

describe('stall guard', () => {
  it('local vs cloud limits', () => {
    expect(stallLimitMs({ name: 'anthropic' })).toBe(CLOUD_STALL_MS);
    expect(stallLimitMs({ name: 'ollama' })).toBe(LOCAL_STALL_MS);
    expect(isLocalProvider({ name: 'local' })).toBe(true);
    expect(isLocalProvider({ name: 'my-endpoint', baseUrl: 'http://10.0.0.5:8080/v1' } as never)).toBe(true);
    expect(isLocalProvider({ name: 'openai' })).toBe(false);
    expect(isLocalProvider({ name: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' } as never)).toBe(false);
  });

  it('aborts a call that makes no progress and rejects with ProviderStallError', async () => {
    let seen: AbortSignal | undefined;
    const p = callWithStallGuard('slow', 20, undefined, (signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    await expect(p).rejects.toBeInstanceOf(ProviderStallError);
    expect(seen?.aborted).toBe(true);
  });

  it('touch() keeps a progressing call alive', async () => {
    const result = await callWithStallGuard('stream', 30, undefined, async (_signal, touch) => {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 15));
        touch();
      }
      return 'done';
    });
    expect(result).toBe('done');
  });
});

describe('loop guards', () => {
  it('isEmptyResponse', () => {
    expect(isEmptyResponse({ content: [] })).toBe(true);
    expect(isEmptyResponse({ content: [{ type: 'text', text: '  <think>x</think> ' }] })).toBe(true);
    expect(isEmptyResponse({ content: [{ type: 'thinking', thinking: 'x' }] })).toBe(true);
    expect(isEmptyResponse({ content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(isEmptyResponse({ content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] })).toBe(false);
  });

  it('RepeatedResponseGuard fires on the third identical text', () => {
    const g = new RepeatedResponseGuard();
    expect(g.observe('Working on it.')).toBe(false);
    expect(g.observe('working   on it.')).toBe(false);
    expect(g.observe('Something else')).toBe(false);
    expect(g.observe('Working on it.')).toBe(true);
    expect(g.observe('')).toBe(false);
  });
});

function makeRouter(providers: LLMProvider[], order = providers.map(p => p.name)) {
  const router = new Router({ providerOrder: order, tierMapping: { fast: order, standard: order, capable: order } });
  for (const p of providers) router.registerProvider(p);
  return router;
}

describe('runRecoveryLadder', () => {
  it('returns the primary response with no errors', async () => {
    const p = fakeProvider('a', [ok('hello')]);
    const res = await runRecoveryLadder({ provider: p, request: baseRequest(), tier: 'standard', sleep: noSleep });
    expect(res.content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('rate_limit: waits Retry-After then succeeds on the same provider', async () => {
    const sleep = vi.fn(async () => {});
    const p = fakeProvider('a', [openaiError(429, 'Rate limit', {}, { 'retry-after': '2' }), ok()]);
    await runRecoveryLadder({ provider: p, request: baseRequest(), tier: 'standard', sleep });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(p.complete).toHaveBeenCalledTimes(2);
  });

  it('rate_limit: rotates credentials before waiting when the provider has a pool', async () => {
    const sleep = vi.fn(async () => {});
    const rotateCredential = vi.fn(() => true);
    const p = fakeProvider('a', [openaiError(429, 'Rate limit'), ok()], { rotateCredential });
    await runRecoveryLadder({ provider: p, request: baseRequest(), tier: 'standard', sleep });
    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rate_limit with Retry-After beyond 60s fails over at once and cools the provider', async () => {
    const sleep = vi.fn(async () => {});
    const a = fakeProvider('a', [openaiError(429, 'Rate limit', {}, { 'retry-after': '600' })]);
    const b = fakeProvider('b', [ok('from b')]);
    const router = makeRouter([a, b]);
    const res = await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router, sleep });
    expect(res.content[0]).toEqual({ type: 'text', text: 'from b' });
    expect(sleep).not.toHaveBeenCalled();
    expect(router.canAttemptProvider('a')).toBe(false);
    expect(router.getProviderHealth('a')?.cooldownReason).toBe('rate_limit');
  });

  it('rate_limit: after 3 retries falls back via the router', async () => {
    const a = fakeProvider('a', [anthropicError(529, 'Overloaded')]);
    const b = fakeProvider('b', [ok('b')]);
    const onFallbackResponse = vi.fn();
    const res = await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep, onFallbackResponse });
    expect(a.complete).toHaveBeenCalledTimes(4);
    expect(res.content[0]).toEqual({ type: 'text', text: 'b' });
    expect(onFallbackResponse).toHaveBeenCalledWith(res, 'b');
  });

  it('context_overflow: compresses then retries; falls over after stages run out', async () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const overflow = anthropicError(400, 'prompt is too long');
    const p = fakeProvider('a', [overflow, ok('fit')]);
    const compress = vi.fn(async (m: Message[], stage: number) => (stage === 0 ? m.slice(-4) : null));
    const res = await runRecoveryLadder({ provider: p, request: baseRequest({ messages: msgs }), tier: 'standard', compress, sleep: noSleep });
    expect(res.content[0]).toEqual({ type: 'text', text: 'fit' });
    expect(p.calls[1].messages).toHaveLength(4);

    const stuck = fakeProvider('s', [overflow]);
    const b = fakeProvider('b', [ok('big window')]);
    const compress2 = vi.fn(async (m: Message[], stage: number) => (stage < 2 ? m.slice(1) : null));
    const res2 = await runRecoveryLadder({ provider: stuck, request: baseRequest({ messages: msgs }), tier: 'standard', router: makeRouter([stuck, b]), compress: compress2, sleep: noSleep });
    expect(compress2).toHaveBeenCalledTimes(3);
    expect(res2.content[0]).toEqual({ type: 'text', text: 'big window' });
  });

  it('auth: no same-provider retry, fails over and cools the provider', async () => {
    const a = fakeProvider('a', [openaiError(401, 'Incorrect API key provided')]);
    const b = fakeProvider('b', [ok('b')]);
    const router = makeRouter([a, b]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router, sleep: noSleep });
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(router.canAttemptProvider('a')).toBe(false);
    expect(router.getProviderHealth('a')?.cooldownReason).toBe('auth');
  });

  it('auth: rotates credentials when the provider has a pool', async () => {
    const rotateCredential = vi.fn(() => true);
    const a = fakeProvider('a', [openaiError(401, 'bad key'), ok('second key')], { rotateCredential });
    const res = await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', sleep: noSleep });
    expect(res.content[0]).toEqual({ type: 'text', text: 'second key' });
  });

  it('billing: fails over, cools for the billing window, and next call skips the benched primary', async () => {
    const a = fakeProvider('a', [openaiError(429, 'quota', { code: 'insufficient_quota' })]);
    const b = fakeProvider('b', [ok('b')]);
    const router = makeRouter([a, b]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router, sleep: noSleep });
    const health = router.getProviderHealth('a')!;
    expect(health.cooldownReason).toBe('billing');
    expect(health.cooldownUntil!.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    a.complete.mockClear();
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router, sleep: noSleep });
    expect(a.complete).not.toHaveBeenCalled();
  });

  it('server: retries with backoff twice, then fails over', async () => {
    const sleep = vi.fn(async () => {});
    const a = fakeProvider('a', [openaiError(503, 'Service unavailable')]);
    const b = fakeProvider('b', [ok('b')]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep, random: () => 0 });
    expect(a.complete).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => (c as unknown[])[0])).toEqual([2000, 4000]);
  });

  it('timeout: retries once then fails over', async () => {
    const a = fakeProvider('a', [new TypeError('fetch failed')]);
    const b = fakeProvider('b', [ok('b')]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep });
    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(b.complete).toHaveBeenCalledTimes(1);
  });

  it('a stalled call is killed and treated as a timeout', async () => {
    const hang = { name: 'hang', isAvailable: () => true, complete: vi.fn(() => new Promise<CompletionResponse>(() => {})) } as LLMProvider;
    const b = fakeProvider('b', [ok('b')]);
    const res = await runRecoveryLadder({ provider: hang, request: baseRequest(), tier: 'standard', router: makeRouter([hang, b]), sleep: noSleep, stallMs: () => 15 });
    expect(res.content[0]).toEqual({ type: 'text', text: 'b' });
    expect(hang.complete).toHaveBeenCalledTimes(2);
  });

  it('thinking_signature: strips thinking and retries once', async () => {
    const a = fakeProvider('a', [anthropicError(400, 'Invalid `signature` in `thinking` block'), ok()]);
    const req = baseRequest({
      enableThinking: true,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'a' }] },
        { role: 'user', content: 'q2' },
      ],
    });
    await runRecoveryLadder({ provider: a, request: req, tier: 'standard', sleep: noSleep });
    expect(a.calls[1].enableThinking).toBe(false);
    expect(JSON.stringify(a.calls[1].messages)).not.toContain('thinking"');
  });

  it('bad_request with a named tool: retries once without it', async () => {
    const tools = ['bad_tool', 'good_tool'].map(name => ({ name, description: '', input_schema: { type: 'object' as const, properties: {} } }));
    const a = fakeProvider('a', [openaiError(400, "Invalid schema for function 'bad_tool': missing items"), ok()]);
    await runRecoveryLadder({ provider: a, request: baseRequest({ tools }), tier: 'standard', sleep: noSleep });
    expect(a.calls[1].tools?.map(t => t.name)).toEqual(['good_tool']);
  });

  it('bad_request without a clear fix: surfaces the original error, no retry, no failover', async () => {
    const err = openaiError(400, 'Invalid value for messages');
    const a = fakeProvider('a', [err]);
    const b = fakeProvider('b', [ok('b')]);
    await expect(runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep })).rejects.toBe(err);
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(b.complete).not.toHaveBeenCalled();
  });

  it('content_filter: fails over without retrying', async () => {
    const a = fakeProvider('a', [openaiError(400, 'filtered', { code: 'content_filter' })]);
    const b = fakeProvider('b', [ok('b')]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep });
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(b.complete).toHaveBeenCalledTimes(1);
  });

  it('local policy errors and caller aborts surface immediately', async () => {
    const budget = Object.assign(new Error('budget'), { code: 'LOCAL_BUDGET_EXCEEDED' });
    const a = fakeProvider('a', [budget]);
    const b = fakeProvider('b', [ok()]);
    await expect(runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep })).rejects.toBe(budget);
    expect(b.complete).not.toHaveBeenCalled();

    const controller = new AbortController();
    const abortErr = new DOMException('aborted', 'AbortError');
    const c = { name: 'c', isAvailable: () => true, complete: vi.fn(async () => { controller.abort(); throw abortErr; }) } as LLMProvider;
    await expect(runRecoveryLadder({ provider: c, request: baseRequest({ signal: controller.signal }), tier: 'standard', router: makeRouter([c, b]), sleep: noSleep })).rejects.toBe(abortErr);
  });

  it('without fallbacks, the provider error is rethrown unchanged', async () => {
    const err = new Error('weird');
    const a = fakeProvider('a', [err]);
    await expect(runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', sleep: noSleep })).rejects.toBe(err);
  });

  it('all providers failing gives a typed summary', async () => {
    const a = fakeProvider('a', [new Error('weird a')]);
    const b = fakeProvider('b', [openaiError(401, 'bad key')]);
    const p = runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep });
    await expect(p).rejects.toBeInstanceOf(RecoveryExhaustedError);
    await expect(runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router: makeRouter([a, b]), sleep: noSleep })).rejects.toThrow(/b \[auth\]/);
  });

  it('feeds success and failure back only for providers the router owns', async () => {
    const router: RecoveryRouter = {
      getProviderHealth: vi.fn(() => undefined),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
      coolProvider: vi.fn(),
      canAttemptProvider: () => true,
      getProvider: () => undefined,
      getTierMapping: () => ({ fast: [], standard: [], capable: [] }),
      getProviderOrder: () => [],
    };
    const a = fakeProvider('override', [ok()]);
    await runRecoveryLadder({ provider: a, request: baseRequest(), tier: 'standard', router, sleep: noSleep });
    expect(router.recordProviderSuccess).not.toHaveBeenCalled();
  });
});
