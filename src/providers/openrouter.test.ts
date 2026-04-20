import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterProvider } from './openrouter.js';
import type { CompletionRequest } from './types.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenRouterProvider', () => {
  let provider: OpenRouterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenRouterProvider({ apiKey: 'test-key' });
  });

  describe('constructor', () => {
    it('should create provider with default model', () => {
      expect(provider.name).toBe('openrouter');
      expect(provider.model).toBe('anthropic/claude-3.5-sonnet');
    });

    it('should create provider with custom model', () => {
      const customProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'openai/gpt-4o',
      });
      expect(customProvider.model).toBe('openai/gpt-4o');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is present', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when API key is empty', () => {
      const noKeyProvider = new OpenRouterProvider({ apiKey: '' });
      expect(noKeyProvider.isAvailable()).toBe(false);
    });
  });

  describe('complete', () => {
    it('should make correct API call to OpenRouter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: 'Hello from OpenRouter!',
                  tool_calls: null,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
            },
            model: 'anthropic/claude-3.5-sonnet',
          }),
      });

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are helpful',
      };

      const response = await provider.complete(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
            'HTTP-Referer': expect.any(String),
          }),
        })
      );

      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello from OpenRouter!' });
    });

    it('should handle tool calls correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_789',
                      type: 'function',
                      function: {
                        name: 'search',
                        arguments: '{"query": "test"}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 10 },
            model: 'anthropic/claude-3.5-sonnet',
          }),
      });

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Search' }],
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.content).toContainEqual({
        type: 'tool_use',
        id: 'call_789',
        name: 'search',
        input: { query: 'test' },
      });
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      });

      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'Hi' }] })
      ).rejects.toThrow();
    });

    it('should retry on rate limit', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Map([['retry-after', '1']]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
              model: 'anthropic/claude-3.5-sonnet',
            }),
        });

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(response.content[0]).toEqual({ type: 'text', text: 'OK' });
    });
  });

  describe('reasoning support', () => {
    it('should extract reasoning_content from response as ThinkingContent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  reasoning_content: 'Let me think about this step by step...',
                  content: 'The answer is 42.',
                  tool_calls: null,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
            model: 'qwen/qwen3.6-plus:free',
          }),
      });

      const qwenProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'qwen/qwen3.6-plus:free',
      });

      const response = await qwenProvider.complete({
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
      });

      expect(response.content).toHaveLength(2);
      expect(response.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Let me think about this step by step...',
      });
      expect(response.content[1]).toEqual({
        type: 'text',
        text: 'The answer is 42.',
      });
    });

    it('should extract reasoning field (Qwen3 format) as ThinkingContent', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  reasoning: 'Step 1: analyze the question...',
                  content: 'Here is my answer.',
                  tool_calls: null,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
            model: 'qwen/qwen3.6-plus:free',
          }),
      });

      const qwenProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'qwen/qwen3.6-plus:free',
      });

      const response = await qwenProvider.complete({
        messages: [{ role: 'user', content: 'Explain something' }],
      });

      expect(response.content).toHaveLength(2);
      expect(response.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Step 1: analyze the question...',
      });
      expect(response.content[1]).toEqual({
        type: 'text',
        text: 'Here is my answer.',
      });
    });

    it('should use higher max_tokens for reasoning models', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            model: 'qwen/qwen3.6-plus:free',
          }),
      });

      const qwenProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'qwen/qwen3.6-plus:free',
      });

      await qwenProvider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.max_tokens).toBe(8192);
    });

    it('should preserve thinking blocks in assistant message history', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'Follow-up' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
            model: 'qwen/qwen3.6-plus:free',
          }),
      });

      const qwenProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'qwen/qwen3.6-plus:free',
      });

      await qwenProvider.complete({
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Simple arithmetic: 2+2=4' },
              { type: 'text', text: 'The answer is 4.' },
            ],
          },
          { role: 'user', content: 'Are you sure?' },
        ],
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const assistantMsg = requestBody.messages.find(
        (m: { role: string }) => m.role === 'assistant'
      );
      expect(assistantMsg.reasoning_content).toBe('Simple arithmetic: 2+2=4');
      expect(assistantMsg.content).toBe('The answer is 4.');
    });

    it('should not add reasoning fields for non-reasoning models', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            model: 'anthropic/claude-3.5-sonnet',
          }),
      });

      await provider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.max_tokens).toBe(4096);
    });
  });

  describe('prompt caching', () => {
    it('should request detailed usage and parse cached tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'Cached reply' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 1500,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 1200 },
            },
            model: 'qwen/qwen3.6-plus',
          }),
      });

      const qwenProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'qwen/qwen3.6-plus',
      });

      const response = await qwenProvider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.usage).toEqual({ include: true });
      expect(response.usage.inputTokens).toBe(1500);
      expect(response.usage.cachedInputTokens).toBe(1200);
    });

    it('should omit cachedInputTokens when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            model: 'anthropic/claude-3.5-sonnet',
          }),
      });

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.usage.cachedInputTokens).toBeUndefined();
    });
  });

  describe('model routing', () => {
    it('should support switching models dynamically', () => {
      expect(provider.model).toBe('anthropic/claude-3.5-sonnet');

      const fastProvider = new OpenRouterProvider({
        apiKey: 'test-key',
        model: 'meta-llama/llama-3.3-70b-instruct',
      });
      expect(fastProvider.model).toBe('meta-llama/llama-3.3-70b-instruct');
    });
  });

  describe('characteristics', () => {
    it('should have route-based pricing', () => {
      expect(provider.characteristics.pricingType).toBe('routed');
    });
  });
});
