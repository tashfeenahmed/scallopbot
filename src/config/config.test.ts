import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
        expect(result.data.agent.foregroundCallTimeoutMs).toBe(25_000);
        expect(result.data.agent.turnTimeoutMs).toBe(55_000);
        expect(result.data.logging.level).toBe('info');
        expect(result.data.providers.anthropic.model).toBe('claude-sonnet-4-20250514');
        expect(result.data.evolution).toMatchObject({
          enabled: false,
          requireFitnessGate: true,
          includeSessionContent: false,
          allowSeparateEvalProvider: false,
          useLlmJudge: true,
          curatorEnabled: true,
        });
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

    it('does not accept a configuration that disables autonomous fitness evaluation', async () => {
      const { configSchema } = await import('./config.js');
      const result = configSchema.safeParse({
        providers: { anthropic: { apiKey: 'sk-ant-test-key' } },
        channels: { telegram: { enabled: false, botToken: '' } },
        agent: { workspace: '/tmp/workspace' },
        evolution: { requireFitnessGate: false },
      });
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
      process.env.AGENT_FOREGROUND_CALL_TIMEOUT_MS = '20000';
      process.env.AGENT_TURN_TIMEOUT_MS = '40000';
      process.env.LOG_LEVEL = 'debug';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.providers.anthropic.apiKey).toBe('sk-ant-env-key');
      expect(config.channels.telegram.botToken).toBe('env-bot-token');
      expect(config.agent.workspace).toBe('/env/workspace');
      expect(config.agent.maxIterations).toBe(15);
      expect(config.agent.foregroundCallTimeoutMs).toBe(20_000);
      expect(config.agent.turnTimeoutMs).toBe(40_000);
      expect(config.logging.level).toBe('debug');
    });

    it('keeps the fitness gate mandatory even if a legacy environment flag says false', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.EVOLUTION_REQUIRE_FITNESS_GATE = 'false';
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().evolution.requireFitnessGate).toBe(true);
    });

    it('keeps self-evolution off unless the operator explicitly sets exact true', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      // Empty is equivalent to absent while preventing a developer's local
      // .env from being injected into this hermetic configuration test.
      process.env.EVOLUTION_ENABLED = '';
      let configModule = await import('./config.js');
      expect(configModule.loadConfig().evolution.enabled).toBe(false);

      vi.resetModules();
      process.env.EVOLUTION_ENABLED = 'TRUE';
      configModule = await import('./config.js');
      expect(configModule.loadConfig().evolution.enabled).toBe(false);

      vi.resetModules();
      process.env.EVOLUTION_ENABLED = 'true';
      configModule = await import('./config.js');
      expect(configModule.loadConfig().evolution.enabled).toBe(true);
    });

    it('should use default workspace if not provided', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      delete process.env.AGENT_WORKSPACE;

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.agent.workspace).toBe(process.cwd());
    });

    it('should parse custom cost pricing from COST_MODEL_PRICING', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      process.env.COST_MODEL_PRICING = JSON.stringify({
        'my_provider/my-model': { inputPerMillion: 0.3, outputPerMillion: 1.8 },
      });

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.cost.customPricing['my_provider/my-model']).toEqual({
        inputPerMillion: 0.3,
        outputPerMillion: 1.8,
      });
    });

    it('should parse lifecycle event relay settings', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
      process.env.SCALLOPBOT_EVENT_WEBHOOK_URL = 'https://example.com/scallopbot/events';
      process.env.SCALLOPBOT_EVENT_WEBHOOK_SECRET = 'shared-secret';
      process.env.SCALLOPBOT_EVENT_WEBHOOK_TIMEOUT_MS = '2500';
      process.env.SCALLOPBOT_AGENT_ID = 'example-bot';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.eventRelay).toEqual({
        webhookUrl: 'https://example.com/scallopbot/events',
        webhookSecret: 'shared-secret',
        webhookTimeoutMs: 2500,
        agentId: 'example-bot',
      });
    });

    describe('multi-model mode (CUSTOM_PROVIDER_*)', () => {
      beforeEach(() => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
        process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token';
        // Isolate from any ambient custom-provider vars
        for (const k of Object.keys(process.env)) {
          if (
            k.startsWith('CUSTOM_PROVIDER_')
            || k === 'MULTI_MODEL_ENABLED'
            || k === 'MULTI_MODEL_TIMEOUT_MS'
          ) delete process.env[k];
        }
      });

      it('defaults to disabled with no custom providers', async () => {
        const { loadConfig } = await import('./config.js');
        const config = loadConfig();
        expect(config.multiModel.enabled).toBe(false);
        expect(config.multiModel.providers).toEqual([]);
        expect(config.multiModel.timeoutMs).toBe(60_000);
      });

      it('parses CUSTOM_PROVIDER_<NAME> as baseUrl|model|apiKey with lowercased name', async () => {
        process.env.MULTI_MODEL_ENABLED = 'true';
        process.env.CUSTOM_PROVIDER_MY_MEMORY = 'http://localhost:11434/v1|my-memory-q5|sk-whatever';
        process.env.CUSTOM_PROVIDER_TOOLS = 'http://localhost:11434/v1|my-tools-q5';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.multiModel.enabled).toBe(true);
        const byName = Object.fromEntries(config.multiModel.providers.map((p) => [p.name, p]));
        expect(byName.my_memory).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'my-memory-q5', apiKey: 'sk-whatever' });
        expect(byName.tools).toMatchObject({ model: 'my-tools-q5', apiKey: 'sk-local' }); // apiKey defaulted
      });

      it('loads and validates the custom-provider request timeout', async () => {
        process.env.MULTI_MODEL_TIMEOUT_MS = '45000';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().multiModel.timeoutMs).toBe(45_000);

        process.env.MULTI_MODEL_TIMEOUT_MS = '1000';
        expect(() => loadConfig()).toThrow(/multiModel\.timeoutMs/);
      });

      it('still parses providers when the toggle is off (gateway ignores them)', async () => {
        process.env.CUSTOM_PROVIDER_TOOLS = 'http://localhost:11434/v1|my-tools-q5';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.multiModel.enabled).toBe(false);
        expect(config.multiModel.providers).toHaveLength(1);
      });

      it('throws on malformed values (fail fast at startup)', async () => {
        process.env.CUSTOM_PROVIDER_TOOLS = 'http://localhost:11434/v1'; // missing |model

        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/expected "<baseUrl>\|<model>/);
      });

      it('throws when shadowing a built-in provider name', async () => {
        process.env.CUSTOM_PROVIDER_OPENAI = 'http://localhost:11434/v1|sneaky';

        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/shadows a built-in provider/);
      });

      it('rejects invalid baseUrl via schema validation', async () => {
        process.env.CUSTOM_PROVIDER_TOOLS = 'not-a-url|my-model';

        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow();
      });
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

    it('should default per-purpose models to behavior-preserving values', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      for (const v of ['MODEL_RERANKER', 'MODEL_FACT_EXTRACTION', 'MODEL_COGNITION', 'MODEL_CRITIC', 'MODEL_EVOLUTION', 'MODEL_EVAL']) {
        delete process.env[v];
      }

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.models.reranker).toEqual({ tier: 'fast' });
      expect(config.models.factExtraction).toEqual({ use: 'background' });
      expect(config.models.cognition).toEqual({ tier: 'fast' });
      expect(config.models.critic).toEqual({ use: 'main' });
      expect(config.models.evolution).toEqual({ use: 'main' });
      expect(config.models.eval).toEqual({ provider: 'moonshot', model: 'kimi-k2.5' });
    });

    it('should apply MODEL_<PURPOSE> env overrides', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      process.env.MODEL_EVOLUTION = 'groq';
      process.env.MODEL_RERANKER = 'tier:capable';
      process.env.MODEL_EVAL = 'moonshot:kimi-k2.6';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.models.evolution).toEqual({ provider: 'groq' });
      expect(config.models.reranker).toEqual({ tier: 'capable' });
      expect(config.models.eval).toEqual({ provider: 'moonshot', model: 'kimi-k2.6' });
      // untouched purposes keep their defaults
      expect(config.models.cognition).toEqual({ tier: 'fast' });
    });

    describe('single switch (MODEL)', () => {
      beforeEach(() => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
        process.env.AGENT_WORKSPACE = '/env/workspace';
        // Isolate from ambient routing vars
        for (const k of Object.keys(process.env)) {
          if (
            k === 'MODEL' ||
            k === 'PROVIDER_ORDER' ||
            k === 'MULTI_MODEL_ENABLED' ||
            k.startsWith('MODEL_') ||
            k.startsWith('CUSTOM_PROVIDER_')
          ) {
            delete process.env[k];
          }
        }
      });

      it('points every purpose AND the chat order at one provider', async () => {
        process.env.MODEL = 'openrouter';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        for (const purpose of ['reranker', 'factExtraction', 'cognition', 'critic', 'evolution', 'eval'] as const) {
          expect(config.models[purpose]).toEqual({ provider: 'openrouter' });
        }
        expect(config.routing.providerOrder).toEqual(['openrouter']);
      });

      it('lets MODEL_<PURPOSE> override the MODEL switch per purpose', async () => {
        process.env.MODEL = 'openrouter';
        process.env.MODEL_COGNITION = 'tier:fast';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.models.cognition).toEqual({ tier: 'fast' });          // specific wins
        expect(config.models.reranker).toEqual({ provider: 'openrouter' });  // others follow MODEL
      });

      it('lets PROVIDER_ORDER override the MODEL switch for chat only', async () => {
        process.env.MODEL = 'openrouter';
        process.env.PROVIDER_ORDER = 'moonshot,openrouter';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.routing.providerOrder).toEqual(['moonshot', 'openrouter']); // chat: explicit wins
        expect(config.models.cognition).toEqual({ provider: 'openrouter' });       // purposes still follow MODEL
      });

      it('accepts a CUSTOM_PROVIDER_* name as the switch target', async () => {
        process.env.MULTI_MODEL_ENABLED = 'true';
        process.env.CUSTOM_PROVIDER_MY_LOCAL = 'http://localhost:11434/v1|my-local-model';
        process.env.MODEL = 'my_local';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.routing.providerOrder).toEqual(['my_local']);
        expect(config.models.cognition).toEqual({ provider: 'my_local' });
      });

      it('throws on an unknown provider name (typo)', async () => {
        process.env.MODEL = 'openroutr';

        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/unknown provider "openroutr"/);
      });

      it('records explicit MODEL_<PURPOSE> pins (carve-outs) in modelPins', async () => {
        process.env.MODEL = 'openrouter';
        process.env.MODEL_FACT_EXTRACTION = 'moonshot';

        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        // Pinned purpose is recorded and keeps its own model
        expect(config.modelPins).toContain('factExtraction');
        expect(config.models.factExtraction).toEqual({ provider: 'moonshot' });
        // A purpose that only follows the MODEL switch is NOT pinned
        expect(config.modelPins).not.toContain('cognition');
        expect(config.models.cognition).toEqual({ provider: 'openrouter' });
      });

      it('leaves defaults unchanged when MODEL is unset', async () => {
        const { loadConfig } = await import('./config.js');
        const config = loadConfig();

        expect(config.models.reranker).toEqual({ tier: 'fast' });
        expect(config.models.eval).toEqual({ provider: 'moonshot', model: 'kimi-k2.5' });
        expect(config.routing.providerOrder).toEqual(['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama']);
      });
    });

    it('should default tuning knobs to prior hardcoded values', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      for (const v of ['GARDENER_DEEP_INTERVAL_MS', 'BEST_OF_N', 'BEST_OF_N_THRESHOLD', 'SKILL_TIMEOUT_MS']) {
        delete process.env[v];
      }

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.tuning.gardener.deepIntervalMs).toBe(72 * 60 * 1000);
      expect(config.tuning.gardener.sleepIntervalMs).toBe(20 * 60 * 60 * 1000);
      expect(config.tuning.gardener.quietHoursStart).toBe(2);
      expect(config.tuning.gardener.quietHoursEnd).toBe(5);
      expect(config.tuning.critic.bestOfN).toBe(1);
      expect(config.tuning.critic.bestOfNThreshold).toBe(0.85);
      expect(config.tuning.skills.timeoutMs).toBe(120_000);
      expect(config.tuning.skills.maxOutputBytes).toBe(1024 * 1024);
    });

    it('should apply tuning env overrides', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      process.env.GARDENER_DEEP_INTERVAL_MS = '600000';
      process.env.BEST_OF_N = '3';
      process.env.BEST_OF_N_THRESHOLD = '0.7';
      process.env.SKILL_TIMEOUT_MS = '30000';

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.tuning.gardener.deepIntervalMs).toBe(600000);
      expect(config.tuning.critic.bestOfN).toBe(3);
      expect(config.tuning.critic.bestOfNThreshold).toBe(0.7);
      expect(config.tuning.skills.timeoutMs).toBe(30000);
    });

    it('loads global and per-channel tool policies from validated JSON', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.AGENT_WORKSPACE = '/env/workspace';
      process.env.TOOL_POLICY_JSON = JSON.stringify({ deny: ['bash'] });
      process.env.TOOL_CHANNEL_POLICIES_JSON = JSON.stringify({ telegram: { allow: ['read_file'] } });

      const { loadConfig } = await import('./config.js');
      const config = loadConfig();

      expect(config.tools.policy).toEqual({ deny: ['bash'] });
      expect(config.tools.channelPolicies?.telegram).toEqual({ allow: ['read_file'] });
    });

    it('fails fast on malformed tool-policy JSON', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
      process.env.TOOL_POLICY_JSON = '{bad json';
      const { loadConfig } = await import('./config.js');
      expect(() => loadConfig()).toThrow(/TOOL_POLICY_JSON/);
    });
  });
});
