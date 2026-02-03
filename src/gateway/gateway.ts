import * as path from 'path';
import type { Logger } from 'pino';
import type { Config } from '../config/config.js';
import {
  AnthropicProvider,
  OpenAIProvider,
  GroqProvider,
  OllamaProvider,
  OpenRouterProvider,
  MoonshotProvider,
  XAIProvider,
  ProviderRegistry,
  type LLMProvider,
} from '../providers/index.js';
import { createDefaultToolRegistry, type ToolRegistry, type Reminder } from '../tools/index.js';
import { SessionManager } from '../agent/session.js';
import { Agent } from '../agent/agent.js';
import { TelegramChannel } from '../channels/telegram.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/registry.js';
import { Router } from '../routing/router.js';
import { CostTracker } from '../routing/cost.js';
import { MemoryStore, HotCollector, BackgroundGardener, HybridSearch, OllamaEmbedder, LLMFactExtractor, type EmbeddingProvider } from '../memory/index.js';
import { ContextManager } from '../routing/context.js';
import { MediaProcessor } from '../media/index.js';
import { VoiceManager } from '../voice/index.js';

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
  private factExtractor: LLMFactExtractor | null = null;
  private contextManager: ContextManager | null = null;
  private mediaProcessor: MediaProcessor | null = null;
  private voiceManager: VoiceManager | null = null;
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

    // Use OllamaEmbedder for semantic search if Ollama is configured
    let embedder: EmbeddingProvider | undefined;
    const ollamaConfig = this.config.providers.ollama;
    if (ollamaConfig.baseUrl) {
      embedder = new OllamaEmbedder({
        baseUrl: ollamaConfig.baseUrl,
        model: 'nomic-embed-text',  // Use nomic-embed-text for embeddings
      });
      this.logger.debug({ model: 'nomic-embed-text', baseUrl: ollamaConfig.baseUrl }, 'Using Ollama for semantic embeddings');
    }

    this.hybridSearch = new HybridSearch({
      store: this.memoryStore,
      embedder,  // Uses TFIDFEmbedder as fallback if undefined
    });
    this.backgroundGardener = new BackgroundGardener({
      store: this.memoryStore,
      logger: this.logger,
      interval: 60000, // 1 minute
    });

    // Initialize LLM-based fact extractor
    // Use a chat-capable provider (not Ollama which may only have embedding models)
    // This runs asynchronously and doesn't block the main conversation
    const availableProviders = this.providerRegistry.getAvailableProviders();
    const factExtractionProvider = availableProviders.find(p => p.name !== 'ollama')
      || this.providerRegistry.getDefaultProvider();

    if (factExtractionProvider && this.memoryStore && this.hybridSearch) {
      this.factExtractor = new LLMFactExtractor({
        provider: factExtractionProvider,
        memoryStore: this.memoryStore,
        hybridSearch: this.hybridSearch,
        logger: this.logger,
        embedder,
        deduplicationThreshold: 0.85,
        enableFactUpdates: true,
      });
      this.logger.debug({ provider: factExtractionProvider.name }, 'LLM fact extractor initialized');
    }

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

    // Initialize voice manager (for voice reply tool)
    this.voiceManager = VoiceManager.fromEnv(this.logger);
    const voiceStatus = await this.voiceManager.isAvailable();
    this.logger.debug(
      { stt: voiceStatus.stt, tts: voiceStatus.tts },
      'Voice manager initialized'
    );

    // Initialize tool registry with skills, memory, voice, reminders, and file sending
    this.toolRegistry = await createDefaultToolRegistry({
      skillRegistry: this.skillRegistry,
      memoryStore: this.memoryStore,
      hybridSearch: this.hybridSearch,
      voiceManager: voiceStatus.tts ? this.voiceManager : undefined, // Only add voice tool if TTS available
      reminderCallback: async (reminder: Reminder) => {
        await this.handleReminderTrigger(reminder);
      },
      fileSendCallback: async (userId: string, filePath: string, caption?: string) => {
        return this.handleFileSend(userId, filePath, caption);
      },
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
      hybridSearch: this.hybridSearch || undefined,
      factExtractor: this.factExtractor || undefined,
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

    // Initialize OpenAI provider
    const openaiConfig = this.config.providers.openai;
    if (openaiConfig.apiKey) {
      const openai = new OpenAIProvider({
        apiKey: openaiConfig.apiKey,
        model: openaiConfig.model,
      });
      this.providerRegistry.registerProvider(openai);
      this.logger.debug({ provider: 'openai', model: openaiConfig.model }, 'Provider registered');
    }

    // Initialize Groq provider
    const groqConfig = this.config.providers.groq;
    if (groqConfig.apiKey) {
      const groq = new GroqProvider({
        apiKey: groqConfig.apiKey,
        model: groqConfig.model,
      });
      this.providerRegistry.registerProvider(groq);
      this.logger.debug({ provider: 'groq', model: groqConfig.model }, 'Provider registered');
    }

    // Initialize Ollama provider (no API key needed, just check if configured)
    const ollamaConfig = this.config.providers.ollama;
    if (ollamaConfig.baseUrl) {
      const ollama = new OllamaProvider({
        baseUrl: ollamaConfig.baseUrl,
        model: ollamaConfig.model,
      });
      this.providerRegistry.registerProvider(ollama);
      this.logger.debug({ provider: 'ollama', model: ollamaConfig.model }, 'Provider registered');
    }

    // Initialize OpenRouter provider
    const openrouterConfig = this.config.providers.openrouter;
    if (openrouterConfig.apiKey) {
      const openrouter = new OpenRouterProvider({
        apiKey: openrouterConfig.apiKey,
        model: openrouterConfig.model,
      });
      this.providerRegistry.registerProvider(openrouter);
      this.logger.debug({ provider: 'openrouter', model: openrouterConfig.model }, 'Provider registered');
    }

    // Initialize Moonshot (Kimi) provider
    const moonshotConfig = this.config.providers.moonshot;
    if (moonshotConfig.apiKey) {
      const moonshot = new MoonshotProvider({
        apiKey: moonshotConfig.apiKey,
        model: moonshotConfig.model,
      });
      this.providerRegistry.registerProvider(moonshot);
      this.logger.debug({ provider: 'moonshot', model: moonshotConfig.model }, 'Provider registered');
    }

    // Initialize xAI (Grok) provider
    const xaiConfig = this.config.providers.xai;
    if (xaiConfig.apiKey) {
      const xai = new XAIProvider({
        apiKey: xaiConfig.apiKey,
        model: xaiConfig.model,
      });
      this.providerRegistry.registerProvider(xai);
      this.logger.debug({ provider: 'xai', model: xaiConfig.model }, 'Provider registered');
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
        workspacePath: this.config.agent.workspace,
        allowedUsers: this.config.channels.telegram.allowedUsers,
        enableVoiceReply: this.config.channels.telegram.enableVoiceReply,
        voiceManager: this.voiceManager || undefined, // Share voice manager
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

  /**
   * Handle a triggered reminder by executing it through the agent
   * If the reminder contains an action (like "check the weather"), the agent will perform it
   */
  private async handleReminderTrigger(reminder: Reminder): Promise<void> {
    this.logger.info({ reminderId: reminder.id, userId: reminder.userId, message: reminder.message }, 'Reminder triggered');

    if (!this.telegramChannel) {
      this.logger.warn({ reminderId: reminder.id }, 'No channel available to send reminder');
      return;
    }

    // Check if this is an actionable reminder (contains action words)
    const actionKeywords = ['check', 'get', 'find', 'search', 'look up', 'tell me', 'show', 'fetch', 'run', 'execute', 'do'];
    const isActionable = actionKeywords.some(keyword =>
      reminder.message.toLowerCase().includes(keyword)
    );

    if (isActionable && this.agent) {
      // Run the reminder message through the agent to execute the action
      this.logger.info({ reminderId: reminder.id }, 'Executing actionable reminder through agent');

      try {
        // Process through agent using the existing session
        const result = await this.agent.processMessage(
          reminder.sessionId,
          `[SCHEDULED REMINDER - Execute this task now]: ${reminder.message}`,
          undefined,
          async (update) => {
            // Send progress updates to user
            if (update.type === 'thinking' && update.message) {
              await this.telegramChannel!.sendMessage(reminder.userId, update.message);
            }
          }
        );

        // Send the agent's response
        if (result.response) {
          await this.telegramChannel.sendMessage(reminder.userId, result.response);
        }

        this.logger.debug({ reminderId: reminder.id }, 'Actionable reminder executed');
      } catch (error) {
        this.logger.error({ reminderId: reminder.id, error: (error as Error).message }, 'Failed to execute actionable reminder');
        // Fallback to simple reminder
        await this.telegramChannel.sendMessage(reminder.userId, `**Reminder!**\n\n${reminder.message}`);
      }
    } else {
      // Simple reminder - just send the message
      await this.telegramChannel.sendMessage(reminder.userId, `**Reminder!**\n\n${reminder.message}`);
      this.logger.debug({ reminderId: reminder.id }, 'Simple reminder sent');
    }
  }

  /**
   * Handle sending a file to a user
   */
  private async handleFileSend(userId: string, filePath: string, caption?: string): Promise<boolean> {
    this.logger.info({ userId, filePath }, 'Sending file to user');

    if (this.telegramChannel) {
      return await this.telegramChannel.sendFile(userId, filePath, caption);
    }

    this.logger.warn({ userId, filePath }, 'No channel available to send file');
    return false;
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
