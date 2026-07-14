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

    it('shares exactly one outcome brain across foreground, child, and outbound paths', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');
      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });
      await gateway.initialize();

      const runtime = gateway as any;
      expect(runtime.outcomeBrain).toBeDefined();
      expect(runtime.outcomeBrain.getId()).toBe('outcome-brain:primary');
      expect(runtime.agent.outcomeBrain).toBe(runtime.outcomeBrain);
      expect(runtime.subAgentExecutor.outcomeBrain).toBe(runtime.outcomeBrain);
      expect(runtime.outboundQueue.outcomeBrain).toBe(runtime.outcomeBrain);
    });

    it('fails closed when a workflow session cannot be resolved', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');
      const gateway = new Gateway({
        config: createMockConfig(testDir),
        logger: pino({ level: 'silent' }),
      });
      await gateway.initialize();

      const workflow = gateway.getSkillRegistry().getSkill('execute_workflow');
      expect(workflow?.handler).toBeDefined();
      const result = await workflow!.handler!({
        args: { steps: [{ id: 'read', tool: 'memory_get', args: { id: 'missing' } }] },
        workspace: testDir,
        sessionId: 'missing-session',
        userId: 'api:benchmark-user',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('denied by the active session policy');
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
      await fs.writeFile(filePath, `%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n${'x'.repeat(5_000)}\n%%EOF`);

      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: filePath, caption: 'Report' },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
      });

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        'telegram:123',
        await fs.realpath(filePath),
        'Report',
        'session-1',
        undefined,
      );
    });

    it('refuses to substitute an older PDF when a newer generated sibling exists', async () => {
      const { gateway, handler } = await createGatewayWithSendFile();
      const outputDir = path.join(testDir, 'output');
      await fs.mkdir(outputDir, { recursive: true });
      const oldPath = path.join(outputDir, 'competitor_analysis.pdf');
      const newPath = path.join(outputDir, 'competitor_analysis_typst.pdf');
      const pdf = (producer: string) => `%PDF-1.4\n/Producer (${producer})\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n${'x'.repeat(5_000)}\n%%EOF`;
      await fs.writeFile(oldPath, pdf('ReportLab'));
      const oldDate = new Date(Date.now() - 60_000);
      await fs.utimes(oldPath, oldDate, oldDate);
      await fs.writeFile(newPath, pdf('Typst 0.13'));
      const sendSpy = spyOnFileSend(gateway);

      const result = await handler({
        args: { file_path: 'output/competitor_analysis.pdf', caption: 'Competitor analysis' },
        workspace: testDir,
        sessionId: 'session-1',
        userId: 'telegram:123',
        userMessage: 'Send the competitor analysis PDF file to me now',
        turnStartedAt: Date.now(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ARTIFACT_STALE_TARGET');
      expect(result.error).toContain('competitor_analysis_typst.pdf');
      expect(sendSpy).not.toHaveBeenCalled();
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

  describe('native memory_get skill', () => {
    it('maps the configured owner while keeping another Telegram user isolated', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');
      const gateway = new Gateway({
        config: createMockConfig(testDir, {
          channels: {
            telegram: {
              enabled: false,
              botToken: '',
              allowedUsers: ['owner-example'],
              enableVoiceReply: false,
            },
            discord: { enabled: false, botToken: '', applicationId: '' },
            api: { enabled: false, port: 3000, host: '127.0.0.1' },
          },
        }),
        logger: pino({ level: 'silent' }),
      });
      await gateway.initialize();

      const store = (gateway as unknown as {
        scallopMemoryStore: {
          add(input: {
            userId: string;
            content: string;
            category: 'fact';
            importance: number;
            confidence: number;
          }): Promise<{ id: string }>;
          getDatabase(): {
            getMemory(id: string): { accessCount: number } | null;
          };
        };
      }).scallopMemoryStore;
      const ownerMemory = await store.add({
        userId: 'default',
        content: 'The configured owner keeps a synthetic Saffron note.',
        category: 'fact',
        importance: 8,
        confidence: 1,
      });
      const otherMemory = await store.add({
        userId: 'telegram:user-beta',
        content: 'The other user keeps a synthetic Indigo note.',
        category: 'fact',
        importance: 8,
        confidence: 1,
      });
      const handler = gateway.getSkillRegistry().getSkill('memory_get')!.handler!;

      const ownerResult = await handler({
        args: { recent: 10 },
        workspace: testDir,
        sessionId: 'owner-session',
        userId: 'telegram:owner-example',
      });
      const otherResult = await handler({
        args: { recent: 10 },
        workspace: testDir,
        sessionId: 'other-session',
        userId: 'telegram:user-beta',
      });
      const otherAccessCountBefore = store.getDatabase().getMemory(otherMemory.id)!.accessCount;
      const crossUserIdResult = await handler({
        args: { id: otherMemory.id },
        workspace: testDir,
        sessionId: 'owner-session',
        userId: 'telegram:owner-example',
      });

      expect(ownerResult.output).toContain(ownerMemory.id);
      expect(ownerResult.output).toContain('Saffron');
      expect(ownerResult.output).not.toContain('Indigo');
      expect(otherResult.output).toContain(otherMemory.id);
      expect(otherResult.output).toContain('Indigo');
      expect(otherResult.output).not.toContain('Saffron');
      expect(crossUserIdResult.success).toBe(false);
      expect(crossUserIdResult.error).toContain('Memory not found');
      expect(store.getDatabase().getMemory(otherMemory.id)!.accessCount)
        .toBe(otherAccessCountBefore);
    });
  });

  describe('channel management', () => {
    it('fails closed for ambiguous defaults, unavailable channels, and users outside the Telegram allowlist', async () => {
      const { Gateway } = await import('./gateway.js');
      const { pino } = await import('pino');
      const gateway = new Gateway({
        config: createMockConfig(testDir, {
          channels: {
            telegram: {
              enabled: false,
              botToken: '',
              allowedUsers: ['owner-alpha', 'owner-beta'],
              enableVoiceReply: false,
            },
            discord: { enabled: false, botToken: '', applicationId: '' },
            api: { enabled: false, port: 3000, host: '127.0.0.1' },
          },
        }),
        logger: pino({ level: 'silent' }),
      });
      const telegramSource = {
        sendMessage: vi.fn().mockResolvedValue(true),
        sendFile: vi.fn().mockResolvedValue(true),
        getName: () => 'telegram',
      };
      const internals = gateway as unknown as {
        triggerSources: Map<string, typeof telegramSource>;
        resolveTriggerSource(userId: string): { source: typeof telegramSource | null; rawUserId: string };
      };
      internals.triggerSources.set('telegram', telegramSource);

      expect(internals.resolveTriggerSource('default')).toEqual({ source: null, rawUserId: 'default' });
      expect(internals.resolveTriggerSource('api:default')).toEqual({ source: null, rawUserId: 'default' });
      expect(internals.resolveTriggerSource('telegram:outside')).toEqual({ source: null, rawUserId: 'outside' });
    });

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
