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
    moonshot: { apiKey: '', model: 'kimi-k2-0905', enableThinking: true },
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
  models: {
    reranker: { tier: 'fast' as const },
    factExtraction: { use: 'background' as const },
    cognition: { tier: 'fast' as const },
    critic: { use: 'main' as const },
    evolution: { use: 'main' as const },
    eval: { provider: 'moonshot', model: 'kimi-k2.5' },
    ...((overrides.models as Record<string, unknown>) || {}),
  },
  evolution: {
    enabled: true,
    minToolCalls: 5,
    reusableScoreBar: 0.8,
    lowQualityThreshold: 0.5,
    maxProposals: 5,
    fitnessEpsilon: 0,
    rollbackWindow: 5,
    ...((overrides.evolution as Record<string, unknown>) || {}),
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

    it('should initialize skill registry with native skills', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();

      const skillRegistry = gateway.getSkillRegistry();
      expect(skillRegistry).toBeDefined();

      // Native skills should be registered
      const skills = skillRegistry.getAvailableSkills();
      const skillNames = skills.map(s => s.name);
      expect(skillNames).toContain('send_message');
      expect(skillNames).toContain('memory_get');
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

  describe('native send_file skill', () => {
    type GatewayWithFileSend = {
      handleFileSend: (userId: string, filePath: string, caption?: string) => Promise<boolean>;
    };

    async function createGatewayWithSendFile() {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');

      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });

      await gateway.initialize();

      const sendFileSkill = gateway.getSkillRegistry().getSkill('send_file');
      expect(sendFileSkill?.handler).toBeDefined();

      return { gateway, handler: sendFileSkill!.handler! };
    }

    function spyOnFileSend(gateway: unknown) {
      return vi.spyOn(gateway as GatewayWithFileSend, 'handleFileSend').mockResolvedValue(true);
    }

    it('allows files from the workspace output directory', async () => {
      const { gateway, handler } = await createGatewayWithSendFile();
      const outputDir = path.join(testDir, 'output');
      await fs.mkdir(outputDir, { recursive: true });
      const filePath = path.join(outputDir, 'report.pdf');
      await fs.writeFile(filePath, 'fake pdf content');

      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: filePath, caption: 'Report' },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
      });

      expect(result.success).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith('telegram:123', await fs.realpath(filePath), 'Report');
    });

    it('rejects files outside the workspace output directory', async () => {
      const { gateway, handler } = await createGatewayWithSendFile();
      const filePath = path.join(testDir, 'secret.txt');
      await fs.writeFile(filePath, 'do not send');

      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: filePath },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Access denied');
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('rejects symlinks from output to files outside output', async () => {
      const { gateway, handler } = await createGatewayWithSendFile();
      const outputDir = path.join(testDir, 'output');
      const privateDir = path.join(testDir, 'private');
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(privateDir, { recursive: true });
      const secretPath = path.join(privateDir, 'secret.txt');
      const linkPath = path.join(outputDir, 'secret-link.txt');
      await fs.writeFile(secretPath, 'do not send');
      await fs.symlink(secretPath, linkPath);

      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: linkPath },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Access denied');
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('rejects a workspace output directory that is itself a symlink', async () => {
      const { gateway, handler } = await createGatewayWithSendFile();
      const outputDir = path.join(testDir, 'output');
      const privateDir = path.join(testDir, 'private');
      await fs.mkdir(privateDir, { recursive: true });
      const secretPath = path.join(privateDir, 'secret.txt');
      await fs.writeFile(secretPath, 'do not send');
      await fs.symlink(privateDir, outputDir);

      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: path.join(outputDir, 'secret.txt') },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Access denied');
      expect(sendSpy).not.toHaveBeenCalled();
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
