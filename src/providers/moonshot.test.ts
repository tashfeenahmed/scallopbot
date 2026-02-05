import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoonshotProvider } from './moonshot.js';
import type { CompletionRequest } from './types.js';

// Mock the openai module (Moonshot uses OpenAI-compatible API)
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

describe('MoonshotProvider', () => {
  let provider: MoonshotProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MoonshotProvider({ apiKey: 'test-key' });
  });

  describe('constructor', () => {
    it('should create provider with default model', () => {
      expect(provider.name).toBe('moonshot');
      expect(provider.model).toBe('kimi-k2.5');
    });

    it('should create provider with custom model', () => {
      const customProvider = new MoonshotProvider({
        apiKey: 'test-key',
        model: 'kimi-k2-thinking',
      });
      expect(customProvider.model).toBe('kimi-k2-thinking');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is present', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when API key is empty', () => {
      const noKeyProvider = new MoonshotProvider({ apiKey: '' });
      expect(noKeyProvider.isAvailable()).toBe(false);
    });
  });

  describe('complete', () => {
    it('should format response correctly', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Hello from Kimi!',
              tool_calls: null,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const response = await provider.complete(request);

      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello from Kimi!' });
      expect(response.stopReason).toBe('end_turn');
    });

    it('should include system message in messages array', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            { role: 'system', content: 'You are a helpful assistant' },
          ]),
        })
      );
    });

    it('should handle tool calls', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_456',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city": "Beijing"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Weather?' }],
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.content).toContainEqual({
        type: 'tool_use',
        id: 'call_456',
        name: 'get_weather',
        input: { city: 'Beijing' },
      });
    });
  });

  describe('characteristics', () => {
    it('should be marked as a fast provider', () => {
      expect(provider.characteristics.speed).toBe('fast');
    });

    it('should not be local', () => {
      expect(provider.characteristics.isLocal).toBe(false);
    });
  });

  describe('thinking mode', () => {
    it('should disable thinking mode by default (instant mode)', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        enableThinking: false,
      });

      // Verify thinking is disabled and temperature is 0.6 (instant mode)
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'disabled' },
          temperature: 0.6,
        })
      );
    });

    it('should enable thinking mode when enableThinking is true', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Thoughtful response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        enableThinking: true,
      });

      // Verify thinking is NOT disabled (enabled) and temperature is 1.0 (thinking mode)
      expect(mockCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({
          thinking: expect.anything(),
        })
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 1.0,
        })
      );
    });

    it('should preserve reasoning_content as thinking block in response', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              reasoning_content: 'Let me think about this step by step...',
              content: 'The answer is 42.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 50 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        enableThinking: true,
      });

      // Should return thinking block + text content
      expect(response.content).toHaveLength(2);
      expect(response.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Let me think about this step by step...',
      });
      expect(response.content[1]).toEqual({ type: 'text', text: 'The answer is 42.' });
    });

    it('should restore reasoning_content from thinking blocks in conversation history', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Follow-up' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      // Simulate conversation with preserved thinking block from previous response
      await provider.complete({
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
        enableThinking: true,
      });

      // Verify the assistant message includes reasoning_content from the thinking block
      const callArgs = mockCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.reasoning_content).toBe('Simple arithmetic: 2+2=4');
      expect(assistantMsg.content).toBe('The answer is 4.');
    });

    it('should add placeholder reasoning_content when thinking block is missing', async () => {
      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'kimi-k2.5',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (provider as unknown as { client: typeof mockInstance }).client = mockInstance;

      // Assistant message without thinking block (e.g., from before thinking was enabled)
      await provider.complete({
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
          },
          { role: 'user', content: 'How are you?' },
        ],
        enableThinking: true,
      });

      const callArgs = mockCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg.reasoning_content).toBe('.');
    });

    it('should not enable thinking for non-Kimi models', async () => {
      const nonKimiProvider = new MoonshotProvider({
        apiKey: 'test-key',
        model: 'moonshot-v1-128k', // Legacy model, not Kimi K2
      });

      const { default: OpenAI } = await import('openai');
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'moonshot-v1-128k',
      });

      const mockInstance = new OpenAI({ apiKey: 'test' });
      (mockInstance.chat.completions.create as unknown) = mockCreate;
      (nonKimiProvider as unknown as { client: typeof mockInstance }).client = mockInstance;

      await nonKimiProvider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        enableThinking: true, // Request thinking, but model doesn't support it
      });

      // For non-Kimi models, no thinking param should be sent at all
      expect(mockCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({
          thinking: expect.anything(),
        })
      );
    });
  });
});
