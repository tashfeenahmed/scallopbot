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
import { defineSkill } from '../skills/sdk.js';
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
  BackgroundGardener,
  OllamaEmbedder,
  LLMFactExtractor,
  ScallopMemoryStore,
  type EmbeddingProvider,
} from '../memory/index.js';
import { ContextManager } from '../routing/context.js';
import { MediaProcessor } from '../media/index.js';
import { VoiceManager } from '../voice/index.js';
import { type TriggerSource, type TriggerSourceRegistry, parseUserIdPrefix } from '../triggers/index.js';
import { UnifiedScheduler } from '../proactive/index.js';
import { BotConfigManager } from '../channels/bot-config.js';
import { GoalService } from '../goals/index.js';

export interface GatewayOptions {
  config: Config;
  logger: Logger;
}

export class Gateway {
  private config: Config;
  private logger: Logger;

  private providerRegistry: ProviderRegistry | null = null;
  private sessionManager: SessionManager | null = null;
  private skillRegistry: SkillRegistry | null = null;
  private skillExecutor: SkillExecutor | null = null;
  private router: Router | null = null;
  private costTracker: CostTracker | null = null;
  private scallopMemoryStore: ScallopMemoryStore | null = null;
  private backgroundGardener: BackgroundGardener | null = null;
  private factExtractor: LLMFactExtractor | null = null;
  private goalService: GoalService | null = null;
  private contextManager: ContextManager | null = null;
  private mediaProcessor: MediaProcessor | null = null;
  private voiceManager: VoiceManager | null = null;
  private configManager: BotConfigManager | null = null;
  private agent: Agent | null = null;
  private telegramChannel: TelegramChannel | null = null;
  private apiChannel: ApiChannel | null = null;
  private unifiedScheduler: UnifiedScheduler | null = null;

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

    // Get a fast-tier provider for LLM re-ranking of search results (opt-in, graceful degradation)
    let rerankProvider: LLMProvider | undefined;
    try {
      rerankProvider = await this.router.selectProvider('fast') ?? undefined;
      if (rerankProvider) {
        this.logger.debug({ provider: rerankProvider.name }, 'Using fast-tier provider for search re-ranking');
      }
    } catch {
      // No fast provider available — re-ranking will be skipped
    }

    this.scallopMemoryStore = new ScallopMemoryStore({
      dbPath,
      logger: this.logger,
      embedder,
      rerankProvider,
      relationsProvider: rerankProvider,
    });
    this.logger.info({ dbPath, count: this.scallopMemoryStore.getCount() }, 'ScallopMemory initialized');

    // Initialize cost tracker (with SQLite persistence)
    this.costTracker = new CostTracker({
      dailyBudget: this.config.cost.dailyBudget,
      monthlyBudget: this.config.cost.monthlyBudget,
      warningThreshold: this.config.cost.warningThreshold,
      db: this.scallopMemoryStore.getDatabase(),
    });
    this.logger.debug('Cost tracker initialized');

    // Initialize config manager early (needed by fact extractor and agent for timezone)
    this.configManager = new BotConfigManager(this.scallopMemoryStore.getDatabase(), this.logger);

    // Backfill default user profile from existing facts (one-time, idempotent)
    const backfillResult = this.scallopMemoryStore.backfillDefaultProfile();
    if (backfillResult.fieldsPopulated > 0) {
      this.logger.info({ fieldsPopulated: backfillResult.fieldsPopulated }, 'Default user profile backfilled');
    }

    // Goal service for hierarchical goal tracking
    this.goalService = new GoalService({
      db: this.scallopMemoryStore.getDatabase(),
      logger: this.logger,
    });
    this.logger.debug('Goal service initialized');

    // Background gardener processes ScallopMemory decay
    this.backgroundGardener = new BackgroundGardener({
      scallopStore: this.scallopMemoryStore,
      logger: this.logger,
      interval: 60000, // 1 minute
      fusionProvider: rerankProvider,
    });

    // Initialize LLM-based fact extractor
    // Use a chat-capable provider (not Ollama which may only have embedding models)
    // This runs asynchronously and doesn't block the main conversation
    const availableProviders = this.providerRegistry.getAvailableProviders();
    const factExtractionProvider = availableProviders.find(p => p.name !== 'ollama')
      || this.providerRegistry.getDefaultProvider();

    if (factExtractionProvider && this.scallopMemoryStore) {
      this.factExtractor = new LLMFactExtractor({
        provider: factExtractionProvider,
        scallopStore: this.scallopMemoryStore,
        logger: this.logger,
        embedder,
        costTracker: this.costTracker || undefined,
        deduplicationThreshold: 0.95, // Higher threshold - only skip true duplicates
        getTimezone: (userId: string) => this.configManager!.getUserTimezone(userId),
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
    this.skillExecutor = createSkillExecutor(
      this.logger,
      (userId: string) => this.configManager!.getUserTimezone(userId)
    );
    this.logger.debug('Skill executor created');

    // Initialize voice manager (for voice reply tool)
    this.voiceManager = VoiceManager.fromEnv(this.logger);
    const voiceStatus = await this.voiceManager.isAvailable();
    this.logger.debug(
      { stt: voiceStatus.stt, tts: voiceStatus.tts },
      'Voice manager initialized'
    );

    // Register native skills (comms + memory_get) that need runtime access
    this.registerNativeSkills(voiceStatus.tts);
    this.logger.debug(
      { nativeSkills: ['send_message', 'send_file', 'voice_reply', 'memory_get'].filter(n => this.skillRegistry!.hasSkill(n)) },
      'Native skills registered'
    );

    // Initialize session manager (uses SQLite)
    this.sessionManager = new SessionManager(this.scallopMemoryStore!.getDatabase());
    this.logger.debug('Session manager initialized (SQLite)');

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
      router: this.router,
      costTracker: this.costTracker,
      scallopStore: this.scallopMemoryStore || undefined,
      factExtractor: this.factExtractor || undefined,
      goalService: this.goalService || undefined,
      configManager: this.configManager || undefined,
      contextManager: this.contextManager,
      mediaProcessor: this.mediaProcessor,
      workspace: this.config.agent.workspace,
      logger: this.logger,
      maxIterations: this.config.agent.maxIterations,
      enableThinking: this.config.providers.moonshot.enableThinking,
    });
    this.logger.debug('Agent initialized');

    // Initialize unified scheduler (handles both user reminders and agent triggers)
    if (factExtractionProvider && this.scallopMemoryStore) {
      this.unifiedScheduler = new UnifiedScheduler({
        db: this.scallopMemoryStore.getDatabase(),
        memoryStore: this.scallopMemoryStore,
        provider: factExtractionProvider,
        logger: this.logger,
        costTracker: this.costTracker || undefined,
        goalService: this.goalService || undefined,
        interval: 30 * 1000, // Check every 30 seconds
        onSendMessage: async (userId: string, message: string) => {
          return this.handleProactiveMessage(userId, message);
        },
        onAgentProcess: async (userId: string, sessionId: string | null, message: string) => {
          return this.handleScheduledAgentProcess(userId, sessionId, message);
        },
        getTimezone: (userId: string) => this.configManager!.getUserTimezone(userId),
      });
      this.logger.debug('Unified scheduler initialized');
    }

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
        timeout: 60000,
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
        timeout: 60000,
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
        timeout: 60000,
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
        timeout: 60000, // 60 second timeout
      }, this.logger);
      this.providerRegistry.registerProvider(moonshot);
      this.logger.debug({ provider: 'moonshot', model: moonshotConfig.model }, 'Provider registered');
    }

    // Initialize xAI (Grok) provider
    const xaiConfig = this.config.providers.xai;
    if (xaiConfig.apiKey) {
      const xai = new XAIProvider({
        apiKey: xaiConfig.apiKey,
        model: xaiConfig.model,
        timeout: 60000,
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
        db: this.scallopMemoryStore!.getDatabase(),
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
        costTracker: this.costTracker || undefined,
        memoryStore: this.scallopMemoryStore || undefined,
      });
      await this.apiChannel.start();

      // Register as trigger source if it implements TriggerSource
      if (this.isApiChannelTriggerSource(this.apiChannel)) {
        this.triggerSources.set('api', this.apiChannel);
        this.logger.debug('Registered api trigger source');
      }
    }

    // Start unified scheduler (after trigger sources are registered)
    if (this.unifiedScheduler) {
      this.unifiedScheduler.start();
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

    // Stop unified scheduler
    if (this.unifiedScheduler) {
      this.unifiedScheduler.stop();
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
   * Register native skills that need runtime access (channels, memory, voice).
   * These run in-process via handlers instead of as subprocesses.
   */
  private registerNativeSkills(ttsAvailable: boolean): void {
    if (!this.skillRegistry) return;

    // send_message skill
    const sendMessageSkill = defineSkill('send_message', 'Send a text message to the user immediately. Use this for conversational, human-like messaging.')
      .userInvocable(false)
      .inputSchema({
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message text to send. Keep it short and conversational, like a text message.' },
        },
        required: ['message'],
      })
      .onNativeExecute(async (ctx) => {
        const message = ctx.args.message as string;
        if (!message || message.trim().length === 0) {
          return { success: false, output: 'Missing required parameter: message' };
        }
        if (!ctx.userId) {
          return { success: false, output: 'Cannot send message - user ID not available' };
        }
        const ok = await this.handleMessageSend(ctx.userId, message.trim());
        return ok
          ? { success: true, output: 'Message sent' }
          : { success: false, output: 'Failed to send message - check logs for details' };
      })
      .build();
    this.skillRegistry.registerSkill(sendMessageSkill.skill);

    // send_file skill
    const sendFileSkill = defineSkill('send_file', 'Send a file to the user via chat. Use this to send PDFs, images, documents, or any file the user requests.')
      .userInvocable(false)
      .inputSchema({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to send' },
          caption: { type: 'string', description: 'Optional caption/message to accompany the file' },
        },
        required: ['file_path'],
      })
      .onNativeExecute(async (ctx) => {
        const filePath = ctx.args.file_path as string;
        const caption = ctx.args.caption as string | undefined;
        if (!filePath) {
          return { success: false, output: 'Missing required parameter: file_path' };
        }
        if (!ctx.userId) {
          return { success: false, output: 'Cannot send file - user ID not available' };
        }

        const fsMod = await import('fs/promises');
        const pathMod = await import('path');
        const absolutePath = pathMod.isAbsolute(filePath) ? filePath : pathMod.join(ctx.workspace, filePath);

        try {
          await fsMod.access(absolutePath);
        } catch {
          return { success: false, output: `File not found: ${absolutePath}` };
        }

        const stats = await fsMod.stat(absolutePath);
        if (!stats.isFile()) {
          return { success: false, output: `Not a file: ${absolutePath}` };
        }
        const maxSize = 50 * 1024 * 1024;
        if (stats.size > maxSize) {
          return { success: false, output: `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max 50MB)` };
        }

        const ok = await this.handleFileSend(ctx.userId, absolutePath, caption);
        if (ok) {
          const fileName = pathMod.basename(absolutePath);
          const sizeKB = (stats.size / 1024).toFixed(1);
          return { success: true, output: `File sent successfully: ${fileName} (${sizeKB}KB)` };
        }
        return { success: false, output: 'Failed to send file - check logs for details' };
      })
      .build();
    this.skillRegistry.registerSkill(sendFileSkill.skill);

    // voice_reply skill (only if TTS is available)
    if (ttsAvailable && this.voiceManager) {
      const voiceManager = this.voiceManager;
      const voiceSkill = defineSkill('voice_reply', 'Send a voice message to the user. Use this when the user asks for a voice note, audio response, or when voice would be more appropriate than text.')
        .userInvocable(false)
        .inputSchema({
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to speak in the voice message. Keep it concise (under 500 characters) for best results.' },
          },
          required: ['text'],
        })
        .onNativeExecute(async (ctx) => {
          const text = ctx.args.text as string;
          if (!text || text.trim().length === 0) {
            return { success: false, output: '', error: 'No text provided for voice synthesis' };
          }

          const maxLength = 1000;
          const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

          try {
            const status = await voiceManager.isAvailable();
            if (!status.tts) {
              return { success: false, output: '', error: 'Text-to-speech is not available.' };
            }

            const { join } = await import('path');
            const { tmpdir } = await import('os');
            const { writeFile } = await import('fs/promises');
            const { nanoid } = await import('nanoid');
            const { getPendingVoiceAttachments: getAttachments } = await import('../voice/attachments.js');

            const result = await voiceManager.synthesize(truncatedText, { voice: 'am_adam', format: 'opus' });
            const tempFile = join(tmpdir(), `voice-reply-${nanoid()}.ogg`);
            await writeFile(tempFile, result.audio);

            // Use the shared pending attachments map from voice.ts utilities
            const { addPendingVoiceAttachment } = await import('../voice/attachments.js');
            addPendingVoiceAttachment(ctx.sessionId, tempFile);

            return {
              success: true,
              output: `Voice message prepared (${Math.round(result.duration || 0)}s). It will be sent along with this response.`,
            };
          } catch (error) {
            return { success: false, output: '', error: `Failed to create voice message: ${(error as Error).message}` };
          }
        })
        .build();
      this.skillRegistry.registerSkill(voiceSkill.skill);
    }

    // memory_get skill (inlined — no tool dependency)
    const scallopStore = this.scallopMemoryStore;
    const logger = this.logger;
    const memoryGetSkill = defineSkill('memory_get', 'Retrieve specific memories by ID, session, type, or recency.')
      .userInvocable(false)
      .inputSchema({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Specific memory ID to retrieve' },
          sessionId: { type: 'string', description: 'Get all memories for this session' },
          type: { type: 'string', description: 'Filter by memory type: raw, fact, summary, preference, context' },
          recent: { type: 'number', description: 'Get N most recent memories (max: 100)' },
        },
        required: [],
      })
      .onNativeExecute(async (ctx) => {
        const id = ctx.args.id as string | undefined;
        const sessionId = ctx.args.sessionId as string | undefined;
        const type = ctx.args.type as string | undefined;
        const recent = ctx.args.recent as number | undefined;

        try {
          if (!scallopStore) {
            return { success: false, output: '', error: 'No memory store available' };
          }

          const mapCategory = (t?: string) => {
            if (!t) return undefined;
            const map: Record<string, string> = { fact: 'fact', preference: 'preference', context: 'event', summary: 'insight' };
            return map[t] as 'fact' | 'preference' | 'event' | 'insight' | undefined;
          };

          let entries: any[] = [];
          if (id) {
            const entry = scallopStore.get(id);
            if (!entry) return { success: false, output: '', error: `Memory not found with ID: ${id}` };
            entries = [entry];
          } else if (sessionId) {
            entries = scallopStore.getByUser(sessionId, { category: mapCategory(type), limit: 100 });
          } else if (recent) {
            entries = scallopStore.getByUser('', { category: mapCategory(type), limit: Math.min(recent, 100) });
          } else if (type) {
            entries = scallopStore.getByUser('', { category: mapCategory(type), limit: 50 });
          } else {
            entries = scallopStore.getByUser('', { limit: 10 });
          }

          logger.debug({ id, sessionId, type, recent, count: entries.length }, 'Memory get completed');

          if (entries.length === 0) return { success: true, output: 'No memories found matching the criteria.' };
          const format = (mem: any) => [
            `ID: ${mem.id}`, `Category: ${mem.category}`, `Content: ${mem.content}`,
            `Timestamp: ${new Date(mem.documentDate).toISOString()}`,
            `Prominence: ${mem.prominence.toFixed(2)}`,
            ...(mem.userId ? [`User: ${mem.userId}`] : []),
            ...(mem.metadata?.subject ? [`Subject: ${mem.metadata.subject}`] : []),
          ].join('\n');

          if (entries.length === 1) return { success: true, output: format(entries[0]) };
          const formatted = entries.map((e: any, i: number) => `--- Memory ${i + 1} ---\n${format(e)}`);
          return { success: true, output: `Found ${entries.length} memories:\n\n${formatted.join('\n\n')}` };
        } catch (error) {
          return { success: false, output: '', error: `Memory get failed: ${(error as Error).message}` };
        }
      })
      .build();
    this.skillRegistry.registerSkill(memoryGetSkill.skill);
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
   * Handle sending a proactive message to a user
   * Used by TriggerEvaluator for agent-initiated messages
   */
  private async handleProactiveMessage(userId: string, message: string): Promise<boolean> {
    this.logger.debug({ userId, messageLength: message.length }, 'Sending proactive message');

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(userId);

    if (!triggerSource) {
      this.logger.warn({ userId }, 'No trigger source available for proactive message');
      return false;
    }

    try {
      await triggerSource.sendMessage(rawUserId, message);
      return true;
    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  /**
   * Handle processing a scheduled item through the agent
   * Used for actionable reminders and triggers that may need the agent to perform tasks
   */
  private async handleScheduledAgentProcess(userId: string, sessionId: string | null, message: string): Promise<string | null> {
    if (!this.agent || !this.sessionManager) {
      return null;
    }

    this.logger.debug({ userId, sessionId }, 'Processing scheduled item through agent');

    try {
      // Use existing session if provided, otherwise create a new one
      let actualSessionId = sessionId;
      if (!actualSessionId) {
        const session = await this.sessionManager.createSession({ userId, source: 'scheduled' });
        actualSessionId = session.id;
      }

      // Process through the agent
      const result = await this.agent.processMessage(
        actualSessionId,
        message,
        undefined,
        async (_update) => {
          // Don't surface thinking to users for scheduled messages
        }
      );

      return result.response || null;
    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process scheduled item through agent');
      return null;
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
