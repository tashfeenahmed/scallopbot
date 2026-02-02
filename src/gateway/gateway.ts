import * as path from 'path';
import type { Logger } from 'pino';
import type { Config } from '../config/config.js';
import { AnthropicProvider, ProviderRegistry, type LLMProvider } from '../providers/index.js';
import { createDefaultToolRegistry, type ToolRegistry } from '../tools/index.js';
import { SessionManager } from '../agent/session.js';
import { Agent } from '../agent/agent.js';
import { TelegramChannel } from '../channels/telegram.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/registry.js';
import { Router } from '../routing/router.js';
import { CostTracker } from '../routing/cost.js';
import { MemoryStore, HotCollector, BackgroundGardener, HybridSearch } from '../memory/index.js';
import { ContextManager } from '../routing/context.js';
import { MediaProcessor } from '../media/index.js';

export interface GatewayOptions {
  config: Config;
  logger: Logger;
}

export class Gateway {
  private config: Config;
  private logger: Logger;

  private providerRegistry: ProviderRegistry | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private sessionManager: SessionManager | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private router: Router | null = null;
  private costTracker: CostTracker | null = null;
  private memoryStore: MemoryStore | null = null;
  private hotCollector: HotCollector | null = null;
  private backgroundGardener: BackgroundGardener | null = null;
  private hybridSearch: HybridSearch | null = null;
  private contextManager: ContextManager | null = null;
  private mediaProcessor: MediaProcessor | null = null;
  private agent: Agent | null = null;
  private telegramChannel: TelegramChannel | null = null;

  private isInitialized = false;
  private isRunning = false;

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.logger = options.logger;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.logger.info('Initializing gateway...');

    // Initialize provider registry
    this.providerRegistry = new ProviderRegistry();
    this.initializeProviders();

    // Initialize router with providers
    this.router = new Router({});
    this.registerProvidersWithRouter();

    // Initialize cost tracker
    this.costTracker = new CostTracker({
      dailyBudget: this.config.cost.dailyBudget,
      monthlyBudget: this.config.cost.monthlyBudget,
      warningThreshold: this.config.cost.warningThreshold,
    });
    this.logger.debug('Cost tracker initialized');

    // Initialize memory system with persistence
    const memoryFilePath = this.config.memory.persist
      ? path.join(this.config.agent.workspace, this.config.memory.filePath)
      : undefined;
    this.memoryStore = new MemoryStore({ filePath: memoryFilePath });
    if (memoryFilePath) {
      await this.memoryStore.load();
      this.logger.debug({ filePath: memoryFilePath, count: this.memoryStore.size() }, 'Memories loaded from disk');
    }
    this.hotCollector = new HotCollector({ store: this.memoryStore });
    this.hybridSearch = new HybridSearch({ store: this.memoryStore });
    this.backgroundGardener = new BackgroundGardener({
      store: this.memoryStore,
      logger: this.logger,
      interval: 60000, // 1 minute
    });
    this.logger.debug('Memory system initialized');

    // Initialize context manager
    this.contextManager = new ContextManager({
      hotWindowSize: this.config.context.hotWindowSize,
      maxContextTokens: this.config.context.maxContextTokens,
      compressionThreshold: this.config.context.compressionThreshold,
      maxToolOutputBytes: this.config.context.maxToolOutputBytes,
    });
    this.logger.debug('Context manager initialized');

    // Initialize media processor for link/image/PDF understanding
    this.mediaProcessor = new MediaProcessor({}, this.logger);
    const mediaStatus = await this.mediaProcessor.getStatus();
    this.logger.debug(
      { pdfParsing: mediaStatus.pdfParsing, imageProcessing: mediaStatus.imageProcessing },
      'Media processor initialized'
    );

    // Initialize skill registry
    this.skillRegistry = createSkillRegistry(this.config.agent.workspace, this.logger);
    await this.skillRegistry.initialize();
    this.logger.debug(
      { skills: this.skillRegistry.getAvailableSkills().map((s) => s.name) },
      'Skills loaded'
    );

    // Initialize tool registry with skills and memory
    this.toolRegistry = await createDefaultToolRegistry({
      skillRegistry: this.skillRegistry,
      memoryStore: this.memoryStore,
      hybridSearch: this.hybridSearch,
    });
    this.logger.debug({ tools: this.toolRegistry.getAllTools().map((t) => t.name) }, 'Tools registered');

    // Initialize session manager
    const sessionsDir = path.join(this.config.agent.workspace, 'sessions');
    this.sessionManager = new SessionManager(sessionsDir);
    this.logger.debug({ sessionsDir }, 'Session manager initialized');

    // Initialize agent
    const provider = this.providerRegistry.getDefaultProvider();
    if (!provider) {
      throw new Error('No LLM provider available. Please configure at least one provider.');
    }

    this.agent = new Agent({
      provider,
      sessionManager: this.sessionManager,
      toolRegistry: this.toolRegistry,
      skillRegistry: this.skillRegistry,
      router: this.router,
      costTracker: this.costTracker,
      hotCollector: this.hotCollector,
      contextManager: this.contextManager,
      mediaProcessor: this.mediaProcessor,
      workspace: this.config.agent.workspace,
      logger: this.logger,
      maxIterations: this.config.agent.maxIterations,
    });
    this.logger.debug('Agent initialized');

    this.isInitialized = true;
    this.logger.info('Gateway initialized successfully');
  }

  private initializeProviders(): void {
    if (!this.providerRegistry) return;

    // Initialize Anthropic provider
    const anthropicConfig = this.config.providers.anthropic;
    if (anthropicConfig.apiKey) {
      const anthropic = new AnthropicProvider({
        apiKey: anthropicConfig.apiKey,
        model: anthropicConfig.model,
      });
      this.providerRegistry.registerProvider(anthropic);
      this.logger.debug({ provider: 'anthropic', model: anthropicConfig.model }, 'Provider registered');
    }
  }

  private registerProvidersWithRouter(): void {
    if (!this.router || !this.providerRegistry) return;

    // Register all available providers with the router for smart routing
    for (const provider of this.providerRegistry.getAvailableProviders()) {
      this.router.registerProvider(provider);
      this.logger.debug({ provider: provider.name }, 'Provider registered with router');
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!this.isInitialized) {
      await this.initialize();
    }

    this.logger.info('Starting gateway...');

    // Start background gardener for memory maintenance
    if (this.backgroundGardener) {
      this.backgroundGardener.start();
    }

    // Start Telegram channel if enabled
    if (this.config.channels.telegram.enabled && this.config.channels.telegram.botToken) {
      this.telegramChannel = new TelegramChannel({
        botToken: this.config.channels.telegram.botToken,
        agent: this.agent!,
        sessionManager: this.sessionManager!,
        logger: this.logger,
      });
      await this.telegramChannel.start();
    }

    this.isRunning = true;
    this.logger.info('Gateway started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping gateway...');

    // Stop background gardener
    if (this.backgroundGardener) {
      this.backgroundGardener.stop();
    }

    // Stop Telegram channel
    if (this.telegramChannel) {
      await this.telegramChannel.stop();
      this.telegramChannel = null;
    }

    this.isRunning = false;
    this.logger.info('Gateway stopped');
  }

  getProvider(): LLMProvider | undefined {
    return this.providerRegistry?.getDefaultProvider();
  }

  getToolRegistry(): ToolRegistry {
    if (!this.toolRegistry) {
      throw new Error('Gateway not initialized');
    }
    return this.toolRegistry;
  }

  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error('Gateway not initialized');
    }
    return this.sessionManager;
  }

  getAgent(): Agent {
    if (!this.agent) {
      throw new Error('Gateway not initialized');
    }
    return this.agent;
  }

  getSkillRegistry(): SkillRegistry {
    if (!this.skillRegistry) {
      throw new Error('Gateway not initialized');
    }
    return this.skillRegistry;
  }

  getMediaProcessor(): MediaProcessor {
    if (!this.mediaProcessor) {
      throw new Error('Gateway not initialized');
    }
    return this.mediaProcessor;
  }

  isGatewayRunning(): boolean {
    return this.isRunning;
  }
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupGracefulShutdown(gateway: Gateway, logger: Logger): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    try {
      await gateway.stop();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
