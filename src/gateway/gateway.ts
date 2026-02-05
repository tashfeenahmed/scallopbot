import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
import { TelegramGateway } from '../channels/telegram-gateway.js';
import { ApiChannel } from '../channels/api.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/registry.js';
import { createSkillExecutor, type SkillExecutor } from '../skills/executor.js';
import { Router } from '../routing/router.js';
import { CostTracker } from '../routing/cost.js';
import {
  MemoryStore,
  HotCollector,
  BackgroundGardener,
  HybridSearch,
  OllamaEmbedder,
  LLMFactExtractor,
  ScallopMemoryStore,
  type EmbeddingProvider,
} from '../memory/index.js';
import { ContextManager } from '../routing/context.js';
import { MediaProcessor } from '../media/index.js';
import { VoiceManager } from '../voice/index.js';
import { type TriggerSource, type TriggerSourceRegistry, parseUserIdPrefix } from '../triggers/index.js';

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
  private skillExecutor: SkillExecutor | null = null;
  private router: Router | null = null;
  private costTracker: CostTracker | null = null;
  private memoryStore: MemoryStore | null = null;
  private scallopMemoryStore: ScallopMemoryStore | null = null;
  private hotCollector: HotCollector | null = null;
  private backgroundGardener: BackgroundGardener | null = null;
  private hybridSearch: HybridSearch | null = null;
  private factExtractor: LLMFactExtractor | null = null;
  private contextManager: ContextManager | null = null;
  private mediaProcessor: MediaProcessor | null = null;
  private voiceManager: VoiceManager | null = null;
  private agent: Agent | null = null;
  private telegramChannel: TelegramChannel | null = null;
  private apiChannel: ApiChannel | null = null;
  private reminderMonitorInterval: ReturnType<typeof setInterval> | null = null;

  /** Registry of active trigger sources for multi-channel message dispatch */
  private triggerSources: TriggerSourceRegistry = new Map();

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

    // Initialize memory system — ScallopMemory (SQLite) is always the primary backend
    const dbPath = path.join(this.config.agent.workspace, this.config.memory.dbPath);
    this.scallopMemoryStore = new ScallopMemoryStore({
      dbPath,
      logger: this.logger,
      embedder,
    });
    this.logger.info({ dbPath, count: this.scallopMemoryStore.getCount() }, 'ScallopMemory initialized');

    // Legacy MemoryStore/HybridSearch kept for backward compat (HotCollector, fact extractor dedup)
    const memoryFilePath = this.config.memory.persist
      ? path.join(this.config.agent.workspace, this.config.memory.filePath)
      : undefined;
    this.memoryStore = new MemoryStore({ filePath: memoryFilePath });
    if (memoryFilePath) {
      await this.memoryStore.load();
    }
    this.hotCollector = new HotCollector({ store: this.memoryStore, scallopStore: this.scallopMemoryStore });

    this.hybridSearch = new HybridSearch({
      store: this.memoryStore,
      embedder,
    });

    // Background gardener processes ScallopMemory decay
    this.backgroundGardener = new BackgroundGardener({
      store: this.memoryStore,
      logger: this.logger,
      interval: 60000, // 1 minute
      scallopStore: this.scallopMemoryStore,
    });

    // Auto-migrate: if JSONL exists and SQLite is empty, migrate
    if (memoryFilePath && this.memoryStore.size() > 0 && this.scallopMemoryStore.getCount() === 0) {
      this.logger.info({ jsonlCount: this.memoryStore.size() }, 'Migrating JSONL memories to SQLite...');
      try {
        const { migrateJsonlToSqlite } = await import('../memory/migrate.js');
        const result = await migrateJsonlToSqlite({
          jsonlPath: memoryFilePath,
          dbPath,
        });
        this.logger.info(
          { migrated: result.memoriesImported, skipped: result.memoriesSkipped, errors: result.errors },
          'JSONL → SQLite migration complete'
        );
      } catch (err) {
        this.logger.error({ error: (err as Error).message }, 'JSONL → SQLite migration failed');
      }
    }

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
        deduplicationThreshold: 0.95, // Higher threshold - only skip true duplicates
        scallopStore: this.scallopMemoryStore ?? undefined,
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

    // Create skill executor for skill-based execution
    this.skillExecutor = createSkillExecutor(this.logger);
    this.logger.debug('Skill executor created');

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
      scallopStore: this.scallopMemoryStore ?? undefined,
      voiceManager: voiceStatus.tts ? this.voiceManager : undefined, // Only add voice tool if TTS available
      reminderCallback: async (reminder: Reminder) => {
        await this.handleReminderTrigger(reminder);
      },
      fileSendCallback: async (userId: string, filePath: string, caption?: string) => {
        return this.handleFileSend(userId, filePath, caption);
      },
      messageSendCallback: async (userId: string, message: string) => {
        return this.handleMessageSend(userId, message);
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
      skillRegistry: this.skillRegistry,
      skillExecutor: this.skillExecutor,
      toolRegistry: this.toolRegistry,
      router: this.router,
      costTracker: this.costTracker,
      hotCollector: this.hotCollector,
      hybridSearch: this.hybridSearch || undefined,
      scallopStore: this.scallopMemoryStore || undefined,
      factExtractor: this.factExtractor || undefined,
      contextManager: this.contextManager,
      mediaProcessor: this.mediaProcessor,
      workspace: this.config.agent.workspace,
      logger: this.logger,
      maxIterations: this.config.agent.maxIterations,
      enableThinking: this.config.providers.moonshot.enableThinking,
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

    // Start reminder file monitor (checks reminders.json every 30 seconds)
    this.startReminderMonitor();

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

      // Wire singleton for skill access
      TelegramGateway.getInstance().setChannel(this.telegramChannel);

      // Register as trigger source
      this.registerTelegramTriggerSource(this.telegramChannel);
    }

    // Start API channel if enabled (web UI)
    if (this.config.channels.api.enabled) {
      this.apiChannel = new ApiChannel({
        port: this.config.channels.api.port,
        host: this.config.channels.api.host,
        apiKey: this.config.channels.api.apiKey,
        staticDir: path.join(process.cwd(), 'public'),
        agent: this.agent!,
        sessionManager: this.sessionManager!,
        logger: this.logger,
      });
      await this.apiChannel.start();

      // Register as trigger source if it implements TriggerSource
      if (this.isApiChannelTriggerSource(this.apiChannel)) {
        this.triggerSources.set('api', this.apiChannel);
        this.logger.debug('Registered api trigger source');
      }
    }

    this.isRunning = true;
    this.logger.info('Gateway started');
  }

  /**
   * Type guard to check if ApiChannel implements TriggerSource.
   * ApiChannel gains TriggerSource support in Task 2.
   */
  private isApiChannelTriggerSource(channel: ApiChannel): channel is ApiChannel & TriggerSource {
    return (
      typeof (channel as unknown as TriggerSource).sendMessage === 'function' &&
      typeof (channel as unknown as TriggerSource).sendFile === 'function' &&
      typeof (channel as unknown as TriggerSource).getName === 'function'
    );
  }

  /**
   * Register TelegramChannel as a trigger source.
   * Creates a TriggerSource wrapper that adapts the TelegramChannel API.
   */
  private registerTelegramTriggerSource(channel: TelegramChannel): void {
    const triggerSource: TriggerSource = {
      sendMessage: async (userId: string, message: string): Promise<boolean> => {
        try {
          await channel.sendMessage(userId, message);
          return true;
        } catch (error) {
          this.logger.error({ userId, error: (error as Error).message }, 'Telegram trigger sendMessage failed');
          return false;
        }
      },
      sendFile: async (userId: string, filePath: string, caption?: string): Promise<boolean> => {
        return channel.sendFile(userId, filePath, caption);
      },
      getName: () => 'telegram',
    };

    this.triggerSources.set('telegram', triggerSource);
    this.logger.debug('Registered telegram trigger source');
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

    // Stop reminder monitor
    if (this.reminderMonitorInterval) {
      clearInterval(this.reminderMonitorInterval);
      this.reminderMonitorInterval = null;
    }

    // Clear trigger sources before stopping channels
    this.triggerSources.clear();

    // Stop API channel
    if (this.apiChannel) {
      await this.apiChannel.stop();
      this.apiChannel = null;
    }

    // Stop Telegram channel
    if (this.telegramChannel) {
      await this.telegramChannel.stop();
      this.telegramChannel = null;
      TelegramGateway.resetInstance();
    }

    // Close ScallopMemoryStore (SQLite database)
    if (this.scallopMemoryStore) {
      this.scallopMemoryStore.close();
      this.scallopMemoryStore = null;
    }

    this.isRunning = false;
    this.logger.info('Gateway stopped');
  }

  getProvider(): LLMProvider | undefined {
    return this.providerRegistry?.getDefaultProvider();
  }

  /**
   * Get the internal tool registry (used for reminders and file send callbacks, not for Agent)
   */
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
   * Resolve which trigger source to use for a given userId.
   * Supports prefixed userIds (e.g., "telegram:12345", "api:ws-abc123").
   * Falls back to first available trigger source if no prefix or unknown channel.
   */
  private resolveTriggerSource(userId: string): { source: TriggerSource | null; rawUserId: string } {
    const { channel, rawUserId } = parseUserIdPrefix(userId);

    // If a specific channel is requested, try to use it
    if (channel) {
      const source = this.triggerSources.get(channel);
      if (source) {
        this.logger.debug({ channel, userId: rawUserId }, 'Using prefixed trigger source');
        return { source, rawUserId };
      }
      this.logger.warn({ channel, userId: rawUserId }, 'Requested trigger source not available, falling back');
    }

    // Fall back to first available trigger source (prefer telegram for backward compat)
    const telegram = this.triggerSources.get('telegram');
    if (telegram) {
      return { source: telegram, rawUserId };
    }

    const api = this.triggerSources.get('api');
    if (api) {
      return { source: api, rawUserId };
    }

    // No trigger sources available
    return { source: null, rawUserId };
  }

  /**
   * Handle a triggered reminder by executing it through the agent
   * If the reminder contains an action (like "check the weather"), the agent will perform it
   */
  private async handleReminderTrigger(reminder: Reminder): Promise<void> {
    this.logger.info({ reminderId: reminder.id, userId: reminder.userId, message: reminder.message }, 'Reminder triggered');

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(reminder.userId);

    if (!triggerSource) {
      this.logger.warn({ reminderId: reminder.id }, 'No trigger source available to send reminder');
      return;
    }

    this.logger.debug({ reminderId: reminder.id, triggerSource: triggerSource.getName() }, 'Using trigger source for reminder');

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
              await triggerSource.sendMessage(rawUserId, update.message);
            }
          }
        );

        // Send the agent's response
        if (result.response) {
          await triggerSource.sendMessage(rawUserId, result.response);
        }

        this.logger.debug({ reminderId: reminder.id }, 'Actionable reminder executed');
      } catch (error) {
        this.logger.error({ reminderId: reminder.id, error: (error as Error).message }, 'Failed to execute actionable reminder');
        // Fallback to simple reminder
        await triggerSource.sendMessage(rawUserId, `**Reminder!**\n\n${reminder.message}`);
      }
    } else {
      // Simple reminder - just send the message
      await triggerSource.sendMessage(rawUserId, `**Reminder!**\n\n${reminder.message}`);
      this.logger.debug({ reminderId: reminder.id }, 'Simple reminder sent');
    }
  }

  /**
   * Handle sending a file to a user
   * Uses trigger source abstraction for multi-channel support
   */
  private async handleFileSend(userId: string, filePath: string, caption?: string): Promise<boolean> {
    this.logger.info({ userId, filePath }, 'Sending file to user');

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(userId);

    if (triggerSource) {
      this.logger.debug({ triggerSource: triggerSource.getName(), userId: rawUserId }, 'Using trigger source for file send');
      return await triggerSource.sendFile(rawUserId, filePath, caption);
    }

    this.logger.warn({ userId, filePath }, 'No trigger source available to send file');
    return false;
  }

  /**
   * Handle sending a message to a user immediately
   * This allows the agent to send multiple messages during its execution loop
   * Uses trigger source abstraction for multi-channel support
   */
  private async handleMessageSend(userId: string, message: string): Promise<boolean> {
    this.logger.debug({ userId, messageLength: message.length }, 'Sending message to user');

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(userId);

    if (triggerSource) {
      this.logger.debug({ triggerSource: triggerSource.getName(), userId: rawUserId }, 'Using trigger source for message send');
      return await triggerSource.sendMessage(rawUserId, message);
    }

    this.logger.warn({ userId }, 'No trigger source available to send message');
    return false;
  }

  /**
   * Start the reminder file monitor.
   * Polls ~/.scallopbot/reminders.json every 30 seconds for due reminders.
   */
  private startReminderMonitor(): void {
    // Check immediately on start
    this.checkFileReminders().catch(err => {
      this.logger.error({ error: (err as Error).message }, 'Error in initial reminder check');
    });

    // Then check every 30 seconds
    this.reminderMonitorInterval = setInterval(() => {
      this.checkFileReminders().catch(err => {
        this.logger.error({ error: (err as Error).message }, 'Error in reminder check');
      });
    }, 30000);

    this.logger.debug('Reminder file monitor started (30s interval)');
  }

  /**
   * Check for due reminders in the reminders.json file and trigger them.
   * Removes one-time reminders after triggering, reschedules recurring ones.
   */
  private async checkFileReminders(): Promise<void> {
    const remindersPath = path.join(os.homedir(), '.scallopbot', 'reminders.json');

    // Check if file exists
    if (!fs.existsSync(remindersPath)) {
      return;
    }

    let reminders: FileReminder[];
    try {
      const data = fs.readFileSync(remindersPath, 'utf-8');
      reminders = JSON.parse(data);
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'Failed to read reminders file');
      return;
    }

    if (!Array.isArray(reminders) || reminders.length === 0) {
      return;
    }

    const now = Date.now();
    const dueReminders: FileReminder[] = [];
    const remainingReminders: FileReminder[] = [];

    for (const reminder of reminders) {
      const triggerTime = new Date(reminder.triggerAt).getTime();

      if (triggerTime <= now) {
        dueReminders.push(reminder);
      } else {
        remainingReminders.push(reminder);
      }
    }

    if (dueReminders.length === 0) {
      return;
    }

    this.logger.info({ count: dueReminders.length }, 'Found due reminders');

    // Process due reminders
    for (const fileReminder of dueReminders) {
      // Convert to the Reminder type expected by handleReminderTrigger
      const reminder: Reminder = {
        id: fileReminder.id,
        userId: fileReminder.userId,
        sessionId: fileReminder.sessionId,
        message: fileReminder.message,
        triggerAt: new Date(fileReminder.triggerAt),
        createdAt: new Date(fileReminder.createdAt),
      };

      try {
        await this.handleReminderTrigger(reminder);
      } catch (err) {
        this.logger.error(
          { reminderId: reminder.id, error: (err as Error).message },
          'Failed to trigger reminder'
        );
      }

      // If recurring, calculate next occurrence and add back
      if (fileReminder.recurring) {
        const nextOccurrence = this.getNextRecurringOccurrence(fileReminder.recurring);
        if (nextOccurrence) {
          remainingReminders.push({
            ...fileReminder,
            triggerAt: nextOccurrence.toISOString(),
          });
          this.logger.debug(
            { reminderId: fileReminder.id, nextTrigger: nextOccurrence.toISOString() },
            'Rescheduled recurring reminder'
          );
        }
      }
    }

    // Write back the remaining reminders
    try {
      fs.writeFileSync(remindersPath, JSON.stringify(remainingReminders, null, 2));
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Failed to update reminders file');
    }
  }

  /**
   * Calculate the next occurrence for a recurring reminder schedule.
   */
  private getNextRecurringOccurrence(schedule: RecurringSchedule): Date | null {
    const now = new Date();
    const target = new Date();
    target.setHours(schedule.time.hour, schedule.time.minute, 0, 0);

    switch (schedule.type) {
      case 'daily':
        // Move to tomorrow at the scheduled time
        target.setDate(target.getDate() + 1);
        break;

      case 'weekly':
        if (schedule.dayOfWeek !== undefined) {
          // Find next occurrence of the day
          const currentDay = now.getDay();
          let daysUntil = schedule.dayOfWeek - currentDay;
          if (daysUntil <= 0) {
            daysUntil += 7;
          }
          target.setDate(target.getDate() + daysUntil);
        }
        break;

      case 'weekdays':
        // Move to next weekday
        target.setDate(target.getDate() + 1);
        while (target.getDay() === 0 || target.getDay() === 6) {
          target.setDate(target.getDate() + 1);
        }
        break;

      case 'weekends':
        // Move to next weekend day
        target.setDate(target.getDate() + 1);
        while (target.getDay() !== 0 && target.getDay() !== 6) {
          target.setDate(target.getDate() + 1);
        }
        break;

      default:
        return null;
    }

    return target;
  }
}

/**
 * Reminder stored in the file (from reminder skill)
 */
interface FileReminder {
  id: string;
  message: string;
  triggerAt: string; // ISO date string
  userId: string;
  sessionId: string;
  createdAt: string;
  recurring?: RecurringSchedule;
}

/**
 * Recurring schedule for reminders
 */
interface RecurringSchedule {
  type: 'daily' | 'weekly' | 'weekdays' | 'weekends';
  time: { hour: number; minute: number };
  dayOfWeek?: number;
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
