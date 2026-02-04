import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// We'll import these once implemented
// import { configSchema, loadConfig, Config } from './config.js';

describe('Config Schema', () => {
  describe('configSchema', () => {
    it('should validate a complete valid configuration', async () => {
      const { configSchema } = await import('./config.js');

      const validConfig = {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
            model: 'claude-sonnet-4-20250514',
          },
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
          },
        },
        agent: {
          workspace: '/tmp/workspace',
          maxIterations: 20,
        },
        logging: {
          level: 'info',
        },
      };

      const result = configSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should use default values when optional fields are missing', async () => {
      const { configSchema } = await import('./config.js');

      const minimalConfig = {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
          },
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
          },
        },
        agent: {
          workspace: '/tmp/workspace',
        },
      };

      const result = configSchema.safeParse(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agent.maxIterations).toBe(100);
        expect(result.data.logging.level).toBe('info');
        expect(result.data.providers.anthropic.model).toBe('claude-sonnet-4-20250514');
      }
    });

    it('should accept configuration with empty anthropic apiKey (uses default)', async () => {
      const { configSchema } = await import('./config.js');

      const configWithEmptyKey = {
        providers: {
          anthropic: {},
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
          },
        },
        agent: {
          workspace: '/tmp/workspace',
        },
      };

      const result = configSchema.safeParse(configWithEmptyKey);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providers.anthropic.apiKey).toBe('');
      }
    });

    it('should reject configuration without workspace', async () => {
      const { configSchema } = await import('./config.js');

      const invalidConfig = {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
          },
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: 'test-bot-token',
          },
        },
        agent: {},
      };

      const result = configSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it('should validate log level enum values', async () => {
      const { configSchema } = await import('./config.js');

      const configWithDebug = {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
          },
        },
        channels: {
          telegram: {
            enabled: false,
            botToken: '',
          },
        },
        agent: {
          workspace: '/tmp/workspace',
        },
        logging: {
          level: 'debug',
        },
      };

      const result = configSchema.safeParse(configWithDebug);
      expect(result.success).toBe(true);

      const invalidLogLevel = {
        ...configWithDebug,
        logging: { level: 'invalid' },
      };
      const invalidResult = configSchema.safeParse(invalidLogLevel);
      expect(invalidResult.success).toBe(false);
    });

    it('should enforce maxIterations as a positive number', async () => {
      const { configSchema } = await import('./config.js');

      const configWithNegativeIterations = {
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
          },
        },
        channels: {
          telegram: {
            enabled: false,
            botToken: '',
          },
        },
        agent: {
          workspace: '/tmp/workspace',
          maxIterations: -5,
        },
      };

      const result = configSchema.safeParse(configWithNegativeIterations);
      expect(result.success).toBe(false);
    });
  });

  describe('loadConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should load configuration from environment variables', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      process.env.AGENT_MAX_ITERATIONS = '15';
      process.env.LOG_LEVEL = 'debug';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.providers.anthropic.apiKey).toBe('sk-ant-env-key');
      expect(config.channels.telegram.botToken).toBe('env-bot-token');
      expect(config.agent.workspace).toBe('/env/workspace');
      expect(config.agent.maxIterations).toBe(15);
      expect(config.logging.level).toBe('debug');
    });

    it('should use default workspace if not provided', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      delete process.env.AGENT_WORKSPACE;

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.agent.workspace).toBe(process.cwd());
    });

    it('should throw error if no LLM provider API key is set', async () => {
      // Import first (which triggers dotenv)
      const { loadConfig } = await import('./config.js');

      // Then delete all provider keys AFTER dotenv has loaded
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      process.env.AGENT_WORKSPACE = '/env/workspace';

      expect(() => loadConfig()).toThrow('At least one LLM provider API key is required');
    });

    it('should allow telegram to be disabled when no token provided', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      delete process.env.TELEGRAM_BOT_TOKEN;
      process.env.AGENT_WORKSPACE = '/env/workspace';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.channels.telegram.enabled).toBe(false);
    });
  });
});
