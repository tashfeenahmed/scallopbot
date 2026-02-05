import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock the telegram module to avoid actual bot creation
vi.mock('../channels/telegram.js', () => ({
  TelegramChannel: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Helper to create complete mock config
const createMockConfig = (testDir: string, overrides: Record<string, unknown> = {}) => ({
  providers: {
    anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-5-20250929' },
    openai: { apiKey: '', model: 'gpt-4o' },
    groq: { apiKey: '', model: 'llama-3.3-70b-versatile' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' },
    openrouter: { apiKey: '', model: 'anthropic/claude-3-sonnet' },
    moonshot: { apiKey: '', model: 'kimi-k2-0905', enableThinking: false },
    xai: { apiKey: '', model: 'grok-4' },
    ...((overrides.providers as Record<string, unknown>) || {}),
  },
  channels: {
    telegram: { enabled: false, botToken: '', allowedUsers: [], enableVoiceReply: false },
    discord: { enabled: false, botToken: '', applicationId: '' },
    api: { enabled: false, port: 3000, host: '127.0.0.1' },
    ...((overrides.channels as Record<string, unknown>) || {}),
  },
  agent: {
    workspace: testDir,
    maxIterations: 20,
    ...((overrides.agent as Record<string, unknown>) || {}),
  },
  logging: {
    level: 'info' as const,
    ...((overrides.logging as Record<string, unknown>) || {}),
  },
  routing: {
    providerOrder: ['anthropic', 'openai', 'groq', 'ollama'],
    enableComplexityAnalysis: true,
    ...((overrides.routing as Record<string, unknown>) || {}),
  },
  cost: {
    warningThreshold: 0.75,
    ...((overrides.cost as Record<string, unknown>) || {}),
  },
  context: {
    hotWindowSize: 5,
    maxContextTokens: 128000,
    compressionThreshold: 0.7,
    maxToolOutputBytes: 30000,
    ...((overrides.context as Record<string, unknown>) || {}),
  },
  memory: {
    filePath: 'memories.jsonl',
    persist: false, // Disable persistence in tests
    useScallopMemory: false,
    dbPath: 'memories.db',
    ...((overrides.memory as Record<string, unknown>) || {}),
  },
  gateway: {
    port: 3000,
    host: '127.0.0.1',
    ...((overrides.gateway as Record<string, unknown>) || {}),
  },
  tailscale: {
    mode: 'off' as const,
    resetOnExit: true,
    ...((overrides.tailscale as Record<string, unknown>) || {}),
  },
});

describe('Gateway', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-gateway-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should create gateway with valid config', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      expect(gateway).toBeDefined();
    });

    it('should initialize provider registry', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();

      const provider = gateway.getProvider();
      expect(provider).toBeDefined();
      expect(provider?.name).toBe('anthropic');
    });

    it('should initialize tool registry with default tools', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();

      const tools = gateway.getToolRegistry().getAllTools();
      const toolNames = tools.map(t => t.name);

      // Remaining legacy tools (most tools migrated to skills)
      expect(toolNames).toContain('memory_get');
      expect(toolNames).toContain('Skill');

      // memory_get + Skill + comms tools (send_file, send_message, voice_reply)
      expect(tools.length).toBeGreaterThanOrEqual(2);
    });

    it('should initialize session manager', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();

      const sessionManager = gateway.getSessionManager();
      expect(sessionManager).toBeDefined();
    });
  });

  describe('channel management', () => {
    it('should not start telegram channel when disabled', async () => {
      const { Gateway } = await import('./gateway.js');
      const { TelegramChannel } = await import('../channels/telegram.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();
      await gateway.start();

      expect(TelegramChannel).not.toHaveBeenCalled();
    });

    it('should start telegram channel when enabled', async () => {
      const { Gateway } = await import('./gateway.js');
      const { TelegramChannel } = await import('../channels/telegram.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir, {
          channels: {
            telegram: { enabled: true, botToken: 'test-bot-token' },
            discord: { enabled: false, botToken: '', applicationId: '' },
            api: { enabled: false, port: 3000, host: '127.0.0.1' },
          },
        }),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();
      await gateway.start();

      expect(TelegramChannel).toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should handle graceful shutdown', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir, {
          channels: {
            telegram: { enabled: true, botToken: 'test-bot-token' },
            discord: { enabled: false, botToken: '', applicationId: '' },
            api: { enabled: false, port: 3000, host: '127.0.0.1' },
          },
        }),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();
      await gateway.start();

      // Should not throw
      await expect(gateway.stop()).resolves.not.toThrow();
    });
  });
});
