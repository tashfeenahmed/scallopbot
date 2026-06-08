import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionRequest } from './types.js';

// Mock the openai SDK with an APIError class and per-key create behavior:
// the first key always 429s; the second key succeeds. This lets us assert the
// OpenAIProvider benches the failed key and rebuilds its client with the next.
vi.mock('openai', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const keysUsed: string[] = [];
  const MockOpenAI = vi.fn().mockImplementation((cfg: { apiKey: string }) => {
    keysUsed.push(cfg.apiKey);
    return {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            if (cfg.apiKey === 'k1') throw new APIError(429, 'rate limited');
            return {
              choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: 'gpt-4.1',
            };
          }),
        },
      },
    };
  }) as unknown as { (cfg: { apiKey: string }): unknown; APIError: typeof APIError; __keysUsed: string[] };
  MockOpenAI.APIError = APIError;
  MockOpenAI.__keysUsed = keysUsed;
  return { default: MockOpenAI };
});

const req: CompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('OpenAIProvider credential-pool rotation (wiring)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rotates to the next key on a 429 and succeeds', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    const { default: OpenAI } = await import('openai');
    (OpenAI as unknown as { __keysUsed: string[] }).__keysUsed.length = 0;

    const provider = new OpenAIProvider({ apiKey: 'k1', apiKeys: ['k1', 'k2'] });
    const res = await provider.complete(req);

    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    expect(text).toBe('ok');

    // First client built with k1 (which 429s), then a new client with k2.
    const keysUsed = (OpenAI as unknown as { __keysUsed: string[] }).__keysUsed;
    expect(keysUsed[0]).toBe('k1');
    expect(keysUsed).toContain('k2');
  }, 15000);

  it('reports available while at least one pooled key is healthy', async () => {
    const { OpenAIProvider } = await import('./openai.js');
    const provider = new OpenAIProvider({ apiKey: 'k1', apiKeys: ['k1', 'k2'] });
    expect(provider.isAvailable()).toBe(true);
  });
});
