/**
 * Retry-on-truncation for structured (JSON) background completions.
 *
 * Reasoning-prone models (qwen3.6, Gemini, DeepSeek-R1) sometimes spend the
 * whole max_tokens budget on hidden reasoning and return truncated or empty
 * JSON with stopReason 'max_tokens'. Before this helper nothing retried: the
 * Pi's relation_classify traces were 20/20 max_tokens + parsed_ok=0.
 *
 * completeWithTruncationRetry() runs the request once; if the response was
 * cut off at max_tokens AND the caller's parser rejects it, the request is
 * retried with a larger budget (growFactor x, bounded by the model's output
 * limit), thinking explicitly disabled, and a short "Return ONLY the JSON."
 * nudge appended to the last user message. It also keeps a per
 * purpose/provider/model truncation streak and logs a single ERROR when the
 * same route truncates three times in a row, so a mis-chosen model shows up
 * in the logs without spamming every call.
 */

import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from './types.js';
import { getModelTokenLimits } from '../routing/model-limits.js';
import { extractResponseText } from '../proactive/proactive-utils.js';

/** Minimal pino-compatible sink. */
export interface TruncationRetryLogger {
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

export interface TruncationRetryOptions<T> {
  /** Parse the response text; return null when the payload is unusable. */
  parse: (text: string, response: CompletionResponse) => T | null;
  /** Total attempts including the first call (default 2 = one retry). */
  maxAttempts?: number;
  /** Multiplier applied to maxTokens on each retry (default 2). */
  growFactor?: number;
  /** Nudge appended to the last user message on retry. */
  retryInstruction?: string;
  logger?: TruncationRetryLogger;
  /** Overrides request.purpose for logging/streak keys. */
  purpose?: string;
}

export interface TruncationRetryResult<T> {
  response: CompletionResponse;
  /** Parsed payload from the last attempt, or null when every attempt failed. */
  parsed: T | null;
  /** Number of provider calls made. */
  attempts: number;
  /** True when the final response was still cut off at max_tokens. */
  truncated: boolean;
}

export const DEFAULT_RETRY_INSTRUCTION = 'Return ONLY the JSON.';
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_GROW_FACTOR = 2;
/** Used as the base budget when the request did not set maxTokens. */
const FALLBACK_BASE_TOKENS = 1_024;
/** Consecutive truncations of one purpose/provider/model before an ERROR is logged. */
export const TRUNCATION_STREAK_ALERT = 3;

const truncationStreaks = new Map<string, number>();

/** Test hook: clear the consecutive-truncation counters. */
export function resetTruncationStreaks(): void {
  truncationStreaks.clear();
}

/** Test/diagnostics hook: current streak for a route key. */
export function truncationStreak(purpose: string, provider: string, model: string): number {
  return truncationStreaks.get(streakKey(purpose, provider, model)) ?? 0;
}

function streakKey(purpose: string, provider: string, model: string): string {
  return `${purpose}|${provider}|${model}`;
}

function resolveModel(provider: LLMProvider, response?: CompletionResponse): string {
  return response?.model || provider.model || provider.name;
}

function appendInstruction(messages: Message[], instruction: string): Message[] {
  const copy = messages.map((m) => ({ ...m }));
  for (let i = copy.length - 1; i >= 0; i--) {
    const msg = copy[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.includes(instruction)) return copy;
      copy[i] = { ...msg, content: `${msg.content}\n\n${instruction}` };
    } else {
      copy[i] = { ...msg, content: [...msg.content, { type: 'text', text: instruction }] };
    }
    return copy;
  }
  copy.push({ role: 'user', content: instruction });
  return copy;
}

/** Budget for the next attempt: grow, but never beyond the model's output limit. */
export function grownTokenBudget(
  provider: LLMProvider,
  response: CompletionResponse,
  previous: number | undefined,
  growFactor: number
): number {
  const base = previous ?? Math.max(FALLBACK_BASE_TOKENS, response.usage?.outputTokens ?? 0);
  const limits = getModelTokenLimits({ name: provider.name, model: resolveModel(provider, response) });
  return Math.max(1, Math.min(Math.ceil(base * growFactor), limits.maxOutputTokens));
}

function recordOutcome(
  key: string,
  truncated: boolean,
  logger: TruncationRetryLogger | undefined,
  details: Record<string, unknown>
): void {
  if (!truncated) {
    truncationStreaks.delete(key);
    return;
  }
  const streak = (truncationStreaks.get(key) ?? 0) + 1;
  truncationStreaks.set(key, streak);
  if (streak === TRUNCATION_STREAK_ALERT) {
    logger?.error(
      { ...details, consecutiveTruncations: streak },
      'Structured completion keeps truncating at max_tokens for this purpose/model — ' +
        'the model is probably spending the budget on reasoning; consider a different model ' +
        'for this purpose or a larger budget'
    );
  }
}

/**
 * Run `request` and retry once with a larger budget when the response was
 * truncated at max_tokens and could not be parsed. Never throws for parse
 * failures; provider errors propagate.
 */
export async function completeWithTruncationRetry<T>(
  provider: LLMProvider,
  request: CompletionRequest,
  options: TruncationRetryOptions<T>
): Promise<TruncationRetryResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const growFactor = Math.max(1, options.growFactor ?? DEFAULT_GROW_FACTOR);
  const instruction = options.retryInstruction ?? DEFAULT_RETRY_INSTRUCTION;
  const purpose = options.purpose ?? request.purpose ?? 'unknown';

  let current: CompletionRequest = request;
  let response: CompletionResponse | undefined;
  let parsed: T | null = null;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    response = await provider.complete(current);
    parsed = options.parse(extractResponseText(response.content), response);
    const truncated = response.stopReason === 'max_tokens';

    if (parsed !== null || !truncated || attempt >= maxAttempts) break;

    const nextMaxTokens = grownTokenBudget(provider, response, current.maxTokens, growFactor);
    options.logger?.warn(
      {
        purpose,
        provider: provider.name,
        model: resolveModel(provider, response),
        attempt,
        maxTokens: current.maxTokens ?? null,
        nextMaxTokens,
        outputTokens: response.usage?.outputTokens ?? null,
        reasoningTokens: response.usage?.reasoningTokens ?? null,
      },
      'Structured completion truncated at max_tokens and unparseable; retrying with a larger budget'
    );
    current = {
      ...current,
      maxTokens: nextMaxTokens,
      enableThinking: false,
      messages: appendInstruction(current.messages, instruction),
    };
  }

  const finalTruncated = response.stopReason === 'max_tokens' && parsed === null;
  const model = resolveModel(provider, response);
  recordOutcome(streakKey(purpose, provider.name, model), finalTruncated, options.logger, {
    purpose,
    provider: provider.name,
    model,
    attempts: attempt,
    maxTokens: current.maxTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    reasoningTokens: response.usage?.reasoningTokens ?? null,
  });

  return { response, parsed, attempts: attempt, truncated: finalTruncated };
}
