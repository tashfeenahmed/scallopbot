/**
 * Recovery ladder: typed provider-error classes, each with its own action.
 *
 * A provider failure is classified once (`classifyProviderError`) and the
 * ladder (`runRecoveryLadder`) picks the action for that class:
 *
 * | class              | action                                                         |
 * |--------------------|----------------------------------------------------------------|
 * | rate_limit         | rotate key if pooled, else wait Retry-After/backoff (x3), then fail over and cool the provider |
 * | context_overflow   | compress (graduated, then emergency), then fail over           |
 * | auth               | rotate key if pooled, else fail over and cool the provider (no same-provider retry) |
 * | billing            | rotate key if pooled, else fail over and cool the provider     |
 * | server             | retry with backoff (x2), then fail over                        |
 * | timeout            | retry once, then fail over (stalled calls land here)           |
 * | bad_request        | no plain retry; strip a clearly-named bad tool/param once, else surface |
 * | thinking_signature | strip thinking blocks + disable thinking, retry once           |
 * | content_filter     | fail over (another provider may answer), no same-provider retry |
 * | user_abort / local_policy | surface immediately                                     |
 * | unknown            | fail over                                                       |
 *
 * Fail-over walks the Router's tier chain, skipping providers the Router says
 * are cooling down, and runs the same ladder on each candidate. Outcomes feed
 * the Router's shared health so the next turn honours the cooldown.
 *
 * Also exported for the agent loop: the stall guard (no progress for 180s on
 * cloud, 900s on local providers → abort and treat as a timeout), an
 * empty-response check and a repeated-identical-response guard.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMProvider,
  Message,
  StreamHandlers,
} from '../providers/types.js';
import { completeWithStream } from '../providers/streaming.js';
import type { ModelTier } from '../routing/complexity.js';

// ─── Classification ────────────────────────────────────────────────────────

export type ProviderErrorClass =
  | 'rate_limit'
  | 'context_overflow'
  | 'auth'
  | 'billing'
  | 'server'
  | 'timeout'
  | 'bad_request'
  | 'thinking_signature'
  | 'content_filter'
  | 'user_abort'
  | 'local_policy'
  | 'unknown';

export interface ClassifiedProviderError {
  errorClass: ProviderErrorClass;
  /** HTTP status when one could be found on the error or in its message. */
  status?: number;
  /** Server-requested wait, uncapped (ms). Callers cap before sleeping. */
  retryAfterMs?: number;
  /** For bad_request: the error talks about tools / JSON schema. */
  mentionsToolsOrSchema: boolean;
  message: string;
}

/** Hard cap on any single Retry-After wait. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** Stall limits: no progress for this long → abort the call as a timeout. */
export const CLOUD_STALL_MS = 180_000;
export const LOCAL_STALL_MS = 900_000;

const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[ _]length/,
  /context[ _]window/,
  /token limit/,
  /too many tokens/,
  /maximum context/,
  /input too long/,
  /request too large/,
  /content too large/,
  /prompt is too long/,
  /exceeds.*context/,
  /exceeds.*token/,
  /reduce the length of the messages/,
];

const THINKING_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /signature.*thinking|thinking.*signature/,
  /invalid .?signature/,
  /redacted_thinking/,
  /expected .?thinking.? or .?redacted_thinking/,
  /thinking blocks? (?:cannot|must|may not)/,
];

const BILLING_PATTERNS: readonly RegExp[] = [
  /insufficient[_ ]quota/,
  /exceeded your current quota/,
  /credit balance/,
  /insufficient (?:credits|balance|funds)/,
  /payment required/,
  /billing/,
  /out of credits/,
  /quota exceeded/,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /invalid[_ ]api[_ ]key/,
  /incorrect api key/,
  /invalid x-api-key/,
  /unauthori[sz]ed/,
  /authentication/,
  /permission denied/,
  /forbidden/,
  /api key (?:not|is) (?:valid|found|missing)/,
];

const CONTENT_FILTER_PATTERNS: readonly RegExp[] = [
  /content[_ ]filter/,
  /content management policy/,
  /responsible ai polic/,
  /safety system/,
  /flagged (?:as|by|for)/,
  /blocked (?:by|due to) (?:safety|moderation|content)/,
  /moderation/,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate[ _-]?limit/,
  /too many requests/,
  /overloaded/,
  /resource[_ ]exhausted/,
  /\bcapacity\b/,
];

const SERVER_PATTERNS: readonly RegExp[] = [
  /internal server error/,
  /bad gateway/,
  /service unavailable/,
  /gateway time-?out/,
  /upstream (?:error|connect)/,
  /server error/,
];

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

const NETWORK_PATTERNS: readonly RegExp[] = [
  /fetch failed/,
  /socket hang up/,
  /network ?error/,
  /connection (?:error|reset|refused|closed)/,
  /timed? ?out/,
  /econnreset|econnrefused|etimedout|enotfound|eai_again/,
  /request was aborted/,
  /stalled/,
  /premature close/,
  /terminated/,
];

const TOOL_SCHEMA_PATTERN = /\btools?\b|function|schema|tool_choice|parameters?\b|\bparam\b|input_schema|json|temperature|stop_sequences|response_format/;

type ErrorLike = Error & {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  headers?: unknown;
  response?: { status?: unknown; headers?: unknown };
  error?: unknown;
  cause?: unknown;
};

function asErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) return error as ErrorLike;
  if (typeof error === 'string') return new Error(error) as ErrorLike;
  if (error && typeof error === 'object') {
    const message = typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : JSON.stringify(error);
    return Object.assign(new Error(message), error) as ErrorLike;
  }
  return new Error(String(error)) as ErrorLike;
}

/** Find the HTTP status on SDK errors, fetch-style errors, or in the message. */
export function extractStatus(error: unknown): number | undefined {
  const err = asErrorLike(error);
  for (const candidate of [err.status, err.statusCode, err.response?.status]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate < 600) return candidate;
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  const msg = err.message ?? '';
  // "OpenRouter API error: 429 Too Many Requests - {...}", "Ollama API error: 500 ..."
  const apiError = msg.match(/\b(?:api error|error|status(?: code)?|http)[:\s]+(\d{3})\b/i);
  if (apiError) return Number(apiError[1]);
  // OpenAI/Anthropic SDK messages start with the status: "429 Rate limit reached…"
  const leading = msg.match(/^\s*(\d{3})\b/);
  if (leading) return Number(leading[1]);
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const key = Object.keys(record).find(k => k.toLowerCase() === name);
    const v = key ? record[key] : undefined;
    if (Array.isArray(v)) return v[0] !== undefined ? String(v[0]) : undefined;
    return v === undefined || v === null ? undefined : String(v);
  }
  return undefined;
}

/**
 * Parse `retry-after-ms` / `retry-after` (seconds or HTTP date) from a Web
 * `Headers` object or a plain record. Uncapped; returns undefined when absent.
 */
export function parseRetryAfterMs(headers: unknown, now: number = Date.now()): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = headerValue(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function retryAfterFromError(err: ErrorLike): number | undefined {
  const fromHeaders = parseRetryAfterMs(err.headers) ?? parseRetryAfterMs(err.response?.headers);
  if (fromHeaders !== undefined) return fromHeaders;
  // OpenRouter-style strings sometimes carry the hint in the body.
  const m = (err.message ?? '').match(/retry[ -]after["':\s]+(\d+(?:\.\d+)?)\s*(ms|s|seconds)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === 'ms' ? n : n * 1000;
}

function errorCode(err: ErrorLike): string {
  const own = typeof err.code === 'string' ? err.code : '';
  const nested = err.error && typeof err.error === 'object'
    ? (err.error as { code?: unknown; error?: { code?: unknown } })
    : undefined;
  const nestedCode = typeof nested?.code === 'string'
    ? nested.code
    : typeof nested?.error?.code === 'string' ? nested.error.code : '';
  const causeCode = err.cause && typeof err.cause === 'object' && typeof (err.cause as { code?: unknown }).code === 'string'
    ? (err.cause as { code: string }).code
    : '';
  return [own, nestedCode, causeCode].filter(Boolean).join(' ');
}

const matchesAny = (text: string, patterns: readonly RegExp[]): boolean => patterns.some(p => p.test(text));

/** True when the context-overflow message patterns match (any provider). */
export function isContextOverflowMessage(message: string): boolean {
  return matchesAny(message.toLowerCase(), CONTEXT_OVERFLOW_PATTERNS);
}

/**
 * Classify a provider error. `callerAborted` must be true when the caller's
 * own signal (user /stop, foreground deadline) is aborted: that abort is
 * surfaced, while an abort from our stall guard or an SDK timeout is a timeout.
 */
export function classifyProviderError(
  error: unknown,
  options: { callerAborted?: boolean } = {},
): ClassifiedProviderError {
  const err = asErrorLike(error);
  const message = err.message ?? String(error);
  const lower = message.toLowerCase();
  const code = errorCode(err);
  const codeLower = code.toLowerCase();
  const status = extractStatus(err);
  const name = err.name ?? '';
  const result = (errorClass: ProviderErrorClass, extra: Partial<ClassifiedProviderError> = {}): ClassifiedProviderError => ({
    errorClass,
    ...(status !== undefined && { status }),
    mentionsToolsOrSchema: false,
    message,
    ...extra,
  });

  if (code.includes('LOCAL_BUDGET_EXCEEDED')) return result('local_policy');

  const isAbort = name === 'AbortError' || name === 'APIUserAbortError' || /request was aborted|operation was aborted|this operation was aborted/.test(lower);
  if (isAbort && options.callerAborted) return result('user_abort');
  if (err instanceof ProviderStallError) return result('timeout');

  if (codeLower.includes('context_length_exceeded') || status === 413 || isContextOverflowMessage(message)) {
    return result('context_overflow');
  }

  if (matchesAny(lower, THINKING_SIGNATURE_PATTERNS) && (status === undefined || status === 400)) {
    return result('thinking_signature');
  }

  // OpenAI reports exhausted credit as 429 insufficient_quota: billing, not a rate limit.
  if (status === 402 || codeLower.includes('insufficient_quota') || codeLower.includes('billing') || matchesAny(lower, BILLING_PATTERNS)) {
    return result('billing');
  }

  if (status === 401 || status === 403 || codeLower.includes('invalid_api_key') || (status === undefined && matchesAny(lower, AUTH_PATTERNS))) {
    return result('auth');
  }

  if (codeLower.includes('content_filter') || name === 'ContentFilterFinishReasonError' || matchesAny(lower, CONTENT_FILTER_PATTERNS)) {
    return result('content_filter');
  }

  if (status === 429 || status === 529 || codeLower.includes('rate_limit') || matchesAny(lower, RATE_LIMIT_PATTERNS)) {
    const retryAfterMs = retryAfterFromError(err);
    return result('rate_limit', retryAfterMs !== undefined ? { retryAfterMs } : {});
  }

  if (status === 400 || status === 422) {
    return result('bad_request', { mentionsToolsOrSchema: TOOL_SCHEMA_PATTERN.test(lower) });
  }

  if (status === 408 || status === 504 || status === 524) return result('timeout');

  if (status !== undefined && status >= 500) {
    const retryAfterMs = retryAfterFromError(err);
    return result('server', retryAfterMs !== undefined ? { retryAfterMs } : {});
  }

  if (
    isAbort
    || name === 'APIConnectionError'
    || name === 'APIConnectionTimeoutError'
    || name === 'TimeoutError'
    || [...NETWORK_CODES].some(c => code.includes(c))
    || matchesAny(lower, NETWORK_PATTERNS)
  ) {
    return result('timeout');
  }

  if (matchesAny(lower, SERVER_PATTERNS)) return result('server');

  return result('unknown');
}

// ─── Policy ────────────────────────────────────────────────────────────────

export type RecoveryAction =
  | 'retry'
  | 'compress'
  | 'rotate_credentials'
  | 'strip_thinking'
  | 'strip_params'
  | 'fallback'
  | 'surface';

export interface RecoveryPolicy {
  /** Same-provider retries for rate limits before failing over. */
  rateLimitRetries: number;
  /** Same-provider retries for 5xx before failing over. */
  serverRetries: number;
  /** Same-provider retries for timeouts / network errors before failing over. */
  timeoutRetries: number;
  /** Key rotations per provider per call (pooled providers only). */
  maxRotations: number;
  /** Cooldowns (ms) the Router applies to a provider after these classes. */
  authCooldownMs: number;
  billingCooldownMs: number;
  /** Rate-limit cooldown when the server gave no Retry-After. */
  rateLimitCooldownMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  rateLimitRetries: 3,
  serverRetries: 2,
  timeoutRetries: 1,
  maxRotations: 3,
  authCooldownMs: 30 * 60_000,
  billingCooldownMs: 60 * 60_000,
  rateLimitCooldownMs: 60_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 30_000,
};

/** Exponential backoff with 20% jitter: base * 2^attempt, capped. */
export function backoffDelayMs(
  attempt: number,
  policy: Pick<RecoveryPolicy, 'backoffBaseMs' | 'backoffMaxMs'> = DEFAULT_RECOVERY_POLICY,
  random: () => number = Math.random,
): number {
  const base = policy.backoffBaseMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(base + base * 0.2 * random(), policy.backoffMaxMs);
}

/** Wait for a retryable error: Retry-After when given (capped at 60s), else backoff. */
export function retryDelayMs(
  classified: ClassifiedProviderError,
  attempt: number,
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  random: () => number = Math.random,
): number {
  if (classified.retryAfterMs !== undefined) return Math.min(classified.retryAfterMs, MAX_RETRY_AFTER_MS);
  return backoffDelayMs(attempt, policy, random);
}

// ─── Request rewrites ──────────────────────────────────────────────────────

/** Drop thinking blocks from history and turn thinking off for the retry. */
export function stripThinkingFromRequest(request: CompletionRequest): CompletionRequest {
  const messages: Message[] = request.messages.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
    const content = msg.content.filter((block) => {
      const type = (block as { type: string }).type;
      return type !== 'thinking' && type !== 'redacted_thinking';
    }) as ContentBlock[];
    if (content.length === msg.content.length) return msg;
    return { ...msg, content: content.length > 0 ? content : [{ type: 'text', text: '' }] };
  });
  return { ...request, messages, enableThinking: false, thinkingBudgetTokens: undefined };
}

/**
 * For a 400 that clearly names what it rejected, return a request without
 * that thing: tools named in the error, or the temperature / stop params.
 * Returns null when nothing in the error points at a specific part.
 */
export function stripProblemParams(
  request: CompletionRequest,
  classified: ClassifiedProviderError,
): { request: CompletionRequest; removed: string[] } | null {
  const msg = classified.message;
  const lower = msg.toLowerCase();
  const removed: string[] = [];
  let next: CompletionRequest = request;

  if (request.tools?.length) {
    const named = request.tools.filter(tool => {
      const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\w-])${escaped}(?:$|[^\\w-])`).test(msg);
    });
    // Also catch index-addressed errors: "tools.3.function.parameters…" / "tools[3]".
    const indexed = [...msg.matchAll(/tools(?:\.|\[)(\d+)/g)]
      .map(m => request.tools![Number(m[1])])
      .filter((t): t is NonNullable<typeof t> => !!t);
    const bad = new Set([...named, ...indexed].map(t => t.name));
    // Removing every tool would change the task; only strip a clear minority.
    if (bad.size > 0 && bad.size < request.tools.length) {
      next = { ...next, tools: request.tools.filter(t => !bad.has(t.name)) };
      removed.push(...[...bad].map(n => `tool:${n}`));
    }
  }
  if (next.temperature !== undefined && /temperature/.test(lower)) {
    next = { ...next, temperature: undefined };
    removed.push('temperature');
  }
  if (next.stopSequences?.length && /\bstop(?:_sequences)?\b/.test(lower)) {
    next = { ...next, stopSequences: undefined };
    removed.push('stop_sequences');
  }
  if (next.structuredOutput && /response_format|json_schema|structured/.test(lower)) {
    next = { ...next, structuredOutput: undefined };
    removed.push('structured_output');
  }
  return removed.length > 0 ? { request: next, removed } : null;
}

// ─── Stall guard ───────────────────────────────────────────────────────────

/** Thrown when a provider call makes no progress within its stall window. */
export class ProviderStallError extends Error {
  constructor(public readonly provider: string, public readonly stallMs: number) {
    super(`Provider ${provider} made no progress for ${Math.round(stallMs / 1000)}s (stalled call aborted)`);
    this.name = 'ProviderStallError';
  }
}

const LOCAL_PROVIDER_NAMES = new Set(['ollama', 'local', 'lmstudio', 'llamacpp', 'llama-swap', 'vllm']);
const CLOUD_PROVIDER_NAMES = new Set(['anthropic', 'openrouter', 'moonshot', 'groq', 'xai']);

/**
 * Local = ollama/"local"/custom OpenAI-compatible endpoints (anything with a
 * configured baseUrl that is not one of the known cloud providers).
 */
export function isLocalProvider(provider: Pick<LLMProvider, 'name'>): boolean {
  if (LOCAL_PROVIDER_NAMES.has(provider.name)) return true;
  if (CLOUD_PROVIDER_NAMES.has(provider.name)) return false;
  const baseUrl = (provider as { baseUrl?: unknown }).baseUrl;
  return typeof baseUrl === 'string' && baseUrl.length > 0;
}

export function stallLimitMs(provider: Pick<LLMProvider, 'name'>): number {
  return isLocalProvider(provider) ? LOCAL_STALL_MS : CLOUD_STALL_MS;
}

/**
 * Run one provider call under a stall watchdog. The returned `touch` resets
 * the window; a streaming caller should call it on every chunk. A plain
 * complete() call has no intermediate progress, so the window is its limit.
 * On a stall the call's signal is aborted and a ProviderStallError rejects.
 */
export async function callWithStallGuard<T>(
  providerName: string,
  stallMs: number,
  parentSignal: AbortSignal | undefined,
  call: (signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStall: ((e: Error) => void) | undefined;
  const stalled = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new ProviderStallError(providerName, stallMs);
      controller.abort(err);
      rejectStall?.(err);
    }, stallMs);
    timer.unref?.();
  };
  arm();
  try {
    return await Promise.race([call(signal, arm), stalled]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Loop guards (exported for the agent loop) ─────────────────────────────

/** Harness nudge for an empty reply, in the `[kind: qualifier]` convention. */
export const EMPTY_RESPONSE_NUDGE =
  '[recovery: empty-response] Your last reply had no text and no tool calls. Continue the task, or answer the user.';

/** Honest stop message when the model repeats itself. */
export const REPEATED_RESPONSE_STOP_MESSAGE =
  'I stopped because I was giving the same reply over and over without making progress. The task is unfinished; tell me how you would like to continue.';

/** True when a response has no visible text and no tool calls. */
export function isEmptyResponse(response: Pick<CompletionResponse, 'content'>): boolean {
  return !response.content.some((block) => {
    if (block.type === 'tool_use') return true;
    if (block.type === 'text') {
      return block.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().length > 0;
    }
    return false;
  });
}

function normalizeForRepeat(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Per-turn guard: `observe(text)` returns true once the same (normalised)
 * text has been seen `limit` times in this turn. Empty text is ignored.
 */
export class RepeatedResponseGuard {
  private counts = new Map<string, number>();
  constructor(private readonly limit: number = 3) {}

  observe(text: string): boolean {
    const key = normalizeForRepeat(text);
    if (!key) return false;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count >= this.limit;
  }

  reset(): void {
    this.counts.clear();
  }
}

// ─── The ladder ────────────────────────────────────────────────────────────

/** The subset of Router the ladder uses (kept narrow for fakes). */
export interface RecoveryRouter {
  getProviderHealth(name: string): unknown;
  recordProviderSuccess(name: string): void;
  recordProviderFailure(name: string, error: Error): void;
  coolProvider?(name: string, cooldownMs: number, reason?: string): void;
  canAttemptProvider(name: string): boolean;
  getProvider(name: string): LLMProvider | undefined;
  getTierMapping(): Record<ModelTier, string[]>;
  getProviderOrder(): string[];
}

/** Providers with a key pool expose this (see OpenAIProvider.rotateCredential). */
export interface CredentialRotatable {
  rotateCredential(): boolean;
}

function canRotate(provider: LLMProvider): provider is LLMProvider & CredentialRotatable {
  return typeof (provider as Partial<CredentialRotatable>).rotateCredential === 'function';
}

export interface RecoveryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface RecoveryLadderOptions {
  provider: LLMProvider;
  request: CompletionRequest;
  tier: ModelTier;
  router?: RecoveryRouter | null;
  logger?: RecoveryLogger;
  /**
   * Context-overflow compression. Called with stage 0, 1, … ; return the
   * compressed message list for that stage, or null when out of stages.
   */
  compress?: (messages: Message[], stage: number, provider: LLMProvider) => Promise<Message[] | null>;
  /** Called when a fallback provider (not the primary) answered. */
  onFallbackResponse?: (response: CompletionResponse, providerName: string) => void;
  policy?: Partial<RecoveryPolicy>;
  /** Stall window override; default 180s cloud / 900s local per provider. */
  stallMs?: (provider: LLMProvider) => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /**
   * Stream every attempt. Each chunk resets the stall window; a failure
   * resets the channel's draft before the retry or fallback streams again.
   */
  stream?: StreamHandlers;
}

export interface ProviderAttemptFailure {
  provider: string;
  classified: ClassifiedProviderError;
  error: Error;
}

/** Error thrown when every provider in the chain failed. */
export class RecoveryExhaustedError extends Error {
  constructor(public readonly failures: ProviderAttemptFailure[]) {
    super(
      `All providers failed. Attempted: ${failures.map(f => f.provider).join(', ')}. Errors: ${failures
        .map(f => `${f.provider} [${f.classified.errorClass}] ${f.error.message.slice(0, 300)}`)
        .join('; ')}`,
    );
    this.name = 'RecoveryExhaustedError';
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeMessages(request: CompletionRequest): CompletionRequest {
  const messages = request.messages.filter(msg => {
    if (msg.content == null) return false;
    if (typeof msg.content === 'string') return msg.content.length > 0;
    return msg.content.length > 0;
  });
  return messages.length === request.messages.length ? request : { ...request, messages };
}

type AttemptOutcome =
  | { ok: true; response: CompletionResponse }
  | { ok: false; failure: ProviderAttemptFailure; surface: boolean };

/**
 * Execute a completion with typed recovery and fail-over. Throws the original
 * error for surfaced classes (user abort, local policy, unfixable 400), or a
 * RecoveryExhaustedError when every provider failed.
 */
export async function runRecoveryLadder(options: RecoveryLadderOptions): Promise<CompletionResponse> {
  const policy: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...options.policy };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const router = options.router ?? null;
  const logger = options.logger;
  const callerSignal = options.request.signal;
  const stallFor = options.stallMs ?? stallLimitMs;
  const owned = (name: string): boolean => !!router?.getProviderHealth(name);

  const attempt = async (provider: LLMProvider, initial: CompletionRequest): Promise<AttemptOutcome> => {
    let request = initial;
    const counts = { rate: 0, server: 0, timeout: 0, rotations: 0, compressStage: 0 };
    let thinkingStripped = false;
    let paramsStripped = false;

    for (;;) {
      try {
        const handlers = options.stream;
        const response = await callWithStallGuard(provider.name, stallFor(provider), callerSignal, (signal, touch) =>
          handlers
            ? completeWithStream(provider, { ...request, signal }, {
                ...handlers,
                onTextDelta: (text) => { touch(); handlers.onTextDelta?.(text); },
                onToolUseStart: (name) => { touch(); handlers.onToolUseStart?.(name); },
              })
            : provider.complete({ ...request, signal }),
        ).catch((error: unknown) => {
          handlers?.onTextReset?.();
          throw error;
        });
        if (owned(provider.name)) router!.recordProviderSuccess(provider.name);
        return { ok: true, response };
      } catch (raw) {
        const error = raw instanceof Error ? raw : new Error(String(raw));
        const classified = classifyProviderError(error, { callerAborted: callerSignal?.aborted === true });
        const fail = (surface = false): AttemptOutcome => ({ ok: false, surface, failure: { provider: provider.name, classified, error } });
        const log = (action: RecoveryAction, extra: Record<string, unknown> = {}): void =>
          logger?.warn(
            { provider: provider.name, errorClass: classified.errorClass, status: classified.status, action, ...extra, error: error.message.slice(0, 300) },
            'Provider error: recovery action',
          );
        const rotate = (): boolean => {
          if (counts.rotations >= policy.maxRotations || !canRotate(provider)) return false;
          if (!provider.rotateCredential()) return false;
          counts.rotations++;
          log('rotate_credentials', { rotation: counts.rotations });
          return true;
        };

        // The caller's own deadline or /stop: never retry or fail over.
        if (callerSignal?.aborted) throw error;

        switch (classified.errorClass) {
          case 'user_abort':
          case 'local_policy':
            throw error;

          case 'rate_limit': {
            if (rotate()) continue;
            const tooLong = classified.retryAfterMs !== undefined && classified.retryAfterMs > MAX_RETRY_AFTER_MS;
            if (!tooLong && counts.rate < policy.rateLimitRetries) {
              const delay = retryDelayMs(classified, counts.rate, policy, random);
              counts.rate++;
              log('retry', { attempt: counts.rate, delayMs: Math.round(delay) });
              await sleep(delay, callerSignal);
              continue;
            }
            log('fallback');
            return fail();
          }

          case 'context_overflow': {
            let compressedNow = false;
            while (options.compress && !compressedNow && counts.compressStage < 4) {
              const stage = counts.compressStage++;
              let compressed: Message[] | null;
              try {
                compressed = await options.compress(request.messages, stage, provider);
              } catch (e) {
                logger?.warn({ error: (e as Error).message, stage }, 'Compaction stage failed');
                continue;
              }
              if (!compressed) break;
              log('compress', { stage, before: request.messages.length, after: compressed.length });
              request = { ...request, messages: compressed };
              compressedNow = true;
            }
            if (compressedNow) continue;
            log('fallback');
            return fail();
          }

          case 'auth':
          case 'billing':
            if (rotate()) continue;
            log('fallback');
            return fail();

          case 'server':
            if (counts.server < policy.serverRetries) {
              const delay = retryDelayMs(classified, counts.server, policy, random);
              counts.server++;
              log('retry', { attempt: counts.server, delayMs: Math.round(delay) });
              await sleep(delay, callerSignal);
              continue;
            }
            log('fallback');
            return fail();

          case 'timeout':
            if (counts.timeout < policy.timeoutRetries) {
              counts.timeout++;
              log('retry', { attempt: counts.timeout });
              continue;
            }
            log('fallback');
            return fail();

          case 'thinking_signature':
            if (!thinkingStripped) {
              thinkingStripped = true;
              request = stripThinkingFromRequest(request);
              log('strip_thinking');
              continue;
            }
            log('fallback');
            return fail();

          case 'bad_request': {
            // Never resend the same rejected request. When the error names a
            // tool or parameter we can drop, try once without it.
            if (!paramsStripped && classified.mentionsToolsOrSchema) {
              const fixed = stripProblemParams(request, classified);
              if (fixed) {
                paramsStripped = true;
                request = fixed.request;
                log('strip_params', { removed: fixed.removed });
                continue;
              }
            }
            log('surface');
            return fail(true);
          }

          case 'content_filter':
          case 'unknown':
          default:
            log('fallback');
            return fail();
        }
      }
    }
  };

  const recordFailure = (failure: ProviderAttemptFailure): void => {
    if (!router || !owned(failure.provider)) return;
    router.recordProviderFailure(failure.provider, failure.error);
    const { errorClass, retryAfterMs } = failure.classified;
    const cooldownMs = errorClass === 'auth'
      ? policy.authCooldownMs
      : errorClass === 'billing'
        ? policy.billingCooldownMs
        : errorClass === 'rate_limit'
          ? Math.min(Math.max(retryAfterMs ?? policy.rateLimitCooldownMs, 1_000), 60 * 60_000)
          : undefined;
    if (cooldownMs !== undefined) router.coolProvider?.(failure.provider, cooldownMs, errorClass);
  };

  const failures: ProviderAttemptFailure[] = [];
  const primary = options.provider;
  const request = sanitizeMessages(options.request);

  // A primary the Router has benched (billing, auth, long rate limit) is
  // skipped when there is somewhere else to go.
  const candidates = (): string[] => {
    if (!router) return [];
    const mapping = router.getTierMapping();
    const names = [...new Set([...(mapping[options.tier] ?? []), ...router.getProviderOrder()])];
    return names.filter(name => {
      if (name === primary.name || failures.some(f => f.provider === name)) return false;
      const p = router.getProvider(name);
      return !!p && p.isAvailable() && router.canAttemptProvider(name);
    });
  };

  const primaryBenched = owned(primary.name) && !router!.canAttemptProvider(primary.name);
  if (primaryBenched && candidates().length > 0) {
    logger?.info({ provider: primary.name }, 'Primary provider is cooling down; going straight to fallback');
  } else {
    const outcome = await attempt(primary, request);
    if (outcome.ok) return outcome.response;
    recordFailure(outcome.failure);
    if (outcome.surface) throw outcome.failure.error;
    failures.push(outcome.failure);
  }

  for (;;) {
    const next = candidates()[0];
    if (!next) break;
    const provider = router!.getProvider(next)!;
    logger?.warn({ from: primary.name, to: next, previous: failures.at(-1)?.classified.errorClass }, 'Failing over to next provider');
    const outcome = await attempt(provider, request);
    if (outcome.ok) {
      options.onFallbackResponse?.(outcome.response, next);
      logger?.info({ fallbackProvider: next, attempted: failures.map(f => f.provider) }, 'Fallback succeeded');
      return outcome.response;
    }
    recordFailure(outcome.failure);
    if (outcome.surface) throw outcome.failure.error;
    failures.push(outcome.failure);
  }

  if (failures.length === 1) {
    // No fallback was possible: surface the provider's own error unchanged.
    throw failures[0].error;
  }
  if (failures.length === 0) throw new Error(`Provider ${primary.name} is cooling down and no fallback is available`);
  throw new RecoveryExhaustedError(failures);
}
