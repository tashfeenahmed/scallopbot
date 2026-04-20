import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionRequest, Message, ToolDefinition } from './types.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create provider with valid API key', async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      expect(provider.name).toBe('anthropic');
      expect(provider.isAvailable()).toBe(true);
    });

    it('should use default model if not specified', async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      expect(provider.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('should use custom model if specified', async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
        model: 'claude-opus-4-20250514',
      });

      expect(provider.model).toBe('claude-opus-4-20250514');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is provided', async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when API key is empty', async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: '',
      });

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('complete', () => {
    it('should make completion request with correct parameters', async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello, world!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-5-20250929',
      });

      vi.mocked(Anthropic).mockImplementation(() => ({
        messages: { create: mockCreate },
      }) as any);

      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant',
        maxTokens: 1024,
      };

      const response = await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'Hello' }],
        system: [
          {
            type: 'text',
            text: 'You are a helpful assistant',
            cache_control: { type: 'ephemeral' },
          },
        ],
        max_tokens: 1024,
      });

      expect(response.content).toEqual([{ type: 'text', text: 'Hello, world!' }]);
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('should include tools in request when provided', async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/test.txt' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 15 },
        model: 'claude-sonnet-4-5-20250929',
      });

      vi.mocked(Anthropic).mockImplementation(() => ({
        messages: { create: mockCreate },
      }) as any);

      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      const tools: ToolDefinition[] = [{
        name: 'read_file',
        description: 'Read a file from the filesystem',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
          },
          required: ['path'],
        },
      }];

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: 'Read the file /test.txt' }],
        tools,
        maxTokens: 1024,
      };

      const response = await provider.complete(request);

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'read_file' }),
        ]),
      }));

      expect(response.stopReason).toBe('tool_use');
      expect(response.content[0]).toEqual({
        type: 'tool_use',
        id: 'tool-1',
        name: 'read_file',
        input: { path: '/test.txt' },
      });
    });

    it('should use default maxTokens if not specified', async () => {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-5-20250929',
      });

      vi.mocked(Anthropic).mockImplementation(() => ({
        messages: { create: mockCreate },
      }) as any);

      const { AnthropicProvider } = await import('./anthropic.js');
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key',
      });

      await provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        max_tokens: 8192,
      }));
    });
  });
});

describe('ProviderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerProvider', () => {
    it('should register a provider', async () => {
      const { ProviderRegistry, AnthropicProvider } = await import('./index.js');
      const registry = new ProviderRegistry();
      const provider = new AnthropicProvider({ apiKey: 'test-key' });

      registry.registerProvider(provider);

      expect(registry.getProvider('anthropic')).toBe(provider);
    });
  });

  describe('getProvider', () => {
    it('should return registered provider by name', async () => {
      const { ProviderRegistry, AnthropicProvider } = await import('./index.js');
      const registry = new ProviderRegistry();
      const provider = new AnthropicProvider({ apiKey: 'test-key' });

      registry.registerProvider(provider);

      expect(registry.getProvider('anthropic')).toBe(provider);
    });

    it('should return undefined for unregistered provider', async () => {
      const { ProviderRegistry } = await import('./index.js');
      const registry = new ProviderRegistry();

      expect(registry.getProvider('nonexistent')).toBeUndefined();
    });
  });

  describe('getDefaultProvider', () => {
    it('should return the first available provider', async () => {
      const { ProviderRegistry, AnthropicProvider } = await import('./index.js');
      const registry = new ProviderRegistry();
      const provider = new AnthropicProvider({ apiKey: 'test-key' });

      registry.registerProvider(provider);

      expect(registry.getDefaultProvider()).toBe(provider);
    });

    it('should return undefined when no providers available', async () => {
      const { ProviderRegistry } = await import('./index.js');
      const registry = new ProviderRegistry();

      expect(registry.getDefaultProvider()).toBeUndefined();
    });

    it('should skip unavailable providers', async () => {
      const { ProviderRegistry, AnthropicProvider } = await import('./index.js');
      const registry = new ProviderRegistry();

      const unavailableProvider = new AnthropicProvider({ apiKey: '' });
      const availableProvider = new AnthropicProvider({ apiKey: 'valid-key' });
      // Give them different names for testing
      (unavailableProvider as any).name = 'unavailable';
      (availableProvider as any).name = 'available';

      registry.registerProvider(unavailableProvider);
      registry.registerProvider(availableProvider);

      expect(registry.getDefaultProvider()?.name).toBe('available');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return list of available providers', async () => {
      const { ProviderRegistry, AnthropicProvider } = await import('./index.js');
      const registry = new ProviderRegistry();

      const provider1 = new AnthropicProvider({ apiKey: 'key1' });
      const provider2 = new AnthropicProvider({ apiKey: '' });
      (provider1 as any).name = 'provider1';
      (provider2 as any).name = 'provider2';

      registry.registerProvider(provider1);
      registry.registerProvider(provider2);

      const available = registry.getAvailableProviders();
      expect(available).toHaveLength(1);
      expect(available[0].name).toBe('provider1');
    });
  });
});
