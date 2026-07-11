import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from './ollama.js';
import type { CompletionRequest } from './types.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2',
    });
  });

  describe('constructor', () => {
    it('should create provider with default values', () => {
      const defaultProvider = new OllamaProvider({});
      expect(defaultProvider.name).toBe('ollama');
      expect(defaultProvider.model).toBe('llama3.2');
      expect(defaultProvider.baseUrl).toBe('http://localhost:11434');
    });

    it('should create provider with custom model and URL', () => {
      const customProvider = new OllamaProvider({
        baseUrl: 'http://192.168.1.100:11434',
        model: 'mistral',
      });
      expect(customProvider.model).toBe('mistral');
      expect(customProvider.baseUrl).toBe('http://192.168.1.100:11434');
    });
  });

  describe('isAvailable', () => {
    it('should return true when Ollama server is reachable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'llama3.2' }] }),
      });

      const isAvailable = await provider.checkHealth();
      expect(isAvailable).toBe(true);
    });

    it('should return false when Ollama server is not reachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const isAvailable = await provider.checkHealth();
      expect(isAvailable).toBe(false);
    });

    it('should return false when model is not installed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'other-model' }] }),
      });

      const isAvailable = await provider.checkHealth();
      expect(isAvailable).toBe(false);
    });
  });

  describe('complete', () => {
    it('should make correct API call to Ollama', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              role: 'assistant',
              content: 'Hello from Ollama!',
            },
            done: true,
            prompt_eval_count: 10,
            eval_count: 5,
          }),
      });

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are helpful',
      };

      const response = await provider.complete(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/chat',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"model":"llama3.2"'),
        })
      );

      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello from Ollama!' });
    });

    it('should include system message in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            message: { role: 'assistant', content: 'OK' },
            done: true,
            prompt_eval_count: 10,
            eval_count: 5,
          }),
      });

      await provider.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        system: 'Be concise',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.messages[0]).toEqual({
        role: 'system',
        content: 'Be concise',
      });
    });

    it('passes the JSON schema and disables thinking for structured output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          message: { role: 'assistant', content: '{"ok":true}' }, done: true,
          prompt_eval_count: 1, eval_count: 1,
        }),
      });
      const schema = {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' } }, required: ['ok'],
      };

      await provider.complete({
        messages: [{ role: 'user', content: 'Return JSON' }],
        temperature: 0.1,
        maxTokens: 200,
        enableThinking: false,
        structuredOutput: { name: 'strict_result', schema },
      });

      const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
      expect(body).toMatchObject({
        think: false,
        format: schema,
        options: { temperature: 0.1, num_predict: 200 },
      });
    });

    it('fails safely when a model cannot honor no-thinking structured output', async () => {
      const gptOss = new OllamaProvider({ model: 'gpt-oss:20b' });
      await expect(gptOss.complete({
        messages: [{ role: 'user', content: 'Return JSON' }],
        enableThinking: false,
        structuredOutput: {
          name: 'strict_result',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      })).rejects.toThrow('cannot disable thinking for structured output');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw error when API call fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'Hi' }] })
      ).rejects.toThrow('Ollama API error: 500 Internal Server Error');
    });

    it('should handle tool calls (when supported)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'read_file',
                    arguments: { path: '/test.txt' },
                  },
                },
              ],
            },
            done: true,
            prompt_eval_count: 20,
            eval_count: 10,
          }),
      });

      const response = await provider.complete({
        messages: [{ role: 'user', content: 'Read file' }],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      });

      expect(response.stopReason).toBe('tool_use');
      expect(response.content.some((c) => c.type === 'tool_use')).toBe(true);
    });
  });

  describe('characteristics', () => {
    it('should be marked as a local provider', () => {
      expect(provider.characteristics.isLocal).toBe(true);
    });

    it('should have zero cost', () => {
      expect(provider.characteristics.costPerMillionTokens).toBe(0);
    });
  });
});
