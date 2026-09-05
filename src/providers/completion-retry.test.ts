import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  completeWithTruncationRetry,
  grownTokenBudget,
  resetTruncationStreaks,
  truncationStreak,
  TRUNCATION_STREAK_ALERT,
  DEFAULT_RETRY_INSTRUCTION,
} from './completion-retry.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from './types.js';

function reply(
  text: string,
  stopReason: CompletionResponse['stopReason'],
  usage: Partial<CompletionResponse['usage']> = {}
): CompletionResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason,
    usage: { inputTokens: 100, outputTokens: 10, ...usage },
    model: 'qwen/qwen3.6-plus',
  };
}

function makeProvider(responses: CompletionResponse[]): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn();
  for (const r of responses) complete.mockResolvedValueOnce(r);
  return { name: 'openrouter', model: 'qwen/qwen3.6-plus', complete, isAvailable: () => true };
}

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const baseRequest: CompletionRequest = {
  messages: [{ role: 'user', content: 'Classify these facts.' }],
  maxTokens: 1536,
  purpose: 'relation_classify',
};

describe('completeWithTruncationRetry', () => {
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    resetTruncationStreaks();
  });

  it('returns the first response untouched when it parses', async () => {
    const provider = makeProvider([reply('{"ok":true}', 'end_turn')]);
    const result = await completeWithTruncationRetry(provider, baseRequest, { parse: parseJson, logger });

    expect(result.parsed).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(result.truncated).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not retry a parse failure that was not truncated', async () => {
    const provider = makeProvider([reply('not json', 'end_turn')]);
    const result = await completeWithTruncationRetry(provider, baseRequest, { parse: parseJson, logger });

    expect(result.parsed).toBeNull();
    expect(result.attempts).toBe(1);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('retries once with doubled budget, thinking off and a JSON-only nudge', async () => {
    const provider = makeProvider([
      reply('', 'max_tokens', { outputTokens: 1538, reasoningTokens: 1536 }),
      reply('{"classifications":[]}', 'end_turn'),
    ]);

    const result = await completeWithTruncationRetry(provider, baseRequest, { parse: parseJson, logger });

    expect(result.parsed).toEqual({ classifications: [] });
    expect(result.attempts).toBe(2);
    expect(result.truncated).toBe(false);
    expect(provider.complete).toHaveBeenCalledTimes(2);

    const retry = provider.complete.mock.calls[1][0] as CompletionRequest;
    expect(retry.maxTokens).toBe(3072);
    expect(retry.enableThinking).toBe(false);
    expect(retry.messages[0].content).toBe(`Classify these facts.\n\n${DEFAULT_RETRY_INSTRUCTION}`);
    // The original request object is not mutated.
    expect(baseRequest.maxTokens).toBe(1536);
    expect(baseRequest.messages[0].content).toBe('Classify these facts.');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual(expect.objectContaining({
      purpose: 'relation_classify',
      model: 'qwen/qwen3.6-plus',
      attempt: 1,
      maxTokens: 1536,
      nextMaxTokens: 3072,
      outputTokens: 1538,
      reasoningTokens: 1536,
    }));
  });

  it('gives up after maxAttempts and reports truncated', async () => {
    const provider = makeProvider([
      reply('', 'max_tokens'),
      reply('{"partial":', 'max_tokens'),
    ]);

    const result = await completeWithTruncationRetry(provider, baseRequest, { parse: parseJson, logger });

    expect(result.parsed).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.attempts).toBe(2);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('caps the grown budget at the model output limit', () => {
    const tiny: LLMProvider = { name: 'tiny', model: 'tiny', complete: vi.fn(), isAvailable: () => true };
    process.env.MODEL_TOKEN_LIMITS = JSON.stringify({ tiny: { contextWindowTokens: 4096, maxOutputTokens: 900 } });
    try {
      expect(grownTokenBudget(tiny, reply('', 'max_tokens'), 800, 2)).toBe(900);
    } finally {
      delete process.env.MODEL_TOKEN_LIMITS;
    }
    // Without a request budget, grow from the observed output size.
    const provider = makeProvider([]);
    expect(grownTokenBudget(provider, reply('', 'max_tokens', { outputTokens: 2000 }), undefined, 2)).toBe(4000);
  });

  it('logs a single ERROR after three consecutive truncations on one route', async () => {
    const truncatedTwice = () => [reply('', 'max_tokens'), reply('', 'max_tokens')];

    for (let i = 0; i < TRUNCATION_STREAK_ALERT + 2; i++) {
      const provider = makeProvider(truncatedTwice());
      await completeWithTruncationRetry(provider, baseRequest, { parse: parseJson, logger });
    }

    expect(truncationStreak('relation_classify', 'openrouter', 'qwen/qwen3.6-plus')).toBe(TRUNCATION_STREAK_ALERT + 2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toEqual(expect.objectContaining({
      purpose: 'relation_classify',
      model: 'qwen/qwen3.6-plus',
      consecutiveTruncations: TRUNCATION_STREAK_ALERT,
    }));
    expect(logger.error.mock.calls[0][1]).toMatch(/different model/);
  });

  it('resets the streak on a successful call', async () => {
    for (let i = 0; i < 2; i++) {
      await completeWithTruncationRetry(
        makeProvider([reply('', 'max_tokens'), reply('', 'max_tokens')]),
        baseRequest,
        { parse: parseJson, logger }
      );
    }
    await completeWithTruncationRetry(makeProvider([reply('{"ok":1}', 'end_turn')]), baseRequest, {
      parse: parseJson,
      logger,
    });
    expect(truncationStreak('relation_classify', 'openrouter', 'qwen/qwen3.6-plus')).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
