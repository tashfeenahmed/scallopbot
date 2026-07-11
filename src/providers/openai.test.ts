import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from './openai.js';
import type { CompletionRequest } from './types.js';

// Mock the openai module
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  }));
  return { default: MockOpenAI };
});

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider({ apiKey: 'test-key' });
  });

  describe('constructor', () => {
    it('should create provider with default model', () => {
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-4.1');
    });

    it('should create provider with custom model', () => {
      const customProvider = new OpenAIProvider({
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
      });
      expect(customProvider.model).toBe('gpt-4o-mini');
    });

    it('disables hidden SDK retries so configured timeouts reach router fallback', async () => {
      const { default: OpenAI } = await import('openai');
      new OpenAIProvider({
        apiKey: 'test-key',
        baseUrl: 'http://localhost:1234/v1',
        timeout: 45_000,
      });
      expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({
        baseURL: 'http://localhost:1234/v1',
        timeout: 45_000,
        maxRetries: 0,
      }));
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is present', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when API key is empty', () => {
      const noKeyProvider = new OpenAIProvider({ apiKey: '' });
      expect(noKeyProvider.isAvailable()).toBe(false);
    });
  });

  describe('complete', () => {
    it('should format messages correctly for OpenAI', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Hello!',
              tool_calls: null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
        model: 'gpt-4o',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant',
      };

      const response = await provider.complete(request);

      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello!' });
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('passes strict JSON Schema to providers that support it', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}', tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'gpt-4.1',
      });
      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await provider.complete({
        messages: [{ role: 'user', content: 'Return JSON' }],
        structuredOutput: {
          name: 'strict_result',
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' } }, required: ['ok'],
          },
        },
      });

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        response_format: {
          type: 'json_schema',
          json_schema: expect.objectContaining({ name: 'strict_result', strict: true }),
        },
      }));
    });

    it('maps an explicit no-thinking request to none instead of medium reasoning', async () => {
      const { default: OpenAI } = await import('openai');
      const reasoningProvider = new OpenAIProvider({ apiKey: 'test-key', model: 'o4-mini' });
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}', tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'o4-mini',
      });
      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (reasoningProvider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await reasoningProvider.complete({
        messages: [{ role: 'user', content: 'Return JSON' }],
        enableThinking: false,
      });
      await reasoningProvider.complete({
        messages: [{ role: 'user', content: 'Use the provider default' }],
      });

      expect(mockCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ reasoning_effort: 'none' }));
      expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('reasoning_effort');
    });

    it('should handle tool calls correctly', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path": "/test.txt"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        model: 'gpt-4o',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Read file' }],
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.content).toContainEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'read_file',
        input: { path: '/test.txt' },
      });
    });
  });

  describe('formatTools', () => {
    it('should convert tool definitions to OpenAI format', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'gpt-4o',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await provider.complete({
        messages: [{ role: 'user', content: 'Test' }],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            input_schema: {
              type: 'object',
              properties: { arg: { type: 'string' } },
              required: ['arg'],
            },
          },
        ],
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              type: 'function',
              function: {
                name: 'test_tool',
                description: 'A test tool',
                parameters: {
                  type: 'object',
                  properties: { arg: { type: 'string' } },
                  required: ['arg'],
                },
              },
            },
          ],
        })
      );
    });
  });
});
