import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';
import type { Config } from '../config/config.js';
import { PurposeRouter, DEFAULT_MODELS, type ModelPurpose } from '../config/model-routing.js';
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
import { registerSessionSearchTool } from '../context/session-search.js';
import { SessionManager } from '../agent/session.js';
import { Agent, type AgentHooks } from '../agent/agent.js';
import { initSecurityLayers } from '../security/startup.js';
import { vaultLoadResult } from '../config/config.js';
import { EvolutionRecorder } from '../evolution/signals.js';
import { EvolutionEngine } from '../evolution/engine.js';
import { createLoadProcedureSkill } from '../evolution/procedure-skill.js';
import { SkillStore } from '../evolution/skill-store.js';
import { LearningRuntime } from '../learning/index.js';
import { TelegramChannel } from '../channels/telegram.js';
import { TelegramGateway } from '../channels/telegram-gateway.js';
import { ApiChannel } from '../channels/api.js';
import type { ProactiveChatChannel } from '../channels/chat-support.js';
import { configuredChatChannels, startChatChannels } from './chat-channels.js';
import { createSkillRegistry, type SkillRegistry } from '../skills/registry.js';
import { createSkillExecutor, type SkillExecutor } from '../skills/executor.js';
import { Router, buildTierMapping } from '../routing/router.js';
import { CostTracker } from '../routing/cost.js';
import {
  BackgroundGardener,
  LLMFactExtractor,
  SessionSummarizer,
  ScallopMemoryStore,
  type EmbeddingProvider,
} from '../memory/index.js';
import { createConfiguredEmbedder } from '../memory/embedding-config.js';
import { ContextManager } from '../routing/context.js';
import { MediaProcessor } from '../media/index.js';
import { VoiceManager } from '../voice/index.js';
import {
  type MessageDeliveryResult,
  type TriggerSource,
  type TriggerSourceRegistry,
  isMessageDeliverySuppressed,
  messageWasDelivered,
  parseUserIdPrefix,
} from '../triggers/index.js';
import { UnifiedScheduler } from '../proactive/index.js';
import { OutboundQueue } from '../proactive/outbound-queue.js';
import { BotConfigManager } from '../channels/bot-config.js';
import { GoalService, createVerifiedGoalSkill } from '../goals/index.js';
import { BoardService } from '../board/board-service.js';
import { SubAgentRegistry, SubAgentExecutor, AnnounceQueue } from '../subagent/index.js';
import { createSubAgentSkills } from '../subagent/tools.js';
import { formatAgentExited, formatAgentResult } from '../subagent/messages.js';
import { SessionWaker, setSessionWaker, type WakeOptions, type WakeOutcome, type WakeTurnRequest } from './wake.js';
import { InterruptQueue } from '../agent/interrupt-queue.js';
import { setTraceSink } from '../routing/trace-tap.js';
import { setHookLogger } from '../hooks/hooks.js';
import { registerWebhookEventRelay } from '../hooks/webhook-relay.js';
import { SafeWorkflowExecutor, createExecuteWorkflowSkill } from '../workflow/index.js';
import { matchesPolicy } from '../skills/tool-policy.js';
import { resolveStateUserId, resolveStateUserTimezone } from '../utils/state-user-id.js';
import { stripThinkTags } from '../utils/output-safety.js';
import { inspectArtifact, validateArtifactForDelivery } from '../artifacts/delivery.js';
import { OutcomeBrain } from '../brain/index.js';
import { registerMediaSkills, type MediaSkills } from '../skills/media-skills.js';
import { backgroundProcesses, createBashDoneRouter, type BackgroundExitEvent } from '../tools/shell/index.js';
import { registerAgentTools, coreToolHooks } from '../tools/index.js';
import { getTodoSnapshot } from '../tools/todo/index.js';
import { buildRecallBlock, buildRecallDigest } from '../memory/recall.js';
import { enqueueInLane, laneIsBusy } from '../agent/command-queue.js';
import type { FileTools } from '../tools/files/index.js';

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
  private purposeRouter: PurposeRouter | null = null;
  private evolutionEngine: EvolutionEngine | null = null;
  /** Core memory, skill authoring, curator, background review + refine (Phase 5). */
  private learning: LearningRuntime | null = null;
  private costTracker: CostTracker | null = null;
  private scallopMemoryStore: ScallopMemoryStore | null = null;
  private backgroundGardener: BackgroundGardener | null = null;
  private factExtractor: LLMFactExtractor | null = null;
  private goalService: GoalService | null = null;
  private boardService: BoardService | null = null;
  private contextManager: ContextManager | null = null;
  private mediaProcessor: MediaProcessor | null = null;
  private voiceManager: VoiceManager | null = null;
  private configManager: BotConfigManager | null = null;
  private agent: Agent | null = null;
  private telegramChannel: TelegramChannel | null = null;
  private apiChannel: ApiChannel | null = null;
  /** Discord, Slack, WhatsApp, Signal, Matrix: whichever are configured and started */
  private chatChannels: ProactiveChatChannel[] = [];
  private unifiedScheduler: UnifiedScheduler | null = null;
  private subAgentRegistry: SubAgentRegistry | null = null;
  private subAgentExecutor: SubAgentExecutor | null = null;
  private announceQueue: AnnounceQueue | null = null;
  private interruptQueue: InterruptQueue | null = null;
  private outboundQueue: OutboundQueue | null = null;
  private outcomeBrain: OutcomeBrain | null = null;
  private mediaSkills: MediaSkills | null = null;
  /** Native file tools (read_file/write_file/patch/edit_file/undo); per-session state lives here. */
  private fileTools: FileTools | null = null;
  private subAgentDeliveryTimer: NodeJS.Timeout | null = null;
  private sessionWaker: SessionWaker | null = null;
  /** Opt-in email inbox trigger + calendar heads-up (src/triggers/mail-calendar.ts). */
  private mailCalendarTriggers: { stop(): void } | null = null;
  private bashDoneListener: ((e: BackgroundExitEvent) => void) | null = null;
  /** Explicit aliases for this deployment's single canonical state owner. */
  private canonicalSingleUserIds: string[] = [];

  /** Registry of active trigger sources for multi-channel message dispatch */
  private triggerSources: TriggerSourceRegistry = new Map();

  private isInitialized = false;
  private isRunning = false;

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.logger = options.logger;
  }

  private getUserTimezone(userId: string): string {
    if (!this.configManager) return Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolveStateUserTimezone(
      userId,
      this.canonicalSingleUserIds,
      candidate => this.configManager!.getUserTimezone(candidate),
    );
  }

  private configureLifecycleEventRelay(): void {
    setHookLogger((msg, error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: errorMessage }, msg);
    });

    const relay = this.config.eventRelay;
    if (!relay?.webhookUrl) return;

    const registeredHandlers = registerWebhookEventRelay({
      url: relay.webhookUrl,
      agentId: relay.agentId,
      secret: relay.webhookSecret,
      timeoutMs: relay.webhookTimeoutMs,
    });

    this.logger.info(
      { agentId: relay.agentId, handlers: registeredHandlers },
      'Lifecycle event webhook relay enabled'
    );
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.logger.info('Initializing gateway...');
    initSecurityLayers(this.logger, vaultLoadResult);
    this.configureLifecycleEventRelay();

    // A single configured Telegram owner may safely share the canonical
    // `default` memory/board state across channel-prefixed sessions. Empty or
    // multi-user allow-lists stay isolated for public multi-user deployments.
    const allowedTelegramUsers = this.config.channels.telegram.allowedUsers ?? [];
    this.canonicalSingleUserIds = allowedTelegramUsers.length === 1
      ? [allowedTelegramUsers[0], `telegram:${allowedTelegramUsers[0]}`]
      : [];

    // Initialize provider registry
    this.providerRegistry = new ProviderRegistry();
    this.initializeProviders();

    // Initialize router with providers. PROVIDER_ORDER env (via config.routing.providerOrder)
    // drives both the default chain and tier-level ordering so local/pinned providers can
    // be preferred over cloud ones. Cascade fallback still applies when the first choice fails.
    const routerOrder = this.config.routing.providerOrder;
    this.router = new Router({
      providerOrder: routerOrder,
      tierMapping: buildTierMapping(routerOrder),
    });
    this.registerProvidersWithRouter();

    // Single place that resolves which model each background job runs on.
    // Defaults preserve prior inline behavior; override via MODEL_<PURPOSE> env.
    // The pin set (MODEL_<PURPOSE> purposes) is excluded from the runtime /model
    // switch; getRuntimeModel reads the live global switch (configManager is
    // created later, so this is read lazily, only at resolve time).
    this.purposeRouter = new PurposeRouter(
      this.config.models ?? DEFAULT_MODELS,
      this.providerRegistry,
      this.router,
      new Set((this.config.modelPins ?? []) as ModelPurpose[]),
      () => this.configManager?.getGlobalModel(),
      this.logger,
    );

    // Memory embeddings: EMBEDDING_PROVIDER=tfidf|openai|ollama (unset = try
    // Ollama, else TF-IDF). Fixed for this process; vectors are tagged per model.
    const embeddingSetup = await createConfiguredEmbedder({
      ollamaBaseUrl: this.config.providers.ollama.baseUrl,
      openaiApiKey: this.config.providers.openai.apiKey || undefined,
      logger: this.logger,
    });
    const embedder: EmbeddingProvider | undefined = embeddingSetup.embedder;

    // Initialize memory system — ScallopMemory (SQLite) is always the primary backend.
    // If MEMORY_DB_PATH is absolute, use it as-is (lets workspace and DB be decoupled
    // — important when AGENT_WORKSPACE points to a skill scratch dir, not the data dir).
    // Otherwise resolve relative to the workspace.
    const configuredDbPath = this.config.memory.dbPath;
    const dbPath = path.isAbsolute(configuredDbPath)
      ? configuredDbPath
      : path.join(this.config.agent.workspace, configuredDbPath);

    // Provider for LLM re-ranking of search results (opt-in, graceful degradation).
    // Model choice lives in config.models.reranker (default: fast tier).
    // Resolves lazily per call (DynamicProvider) so the runtime /model switch
    // reaches re-ranking without a restart; degrades gracefully if no provider
    // is available when actually invoked.
    const rerankProvider: LLMProvider = this.purposeRouter.dynamicProviderFor('reranker');

    this.scallopMemoryStore = new ScallopMemoryStore({
      dbPath,
      logger: this.logger,
      embedder,
      embeddingModel: embeddingSetup.key,
      rerankProvider,
      // Foreground recall is BM25 + embeddings (+graph) only unless
      // MEMORY_FOREGROUND_RERANK=true; no LLM call sits before the reply.
      foregroundRerank: this.config.memory.foregroundRerank,
      relationsProvider: rerankProvider,
      mmrEnabled: this.config.memory.mmrEnabled,
      mmrLambda: this.config.memory.mmrLambda,
    });
    this.logger.info({ dbPath, count: this.scallopMemoryStore.getCount() }, 'ScallopMemory initialized');

    // Activate the LLM trace tap now that the DB exists: tagged completions
    // (fact extraction, reranking, tool calls, …) are recorded to llm_traces
    // as fine-tune training data. Best-effort by design.
    {
      const traceDb = this.scallopMemoryStore.getDatabase();
      const traceLogger = this.logger;
      setTraceSink((row) => {
        try {
          traceDb.insertLlmTrace(row);
        } catch (err) {
          traceLogger.debug({ error: (err as Error).message }, 'LLM trace insert failed (non-fatal)');
        }
      });
    }

    // Load runtime vault keys into process.env (before skill loading so gates pass)
    const runtimeKeys = this.scallopMemoryStore.getDatabase().getAllRuntimeKeys();
    for (const { key, value } of runtimeKeys) {
      process.env[key] = value;
    }
    if (runtimeKeys.length > 0) {
      this.logger.info({ count: runtimeKeys.length }, 'Runtime vault keys loaded into process.env');
    }

    // Initialize cost tracker (with SQLite persistence)
    this.costTracker = new CostTracker({
      dailyBudget: this.config.cost.dailyBudget,
      monthlyBudget: this.config.cost.monthlyBudget,
      warningThreshold: this.config.cost.warningThreshold,
      customPricing: this.config.cost.customPricing,
      db: this.scallopMemoryStore.getDatabase(),
    });
    this.logger.debug('Cost tracker initialized');

    // Initialize config manager early (needed by fact extractor and agent for timezone)
    this.configManager = new BotConfigManager(this.scallopMemoryStore.getDatabase(), this.logger);
    if (allowedTelegramUsers.length === 1) {
      this.configManager.adoptSingleUserModelAsGlobal(allowedTelegramUsers[0]);
    }

    // Backfill profiles without mixing facts between durable state owners.
    const backfillResult = this.scallopMemoryStore.backfillProfiles();
    if (backfillResult.fieldsPopulated > 0) {
      this.logger.info(backfillResult, 'User profiles backfilled');
    }

    // Backfill embeddings for old memories (runs in background, non-blocking)
    // Vectors from another embedding model are re-embedded too, unless this run
    // is on the TF-IDF fallback (they will be picked up once Ollama is back).
    this.scallopMemoryStore.backfillEmbeddings({
      batchSize: 20,
      limit: 500,
      includeStale: !embeddingSetup.fellBack,
    }).then(count => {
      if (count > 0) {
        this.logger.info({ embeddingsBackfilled: count }, 'Embedding backfill completed');
      }
    }).catch(err => {
      this.logger.warn({ error: (err as Error).message }, 'Embedding backfill failed');
    });

    // Goal service for hierarchical goal tracking
    this.goalService = new GoalService({
      db: this.scallopMemoryStore.getDatabase(),
      logger: this.logger,
      embedder,
    });
    this.logger.debug('Goal service initialized');

    // Board service for unified task tracking
    this.boardService = new BoardService(this.scallopMemoryStore.getDatabase(), this.logger);
    this.logger.debug('Board service initialized');

    // Initialize LLM-based fact extractor.
    // Background tasks (fact extraction + session summarization) should NOT use
    // the same upstream as the main chat — otherwise a single-slot local LLM
    // (e.g. Dell qwen3.6) gets hammered by foreground turn + async extractor
    // concurrently, causing 429 "overloaded" and timeouts. The "background"
    // model purpose encodes that heuristic (2nd non-local in PROVIDER_ORDER);
    // model choice lives in config.models.factExtraction.
    // Lazy per-call resolution so the runtime /model switch applies live.
    const factExtractionProvider: LLMProvider =
      this.purposeRouter.dynamicProviderFor('factExtraction');

    if (factExtractionProvider && this.scallopMemoryStore) {
      this.factExtractor = new LLMFactExtractor({
        provider: factExtractionProvider,
        scallopStore: this.scallopMemoryStore,
        logger: this.logger,
        embedder,
        costTracker: this.costTracker || undefined,
        deduplicationThreshold: 0.95, // Higher threshold - only skip true duplicates
        getTimezone: (userId: string) => this.getUserTimezone(userId),
        canonicalSingleUserIds: this.canonicalSingleUserIds,
      });
      this.logger.debug({ provider: factExtractionProvider.name }, 'LLM fact extractor initialized');
    }

    // Background gardener processes ScallopMemory decay
    // Created after factExtractionProvider so SessionSummarizer can use a chat-capable LLM
    const sessionSummarizer = factExtractionProvider
      ? new SessionSummarizer({ provider: factExtractionProvider, logger: this.logger, embedder })
      : undefined;
    // Nightly cognition (dream/reflection/proactive) runs on config.models.cognition
    // (default: fast tier — same as before, when this reused the rerank provider).
    const cognitionProvider = this.purposeRouter.dynamicProviderFor('cognition');
    const gardenerTuning = this.config.tuning?.gardener;
    this.backgroundGardener = new BackgroundGardener({
      scallopStore: this.scallopMemoryStore,
      logger: this.logger,
      interval: gardenerTuning?.lightIntervalMs ?? 60000, // 1 minute
      deepIntervalMs: gardenerTuning?.deepIntervalMs,
      sleepIntervalMs: gardenerTuning?.sleepIntervalMs,
      quietHours: gardenerTuning
        ? { start: gardenerTuning.quietHoursStart, end: gardenerTuning.quietHoursEnd }
        : undefined,
      fusionProvider: cognitionProvider,
      sessionSummarizer,
      workspace: this.config.agent.workspace,
      getTimezone: (userId: string) => this.getUserTimezone(userId),
      canonicalSingleUserIds: this.canonicalSingleUserIds,
      subAgentCleanupAfterSeconds: this.config.subagent?.cleanupAfterSeconds ?? 3600,
      subAgentDiagnosticRetentionSeconds:
        this.config.subagent?.diagnosticRetentionSeconds ?? 30 * 24 * 60 * 60,
      onMorningDigest: async (userId: string) => {
        await (this.unifiedScheduler?.sendMorningDigest(userId) ?? Promise.resolve(0));
      },
      // Late-bound: the evolution engine is constructed after the skill registry
      // exists; the gardener only ticks once started, by which point it is set.
      onDeepTick: async () => {
        await this.evolutionEngine?.runWatchdog();
      },
      onSleepTick: async () => {
        await this.evolutionEngine?.runOptimizer();
        // Archive agent-created skills unused for 30 days (pinned/bundled exempt).
        // Runs even when the evolution optimizer is disabled.
        if (this.evolutionEngine) await this.evolutionEngine.runCurator();
        else await this.learning?.curator.runNightly();
      },
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

    // Resolve any interrupted old/new skill-directory swap before the registry
    // scans local skills. Lazy recovery at the next nightly optimizer would
    // leave a promoted or restored procedure missing for the whole process run.
    await new SkillStore({ logger: this.logger }).recoverPendingPromotions();

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
      (userId: string) => this.getUserTimezone(userId),
      {
        timeoutMs: this.config.tuning?.skills?.timeoutMs,
        maxOutputBytes: this.config.tuning?.skills?.maxOutputBytes,
        canonicalSingleUserIds: this.canonicalSingleUserIds,
        onSkillExecuted: async (name: string, success: boolean) => {
          if (success) await this.learning?.curator.recordSkillUse(name);
        },
      }
    );
    this.logger.debug('Skill executor created');

    // Self-evolution engine (Layer 2). Constructed now that the skill registry +
    // executor exist; the gardener's deep/sleep ticks drive it (late-bound above).
    // One SkillStore (one .usage.json write queue) shared by evolution + learning.
    const sharedSkillStore = new SkillStore({ logger: this.logger });
    if (this.config.evolution?.enabled) {
      const evoDb = this.scallopMemoryStore.getDatabase();
      const registry = this.skillRegistry;
      const executor = this.skillExecutor;
      const purposeRouter = this.purposeRouter;
      this.evolutionEngine = new EvolutionEngine({
        db: evoDb,
        resolveProvider: () => purposeRouter.providerFor('evolution'),
        resolveEvalProvider: () => purposeRouter.providerFor('eval'),
        executor,
        reloadFromDisk: () => registry.reloadFromDisk(),
        getLiveSkillPath: (name: string) => registry.getSkill(name)?.path,
        getLiveSkillMetadata: (name: string) => {
          const skill = registry.getSkill(name);
          return skill
            ? { exists: true, source: skill.source, hasScripts: skill.hasScripts }
            : { exists: false };
        },
        config: this.config.evolution,
        store: sharedSkillStore,
        logger: this.logger,
      });
      this.logger.debug('Self-evolution engine initialized');
    }

    {
      const purposeRouter = this.purposeRouter;
      const evolutionConfig = this.config.evolution;
      this.learning = new LearningRuntime({
        db: this.scallopMemoryStore.getDatabase(),
        scallopStore: this.scallopMemoryStore,
        registry: this.skillRegistry,
        workspace: this.config.agent.workspace,
        canonicalSingleUserIds: this.canonicalSingleUserIds,
        skillStore: sharedSkillStore,
        getReviewProvider: () => purposeRouter.providerFor('evolution'),
        getCheapProvider: () => purposeRouter.providerFor('cognition'),
        getJudgeProvider: evolutionConfig?.useLlmJudge === false
          ? undefined
          : () => purposeRouter.providerFor('evolution'),
        curator: evolutionConfig
          ? {
              enabled: evolutionConfig.curatorEnabled,
              staleAfterDays: evolutionConfig.curatorStaleDays,
              archiveAfterDays: evolutionConfig.curatorArchiveDays,
              backupKeep: evolutionConfig.curatorBackupKeep,
            }
          : undefined,
        logger: this.logger,
      });
    }

    // Initialize voice manager (for voice reply tool)
    this.voiceManager = VoiceManager.fromEnv(this.logger);
    const voiceStatus = await this.voiceManager.isAvailable();
    this.logger.debug(
      { stt: voiceStatus.stt, tts: voiceStatus.tts },
      'Voice manager initialized'
    );

    // Register native skills (comms + memory_get) that need runtime access
    this.registerNativeSkills(voiceStatus.tts);
    // Native coding/web tools: bash + process, todo, webfetch + web_search
    // image_gen / phone_call / sms: bundled SKILL.md, in-process handlers
    const mediaVoice = voiceStatus.tts ? this.voiceManager : null;
    this.mediaSkills = registerMediaSkills({
      registry: this.skillRegistry,
      logger: this.logger,
      costTracker: this.costTracker ?? undefined,
      deliverFile: (userId, filePath, caption, ctx) =>
        this.handleFileSend(userId, filePath, caption, ctx.sessionId, ctx.userMessage),
      getApprovals: () => this.agent?.getApprovalStore(),
      notify: (userId, text) => this.handleProactiveMessage(userId, text),
      synthesize: mediaVoice ? (text) => mediaVoice.synthesize(text, { format: 'mp3' }) : undefined,
    });
    this.logger.debug(
      { nativeSkills: ['send_message', 'send_file', 'inspect_artifact', 'voice_reply', 'memory_get', 'load_procedure', 'memory', 'skill_manage'].filter(n => this.skillRegistry!.hasSkill(n)) },
      'Native skills registered'
    );

    // Initialize session manager (uses SQLite)
    this.sessionManager = new SessionManager(this.scallopMemoryStore!.getDatabase());
    this.logger.debug('Session manager initialized (SQLite)');

    // Every dynamic message/action converges here. All other components only
    // propose outcomes and share this exact process-level instance.
    this.outcomeBrain = new OutcomeBrain({
      db: this.scallopMemoryStore!.getDatabase(),
      logger: this.logger,
      router: this.router!,
      goalService: this.goalService ?? undefined,
      getTimezone: (userId: string) => this.getUserTimezone(userId),
      canonicalSingleUserIds: this.canonicalSingleUserIds,
    });
    this.logger.info({ brainId: this.outcomeBrain.getId() }, 'Shared outcome brain initialized');

    // Shared evidence recorder: successful multi-tool child workflows can feed
    // the same held-out, privacy-gated procedural skill evolution as main turns.
    const evolutionRecorder = this.config.evolution?.enabled
      ? new EvolutionRecorder(
          this.scallopMemoryStore.getDatabase(),
          this.config.evolution,
          this.logger,
        )
      : undefined;

    // Initialize sub-agent infrastructure
    const subagentConfig = this.config.subagent;
    this.announceQueue = new AnnounceQueue({ maxQueueSize: 20, logger: this.logger });
    this.interruptQueue = new InterruptQueue({ maxQueueSize: 10, logger: this.logger });
    this.subAgentRegistry = new SubAgentRegistry({
      config: subagentConfig,
      logger: this.logger,
      persistence: this.scallopMemoryStore!.getDatabase(),
    });

    // Recover orphaned sub-agent runs from SQLite on startup
    if (this.scallopMemoryStore) {
      const db = this.scallopMemoryStore.getDatabase();
      const activeRows = db.getActiveSubAgentRuns();
      if (activeRows.length > 0) {
        const orphaned = this.subAgentRegistry.loadFromPersistence(
          activeRows.map(row => ({
            id: row.id,
            parentSessionId: row.parentSessionId,
            childSessionId: row.childSessionId,
            task: row.task,
            label: row.label,
            status: row.status as 'pending' | 'running',
            allowedSkills: row.allowedSkills ? row.allowedSkills.split(',') : [],
            modelTier: row.modelTier as 'fast' | 'standard' | 'capable',
            timeoutMs: row.timeoutMs,
            idleTimeoutMs: row.idleTimeoutMs ?? 300_000,
            hardTimeoutMs: row.hardTimeoutMs ?? row.timeoutMs,
            contextMode: (row.contextMode as 'isolated' | 'brief' | 'fork') ?? 'brief',
            role: (row.role as 'leaf' | 'orchestrator') ?? 'leaf',
            workspaceMode: (row.workspaceMode as 'shared' | 'worktree') ?? 'shared',
            workspacePath: row.workspacePath ?? undefined,
            parentRunId: row.parentRunId ?? undefined,
            batchId: row.batchId ?? undefined,
            batchIndex: row.batchIndex ?? undefined,
            spawnDepth: row.spawnDepth ?? 0,
            lastProgressAt: row.lastProgressAt ?? undefined,
            tokenUsage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
            createdAt: row.createdAt,
            startedAt: row.startedAt ?? undefined,
            completedAt: row.completedAt ?? undefined,
          }))
        );
        for (const row of activeRows) {
          const parent = await this.sessionManager.getSession(row.parentSessionId);
          db.enqueueSubAgentDelivery({
            runId: row.id,
            parentSessionId: row.parentSessionId,
            userId: typeof parent?.metadata?.userId === 'string' ? parent.metadata.userId : null,
            payloadJson: JSON.stringify({
              runId: row.id,
              label: row.label,
              kind: 'agent-exited',
              message: formatAgentExited(row.label, '', {
                reason: 'process restarted while the agent was running; check for partial side effects before retrying',
                runId: row.id,
              }),
              result: {
                status: 'blocked',
                summary: 'The worker was interrupted by a process restart, so no success was assumed.',
                blockers: ['Process restarted while the worker was active'],
                nextActions: ['Retry the task after checking whether any external side effect already happened'],
              },
            }),
          });
        }
        this.logger.info({ orphaned, total: activeRows.length }, 'Recovered orphaned sub-agent runs');
      }
    }

    // Initialize agent
    const provider = this.providerRegistry.getDefaultProvider();
    if (!provider) {
      throw new Error('No LLM provider available. Please configure at least one provider.');
    }

    // SubAgentExecutor needs the session manager, so create it before Agent
    this.subAgentExecutor = new SubAgentExecutor({
      registry: this.subAgentRegistry,
      announceQueue: this.announceQueue,
      sessionManager: this.sessionManager,
      skillRegistry: this.skillRegistry!,
      skillExecutor: this.skillExecutor!,
      router: this.router!,
      costTracker: this.costTracker || undefined,
      scallopStore: this.scallopMemoryStore || undefined,
      contextManager: this.contextManager || undefined,
      workspace: this.config.agent.workspace,
      logger: this.logger,
      config: subagentConfig,
      canonicalSingleUserIds: this.canonicalSingleUserIds,
      deliveryOutbox: this.scallopMemoryStore!.getDatabase(),
      // The outbox row is written before this fires; drain it right away
      // instead of waiting for the 1s tick so idle parents wake promptly.
      onResultReady: () => { if (this.isRunning) void this.drainSubAgentDeliveriesSafely(); },
      evolutionRecorder,
      outcomeBrain: this.outcomeBrain,
      skillPolicyResolver: async (skillName, context) => {
        if (this.config.tools?.policy && !matchesPolicy(skillName, this.config.tools.policy)) return false;
        const parent = await this.sessionManager!.getSession(context.parentSessionId);
        if (!parent) return false;
        const channelId = parent?.metadata?.channelId as string | undefined;
        const channelPolicy = channelId ? this.config.tools?.channelPolicies?.[channelId] : undefined;
        return !channelPolicy || matchesPolicy(skillName, channelPolicy);
      },
    });

    // Register spawn_agent and check_agents skills
    this.registerSubAgentSkills();
    const workflowExecutor = new SafeWorkflowExecutor({
      skillRegistry: this.skillRegistry!,
      skillExecutor: this.skillExecutor!,
      logger: this.logger,
      isToolAllowed: async (toolName, context) => {
        if (this.config.tools?.policy && !matchesPolicy(toolName, this.config.tools.policy)) return false;
        const session = await this.sessionManager!.getSession(context.sessionId);
        if (!session) return false;
        const channelId = session?.metadata?.channelId as string | undefined;
        const channelPolicy = channelId ? this.config.tools?.channelPolicies?.[channelId] : undefined;
        return !channelPolicy || matchesPolicy(toolName, channelPolicy);
      },
      // Workflow steps run like any other tool call: the user's request is
      // the authorization, and tool policy above is the only filter.
      authorizeStep: async () => true,
    });
    this.skillRegistry!.registerSkill(createExecuteWorkflowSkill(workflowExecutor));
    if (this.goalService) {
      this.skillRegistry!.registerSkill(createVerifiedGoalSkill(this.goalService, this.subAgentExecutor, this.router!));
    }
    this.logger.debug('Sub-agent system initialized');

    // Register manage_skills skill for ClawHub integration
    await this.registerSkillManagementSkill();
    this.logger.debug('Skill management skill registered');

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
      boardService: this.boardService || undefined,
      configManager: this.configManager || undefined,
      contextManager: this.contextManager,
      mediaProcessor: this.mediaProcessor,
      workspace: this.config.agent.workspace,
      logger: this.logger,
      maxIterations: this.config.agent.maxIterations,
      maxToolCallsPerResponse: this.config.tools?.loopDetection?.maxCallsPerResponse ?? 64,
      toolLoopDetection: {
        historySize: this.config.tools?.loopDetection?.historySize ?? 30,
        warningThreshold: this.config.tools?.loopDetection?.warningThreshold ?? 3,
        criticalThreshold: this.config.tools?.loopDetection?.criticalThreshold ?? 5,
        circuitBreakerThreshold: this.config.tools?.loopDetection?.circuitBreakerThreshold ?? 8,
      },
      foregroundCallTimeoutMs: this.config.agent.foregroundCallTimeoutMs,
      turnTimeoutMs: this.config.agent.turnTimeoutMs,
      enableThinking: this.config.providers.moonshot.enableThinking,
      toolPolicy: this.config.tools?.policy,
      channelToolPolicies: this.config.tools?.channelPolicies,
      bestOfN: this.config.tuning?.critic?.bestOfN,
      bestOfNThreshold: this.config.tuning?.critic?.bestOfNThreshold,
      enableComplexityAnalysis: this.config.routing.enableComplexityAnalysis,
      canonicalSingleUserIds: this.canonicalSingleUserIds,
      evolutionRecorder,
      outcomeBrain: this.outcomeBrain,
      announceQueue: this.announceQueue,
      subAgentExecutor: this.subAgentExecutor,
      interruptQueue: this.interruptQueue,
      hooks: this.buildAgentHooks(),
    });
    // Background learning replays the exact last request so the cache hits.
    const agentForReplay = this.agent;
    this.learning?.setReplaySource((sessionId) => {
      const last = agentForReplay.getLastRequest(sessionId);
      return last?.system ? LearningRuntime.replay(last.system, last.messages, last.tools) : null;
    });
    this.logger.debug('Agent initialized');

    // Idle wake-up for background completions (sub-agents, background bash).
    this.sessionWaker = new SessionWaker({
      isBusy: sessionId => laneIsBusy(`session:${sessionId}`),
      runTurn: request => this.runWakeTurn(request),
      logger: this.logger,
    });
    setSessionWaker(this.sessionWaker);

    // Initialize outbound queue (rate-limits proactive messages across all subsystems)
    this.outboundQueue = new OutboundQueue({
      sendMessage: (userId: string, message: string) => this.handleProactiveMessage(userId, message),
      logger: this.logger,
      router: this.router || undefined,
      outcomeBrain: this.outcomeBrain,
    });

    // Initialize unified scheduler (handles both user reminders and agent triggers)
    if (this.scallopMemoryStore) {
      this.unifiedScheduler = new UnifiedScheduler({
        db: this.scallopMemoryStore.getDatabase(),
        logger: this.logger,
        goalService: this.goalService || undefined,
        sessionManager: this.sessionManager || undefined,
        subAgentExecutor: this.subAgentExecutor || undefined,
        router: this.router || undefined,
        interval: 30 * 1000, // Check every 30 seconds
        onSendMessage: this.mediaSkills
          ? this.mediaSkills.withReminderCalls(this.outboundQueue.createHandler())
          : this.outboundQueue.createHandler(),
        getTimezone: (userId: string) => this.getUserTimezone(userId),
        canonicalSingleUserIds: this.canonicalSingleUserIds,
      });
      this.logger.debug('Unified scheduler initialized');
    }

    this.wireBashDoneNotices();

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
        ...(openaiConfig.baseUrl && { baseUrl: openaiConfig.baseUrl }),
        apiKey: openaiConfig.apiKey,
        model: openaiConfig.model,
        timeout: 60000,
      });
      this.providerRegistry.registerProvider(openai);
      this.logger.debug({ provider: 'openai', model: openaiConfig.model }, 'Provider registered');
    }

    // Initialize Local provider (OpenAI-compatible, e.g. llama-swap on the Dell P40).
    // Registered under the name "local" so it can appear in PROVIDER_ORDER and /model
    // independently of the cloud "openai" provider.
    const localBaseUrl = process.env.LOCAL_BASE_URL;
    if (localBaseUrl) {
      const local = new OpenAIProvider({
        name: 'local',
        baseUrl: localBaseUrl,
        apiKey: process.env.LOCAL_API_KEY || 'sk-local',
        model: process.env.LOCAL_MODEL || 'qwen3.6',
        timeout: 600000,
      });
      this.providerRegistry.registerProvider(local);
      this.logger.debug({ provider: 'local', model: process.env.LOCAL_MODEL || 'qwen3.6' }, 'Provider registered');
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

    // Multi-model mode: user-defined OpenAI-compatible endpoints from
    // CUSTOM_PROVIDER_* env vars. Each registers under its own name, so it can
    // be pinned per purpose (MODEL_RERANKER=my-memory) or placed in the chat
    // fallback chain (PROVIDER_ORDER=my-tools,openrouter).
    // Optional-chained: hand-rolled configs (tests, embedders) may omit the
    // section; zod-loaded configs always have it.
    const multiModel = this.config.multiModel ?? { enabled: false, providers: [], timeoutMs: 60_000 };
    if (multiModel.enabled) {
      for (const cp of multiModel.providers) {
        const custom = new OpenAIProvider({
          name: cp.name,
          baseUrl: cp.baseUrl,
          apiKey: cp.apiKey,
          model: cp.model,
          // Bound a dead endpoint so Router can reach the next provider. Slow
          // local models can opt into a larger value with MULTI_MODEL_TIMEOUT_MS.
          timeout: multiModel.timeoutMs ?? 60_000,
        });
        this.providerRegistry.registerProvider(custom);
        this.logger.info({ provider: cp.name, model: cp.model, baseUrl: cp.baseUrl }, 'Custom provider registered (multi-model mode)');
      }
    } else if (multiModel.providers.length > 0) {
      this.logger.warn(
        { defined: multiModel.providers.map((p) => p.name) },
        'CUSTOM_PROVIDER_* set but MULTI_MODEL_ENABLED is not "true" — custom providers ignored'
      );
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
        providerRegistry: this.providerRegistry || undefined,
        interruptQueue: this.interruptQueue || undefined,
        onUserMessage: (prefixedUserId: string, userMessage?: string, context?) => {
          return this.unifiedScheduler?.checkEngagement(prefixedUserId, userMessage, context);
        },
      });
      await this.telegramChannel.start();

      // Wire singleton for skill access
      TelegramGateway.getInstance().setChannel(this.telegramChannel);

      // Register as trigger source
      this.registerTelegramTriggerSource(this.telegramChannel);
    }

    // Start the other chat channels that have credentials. Each failure is
    // logged inside startChatChannels and never aborts gateway startup.
    this.chatChannels = await startChatChannels(
      configuredChatChannels(this.config.channels, {
        agent: this.agent!,
        sessionManager: this.sessionManager!,
        logger: this.logger,
        db: this.scallopMemoryStore?.getDatabase(),
        voiceManager: this.voiceManager || undefined,
        onUserMessage: (prefixedUserId: string, userMessage?: string) =>
          this.unifiedScheduler?.checkEngagement(prefixedUserId, userMessage),
      }),
      this.logger,
    );
    for (const channel of this.chatChannels) {
      this.registerChatTriggerSource(channel);
    }

    // Start API channel if enabled (web UI)
    if (this.config.channels.api.enabled) {
      this.apiChannel = new ApiChannel({
        port: this.config.channels.api.port,
        host: this.config.channels.api.host,
        apiKey: this.config.channels.api.apiKey,
        // Resolve the built dashboard relative to the package (src/ or dist/ →
        // ../../public) so it is found under `npm install -g` and in Docker,
        // not only when started from the repo root.
        staticDir: fileURLToPath(new URL('../../public', import.meta.url)),
        agent: this.agent!,
        sessionManager: this.sessionManager!,
        logger: this.logger,
        costTracker: this.costTracker || undefined,
        memoryStore: this.scallopMemoryStore || undefined,
        db: this.scallopMemoryStore?.getDatabase(),
        interruptQueue: this.interruptQueue || undefined,
        onUserMessage: (prefixedUserId: string, userMessage?: string) => {
          this.unifiedScheduler?.checkEngagement(prefixedUserId, userMessage);
        },
        configManager: this.configManager || undefined,
        providerRegistry: this.providerRegistry || undefined,
        subAgentRegistry: this.subAgentRegistry || undefined,
        subAgentExecutor: this.subAgentExecutor || undefined,
        twilioWebhook: this.mediaSkills?.twilioWebhook,
        voiceManager: this.voiceManager || undefined,
      });
      await this.apiChannel.start();

      // Register as trigger source if it implements TriggerSource
      if (this.isApiChannelTriggerSource(this.apiChannel)) {
        this.triggerSources.set('api', this.apiChannel);
        this.logger.debug('Registered api trigger source');
      }
    }

    // Start outbound queue (before scheduler so deliveries are ready)
    if (this.outboundQueue) {
      this.outboundQueue.start();
    }

    // Start unified scheduler (after trigger sources are registered)
    if (this.unifiedScheduler) {
      // Nothing awaits this, so a rejection would be an unhandled rejection
      // and terminate the process instead of leaving the rest of the gateway
      // (channels, agent) running.
      void this.unifiedScheduler.start().catch(error => {
        this.logger.error(
          { error: (error as Error).message },
          'Unified scheduler failed to start'
        );
      });
    }

    // Push completed background children immediately. The durable outbox also
    // drains completions produced just before a restart. A failure to claim or
    // release outbox rows must not abort startup or, on the interval, crash the
    // process — the next tick retries in a second.
    await this.drainSubAgentDeliveriesSafely();
    this.subAgentDeliveryTimer = setInterval(() => {
      void this.drainSubAgentDeliveriesSafely();
    }, 1_000);

    // Email inbox trigger and calendar heads-up; both off unless configured.
    const { startMailAndCalendarTriggers } = await import('../triggers/mail-calendar.js');
    this.mailCalendarTriggers = startMailAndCalendarTriggers({
      agent: this.agent!,
      sessionManager: this.sessionManager!,
      logger: this.logger,
      notifyOwner: (text) => this.handleProactiveMessage('default', text),
      ownerTimeZone: () => this.getUserTimezone('default'),
    });

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
      sendMessage: async (userId: string, message: string): Promise<MessageDeliveryResult> => {
        return channel.sendMessage(userId, message);
      },
      sendFile: async (userId: string, filePath: string, caption?: string): Promise<boolean> => {
        return channel.sendFile(userId, filePath, caption);
      },
      getName: () => 'telegram',
    };

    this.triggerSources.set('telegram', triggerSource);
    this.logger.debug('Registered telegram trigger source');
  }

  /** Register a started chat channel for reminders and proactive delivery. */
  private registerChatTriggerSource(channel: ProactiveChatChannel): void {
    this.triggerSources.set(channel.name, {
      sendMessage: (userId: string, message: string) => channel.sendMessage(userId, message),
      sendFile: (userId: string, filePath: string, caption?: string) => channel.sendFile(userId, filePath, caption),
      getName: () => channel.name,
    });
    this.logger.debug({ channel: channel.name }, 'Registered chat trigger source');
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

    // Stop outbound queue
    if (this.outboundQueue) {
      this.outboundQueue.stop();
      this.outboundQueue = null;
    }

    if (this.subAgentDeliveryTimer) {
      clearInterval(this.subAgentDeliveryTimer);
      this.subAgentDeliveryTimer = null;
    }
    if (this.sessionWaker) {
      this.sessionWaker.stop();
      setSessionWaker(null);
      this.sessionWaker = null;
    }

    this.mailCalendarTriggers?.stop();
    this.mailCalendarTriggers = null;

    // Background bash processes die with the gateway.
    if (this.bashDoneListener) {
      backgroundProcesses.off('exit', this.bashDoneListener);
      this.bashDoneListener = null;
    }
    await backgroundProcesses.killAll();

    // Clear trigger sources before stopping channels
    this.triggerSources.clear();

    // Stop API channel
    if (this.apiChannel) {
      await this.apiChannel.stop();
      this.apiChannel = null;
    }

    // Stop the other chat channels
    for (const channel of this.chatChannels) {
      try {
        await channel.stop();
      } catch (error) {
        this.logger.warn({ channel: channel.name, error: (error as Error).message }, 'Chat channel failed to stop cleanly');
      }
    }
    this.chatChannels = [];

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

  /** Per-purpose model resolver (reranker, factExtraction, cognition, critic, evolution, eval). */
  getPurposeRouter(): PurposeRouter {
    if (!this.purposeRouter) {
      throw new Error('Gateway not initialized');
    }
    return this.purposeRouter;
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

  /** Phase 5 learning runtime (core memory, recall helpers, review, refine, curator). */
  getLearningRuntime(): LearningRuntime | null {
    return this.learning;
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

  /** Native file tools; e.g. `getFileTools()?.store.resetReads(sessionId)` after compaction. */
  getFileTools(): FileTools | null {
    return this.fileTools;
  }

  isGatewayRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Integrations the agent loop calls: large-output persistence on every tool
   * result and the verify-on-stop nudge. Later phases add to this.
   */
  private buildAgentHooks(): AgentHooks {
    const hooks: AgentHooks = {
      ...coreToolHooks({
        workspace: this.config.agent.workspace,
        contextWindowTokens: this.config.context.maxContextTokens,
      }),
    };
    const learning = this.learning;
    const store = this.scallopMemoryStore;
    // Compaction: carry the todo list through the summary, and forget which
    // file ranges were read (the model no longer has that content).
    hooks.compactionExtraState = (sessionId) => getTodoSnapshot(sessionId);
    hooks.onCompaction = (sessionId) => {
      this.fileTools?.store.resetReads(sessionId);
    };
    if (learning) {
      hooks.skillIndex = () => learning.renderSkillIndex();
      hooks.frozenPromptSections = ({ userId }) => [
        learning.renderSessionCoreMemory(userId),
        learning.renderPromptNotes(),
      ];
      // Running per-session totals for the review/refine triggers.
      const totals = new Map<string, { turns: number; toolCalls: number }>();
      hooks.afterTurn = ({ sessionId, userId, userMessage, toolCallCount, compacted }) => {
        const total = totals.get(sessionId) ?? { turns: 0, toolCalls: 0 };
        total.turns++;
        total.toolCalls += toolCallCount;
        totals.set(sessionId, total);
        if (totals.size > 1_000) totals.delete(totals.keys().next().value!);
        learning.reviewer.maybeScheduleReview({
          sessionId,
          userId,
          turnCount: total.turns,
          toolCallCount: total.toolCalls,
          compacted,
          userCorrection: userMessage,
        });
        learning.refine.maybeScheduleRefine({ sessionId, userId, turnCount: total.turns, compacted });
      };
    }
    if (store) {
      // Fast recall: BM25 + embeddings with a hard latency budget, no LLM.
      // A session's first turn also gets the ranked digest.
      hooks.recall = async ({ userId, userMessage, timezone, coldStart }) => {
        const block = await buildRecallBlock(store, userId, userMessage, { budgetMs: 1_500, timezone });
        if (!coldStart) return block;
        const digest = buildRecallDigest(store, userId, { goal: userMessage, recentMessages: [userMessage] });
        return [digest, block].filter((part) => part.trim()).join('\n\n');
      };
    }
    return hooks;
  }

  /**
   * Register native skills that need runtime access (channels, memory, voice).
   * These run in-process via handlers instead of as subprocesses.
   */
  private registerNativeSkills(ttsAvailable: boolean): void {
    if (!this.skillRegistry) return;

    // Built-in native tools: read_file/write_file/patch/edit_file/undo (per-session
    // stateful), bash + process, todo, webfetch + web_search.
    this.fileTools = registerAgentTools(this.skillRegistry, { files: { logger: this.logger } }).fileTools;

    // send_message skill
    const sendMessageSkill = defineSkill('send_message', 'Send a text message to the user immediately. Use this for conversational, human-like messaging.')
      .userInvocable(false)
      .safety({ externalWrite: true, publicCommunication: true })
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

    const inspectArtifactSkill = defineSkill('inspect_artifact', 'Read-only verification of a generated file under output/: exact path, bytes, modification time, type, and PDF page count.')
      .userInvocable(false)
      .safety({ readOnly: true })
      .inputSchema({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path under output/' },
        },
        required: ['file_path'],
      })
      .onNativeExecute(async (ctx) => {
        const filePath = String(ctx.args.file_path ?? '');
        try {
          const inspected = await inspectArtifact(path.resolve(ctx.workspace, 'output'), filePath);
          return {
            success: true,
            output: JSON.stringify({
              path: inspected.relativePath,
              fileName: inspected.fileName,
              sizeBytes: inspected.sizeBytes,
              modifiedAt: new Date(inspected.modifiedAt).toISOString(),
              extension: inspected.extension,
              sha256: inspected.sha256,
              ...(inspected.pdfPageCount !== undefined && { pdfPageCount: inspected.pdfPageCount }),
              ...(inspected.pdfProducer && { pdfProducer: inspected.pdfProducer }),
            }),
          };
        } catch (error) {
          return { success: false, output: '', error: `[TOOL_ERROR code=ARTIFACT_INSPECTION_FAILED] ${(error as Error).message}` };
        }
      })
      .build();
    this.skillRegistry.registerSkill(inspectArtifactSkill.skill);

    // send_file skill
    const sendFileSkill = defineSkill('send_file', 'Send a file to the user via chat. Use this to send PDFs, images, documents, or any file the user requests.')
      .userInvocable(false)
      .safety({ externalWrite: true, publicCommunication: true })
      .inputSchema({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to a file under the workspace output/ directory' },
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
        const workspaceRoot = pathMod.resolve(ctx.workspace);
        const outputRoot = pathMod.resolve(workspaceRoot, 'output');
        const absolutePath = pathMod.resolve(workspaceRoot, filePath);
        const isWithinDirectory = (root: string, target: string): boolean => {
          const relative = pathMod.relative(root, target);
          return relative === '' || (!!relative && !relative.startsWith('..') && !pathMod.isAbsolute(relative));
        };

        if (!isWithinDirectory(outputRoot, absolutePath)) {
          return { success: false, output: 'Access denied: send_file can only send files from the workspace output/ directory' };
        }

        try {
          await fsMod.access(absolutePath);
        } catch {
          return { success: false, output: `File not found: ${absolutePath}` };
        }

        const [realWorkspaceRoot, realOutputRoot, realFilePath] = await Promise.all([
          fsMod.realpath(workspaceRoot),
          fsMod.realpath(outputRoot),
          fsMod.realpath(absolutePath),
        ]);
        const expectedRealOutputRoot = pathMod.resolve(realWorkspaceRoot, 'output');
        if (realOutputRoot !== expectedRealOutputRoot || !isWithinDirectory(realOutputRoot, realFilePath)) {
          return { success: false, output: 'Access denied: send_file cannot follow paths outside the workspace output/ directory' };
        }

        const stats = await fsMod.stat(realFilePath);
        if (!stats.isFile()) {
          return { success: false, output: `Not a file: ${absolutePath}` };
        }
        const maxSize = 50 * 1024 * 1024;
        if (stats.size > maxSize) {
          return { success: false, output: `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max 50MB)` };
        }

        const validation = await validateArtifactForDelivery({
          outputRoot: realOutputRoot,
          requestedPath: realFilePath,
          userMessage: ctx.userMessage,
          previousAssistantMessage: ctx.previousAssistantMessage,
          caption,
          turnStartedAt: ctx.turnStartedAt,
        });
        if (!validation.passed) {
          const suggestion = validation.suggestedPath
            ? ` Suggested current artifact: ${validation.suggestedPath}.`
            : '';
          return {
            success: false,
            output: '',
            error: `[TOOL_ERROR code=${validation.code ?? 'ARTIFACT_VALIDATION_FAILED'}] ${validation.reason ?? 'Artifact validation failed.'}${suggestion}`,
          };
        }

        const ok = await this.handleFileSend(
          ctx.userId,
          realFilePath,
          caption,
          ctx.sessionId,
          ctx.userMessage,
        );
        if (ok) {
          const fileName = pathMod.basename(realFilePath);
          const sizeKB = (stats.size / 1024).toFixed(1);
          const receipt = validation.inspection;
          return {
            success: true,
            output: `File sent successfully: ${fileName} (${sizeKB}KB, sha256:${receipt?.sha256 ?? 'unknown'}${receipt?.pdfPageCount !== undefined ? `, pages:${receipt.pdfPageCount}` : ''})`,
          };
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
        const stateUserId = resolveStateUserId(ctx.userId, this.canonicalSingleUserIds);

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
            const entry = scallopStore.getForUser(id, stateUserId);
            // Treat another user's ID exactly like an unknown ID. Object IDs
            // must never bypass the durable owner boundary.
            if (!entry) {
              return { success: false, output: '', error: `Memory not found with ID: ${id}` };
            }
            entries = [entry];
          } else if (sessionId) {
            // Legacy callers pass a session selector even though facts have no
            // session foreign key. Keep retrieval useful, but scope it to the
            // authenticated state owner instead of treating a caller-supplied
            // session string as a user ID.
            entries = scallopStore.getByUser(stateUserId, { category: mapCategory(type), limit: 100 });
          } else if (recent) {
            entries = scallopStore.getByUser(stateUserId, {
              category: mapCategory(type),
              limit: Math.min(recent, 100),
              orderBy: 'recency',
            });
          } else if (type) {
            entries = scallopStore.getByUser(stateUserId, { category: mapCategory(type), limit: 50 });
          } else {
            entries = scallopStore.getByUser(stateUserId, { limit: 10 });
          }

          logger.debug({ id, sessionId, type, recent, stateUserId, count: entries.length }, 'Memory get completed');

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

    // session_search: FTS5/BM25 recall over the caller's own transcripts,
    // including turns that lean compaction removed from the context.
    if (this.scallopMemoryStore) {
      registerSessionSearchTool(this.skillRegistry, {
        db: this.scallopMemoryStore.getDatabase(),
        canonicalSingleUserIds: () => this.canonicalSingleUserIds,
      });
    }

    // Safe on-demand access to documentation-only (including learned) skills.
    // Explicit selection is the usage signal that drives curator decisions.
    this.skillRegistry.registerSkill(createLoadProcedureSkill(
      this.skillRegistry,
      name => this.learning?.curator.recordSkillUse(name),
    ));

    // Core memory (`memory` tool) + verified/versioned skill authoring (`skill_manage`).
    this.learning?.registerTools();
  }

  /**
   * Register spawn_agent, check_agents and progress_note (src/subagent/tools.ts).
   */
  private registerSubAgentSkills(): void {
    if (!this.skillRegistry || !this.subAgentRegistry || !this.subAgentExecutor || !this.sessionManager) return;
    for (const skill of createSubAgentSkills({
      registry: this.subAgentRegistry,
      executor: this.subAgentExecutor,
      sessionManager: this.sessionManager,
      logger: this.logger,
    })) {
      this.skillRegistry.registerSkill(skill);
    }
  }

  /**
   * Register manage_skills native skill for ClawHub skill management.
   * Allows the agent to search, install, uninstall, and list skills at runtime.
   */
  private async registerSkillManagementSkill(): Promise<void> {
    if (!this.skillRegistry) return;

    const { SkillPackageManager } = await import('../skills/clawhub.js');
    const pkgManager = new SkillPackageManager({ logger: this.logger });
    const registry = this.skillRegistry;
    const db = this.scallopMemoryStore!.getDatabase();

    const skill = defineSkill('manage_skills', 'Search, install, uninstall, or list skills from ClawHub (clawhub.ai). Also manages runtime API keys for gated skills.')
      .userInvocable(false)
      .inputSchema({
        type: 'object',
        properties: {
          action: { type: 'string', description: 'One of: search, install, uninstall, list, set_key, remove_key' },
          query: { type: 'string', description: 'Search query (for search action)' },
          slug: { type: 'string', description: 'Skill slug e.g. "owner/skill-name" (for install/uninstall)' },
          key_name: { type: 'string', description: 'Environment variable name, e.g. WEATHER_API_KEY (for set_key/remove_key)' },
          key_value: { type: 'string', description: 'The API key value (for set_key)' },
        },
        required: ['action'],
      })
      .onNativeExecute(async (ctx) => {
        const action = ctx.args.action as string;
        switch (action) {
          case 'search': {
            const results = await pkgManager.searchClawHub(ctx.args.query as string);
            return { success: true, output: JSON.stringify(results, null, 2) };
          }
          case 'install': {
            const result = await pkgManager.installFromClawHub(ctx.args.slug as string);
            if (result.success) {
              await registry.reloadFromDisk();
            }
            return { success: result.success, output: result.success ? `Installed "${ctx.args.slug}"` : result.error || 'Install failed' };
          }
          case 'uninstall': {
            const result = await pkgManager.uninstall(ctx.args.slug as string);
            if (result.success) {
              await registry.reloadFromDisk();
            }
            return { success: result.success, output: result.success ? `Uninstalled "${ctx.args.slug}"` : result.error || 'Uninstall failed' };
          }
          case 'list': {
            const installed = await pkgManager.listInstalled();
            const available = registry.getAvailableSkills().map(s => s.name);
            const lines: string[] = [];
            if (available.length) {
              lines.push(`Available skills (already loaded — call these directly as tools):\n${available.join(', ')}`);
            }
            if (installed.length) {
              lines.push(`ClawHub-installed skills:\n${installed.join('\n')}`);
            }
            return { success: true, output: lines.length ? lines.join('\n\n') : 'No skills available' };
          }
          case 'set_key': {
            const keyName = ctx.args.key_name as string | undefined;
            const keyValue = ctx.args.key_value as string | undefined;
            if (!keyName || !keyValue) {
              return { success: false, output: 'set_key requires key_name and key_value' };
            }
            if (!/^[A-Z][A-Z0-9_]*$/.test(keyName)) {
              return { success: false, output: `Invalid key name "${keyName}". Must be UPPER_SNAKE_CASE (e.g. WEATHER_API_KEY).` };
            }
            db.setRuntimeKey(keyName, keyValue);
            process.env[keyName] = keyValue;
            await registry.reloadFromDisk();
            return { success: true, output: `Key "${keyName}" set. Skills requiring it are now available.` };
          }
          case 'remove_key': {
            const keyName = ctx.args.key_name as string | undefined;
            if (!keyName) {
              return { success: false, output: 'remove_key requires key_name' };
            }
            db.deleteRuntimeKey(keyName);
            delete process.env[keyName];
            await registry.reloadFromDisk();
            return { success: true, output: `Key "${keyName}" removed.` };
          }
          default:
            return { success: false, output: `Unknown action: ${action}. Use search, install, uninstall, list, set_key, or remove_key.` };
        }
      })
      .build();
    this.skillRegistry.registerSkill(skill.skill);
  }

  /**
   * Background bash exits become `[bash-done ...]` messages: steering into a
   * running turn, or a new turn whose reply goes out through the outbound
   * queue like any other proactive result.
   */
  private wireBashDoneNotices(): void {
    if (this.bashDoneListener) backgroundProcesses.off('exit', this.bashDoneListener);
    const lane = (sessionId: string) => `session:${sessionId}`;
    const route = createBashDoneRouter({
      isBusy: (sessionId) => laneIsBusy(lane(sessionId)),
      enqueueSteering: (sessionId, text) => {
        this.interruptQueue?.enqueue({ sessionId, text, timestamp: Date.now() });
      },
      waitForIdle: (sessionId) => enqueueInLane(lane(sessionId), async () => {}),
      takeSteering: (sessionId, text) => {
        if (!this.interruptQueue) return false;
        const pending = this.interruptQueue.drain(sessionId);
        const index = pending.findIndex(entry => entry.text === text);
        pending.forEach((entry, i) => { if (i !== index) this.interruptQueue!.enqueue(entry); });
        return index >= 0;
      },
      runTurn: async (sessionId, text) => {
        if (!this.agent) return undefined;
        return (await this.agent.processMessage(sessionId, text)).response;
      },
      deliver: async (userId, text, sessionId) => {
        const handler = this.outboundQueue?.createHandler();
        if (!handler) return this.handleProactiveMessage(userId, text);
        return handler(userId, text, {
          scheduledItemId: `bash-done:${sessionId}:${Date.now()}`,
          ownerUserId: userId,
          // The reply is the agent's own finished turn: deliver it as written.
          outcome: { source: 'task_result', sessionId, explicitUserText: true, evidenceVerified: true },
        });
      },
      isSubAgentSession: async (sessionId) => {
        const session = await this.sessionManager?.getSession(sessionId);
        return session?.metadata?.isSubAgent === true;
      },
      logger: this.logger,
    });
    this.bashDoneListener = (e) => { void route(e); };
    backgroundProcesses.on('exit', this.bashDoneListener);
  }

  /**
   * Resolve which trigger source to use for a given userId.
   * Supports prefixed userIds (e.g., "telegram:12345", "api:ws-abc123").
   * Falls back to first available trigger source if no prefix or unknown channel.
   */
  private resolveTriggerSource(userId: string): { source: TriggerSource | null; rawUserId: string } {
    const { channel, rawUserId } = parseUserIdPrefix(userId);
    const allowedTelegramUsers = this.config.channels.telegram.allowedUsers ?? [];

    // An explicit channel is an authorization boundary, not a preference. If
    // that transport is unavailable, never fall through to another person's
    // Telegram chat merely because Telegram happens to be running.
    if (channel) {
      const source = this.triggerSources.get(channel);
      if (!source) {
        this.logger.warn({ channel, userId: rawUserId }, 'Requested trigger source is unavailable; refusing cross-channel fallback');
        return { source: null, rawUserId };
      }

      if (channel === 'telegram') {
        if (rawUserId === 'default') {
          if (allowedTelegramUsers.length !== 1) {
            this.logger.warn(
              { allowedUserCount: allowedTelegramUsers.length },
              'Cannot resolve default Telegram recipient unambiguously',
            );
            return { source: null, rawUserId };
          }
          return { source, rawUserId: allowedTelegramUsers[0] };
        }
        if (allowedTelegramUsers.length > 0 && !allowedTelegramUsers.includes(rawUserId)) {
          this.logger.warn({ userId: rawUserId }, 'Refusing Telegram delivery outside the configured allowlist');
          return { source: null, rawUserId };
        }
      }

      const chat = this.chatChannels.find(c => c.name === channel);
      if (chat) {
        if (rawUserId === 'default') {
          const sole = chat.soleRecipient();
          if (!sole) {
            this.logger.warn({ channel }, 'Cannot resolve default recipient unambiguously');
            return { source: null, rawUserId };
          }
          return { source, rawUserId: sole };
        }
        if (!chat.isAllowedRecipient(rawUserId)) {
          this.logger.warn({ channel, userId: rawUserId }, 'Refusing delivery outside the channel allowlist');
          return { source: null, rawUserId };
        }
      }

      this.logger.debug({ channel, userId: rawUserId }, 'Using prefixed trigger source');
      return { source, rawUserId };
    }

    // Canonical default can route to Telegram only for one explicit owner. An
    // API-only deployment may safely keep its own default identity.
    if (rawUserId === 'default') {
      const telegram = this.triggerSources.get('telegram');
      if (telegram && allowedTelegramUsers.length === 1) {
        return { source: telegram, rawUserId: allowedTelegramUsers[0] };
      }
      // Without Telegram, a single chat channel with exactly one allowlisted
      // recipient is just as unambiguous.
      const soleChats = telegram ? [] : this.chatChannels.filter(c => c.soleRecipient() !== null);
      if (soleChats.length === 1) {
        const source = this.triggerSources.get(soleChats[0].name);
        if (source) return { source, rawUserId: soleChats[0].soleRecipient()! };
      }
      const api = this.triggerSources.get('api');
      if (api && !telegram) return { source: api, rawUserId };
      this.logger.warn(
        { allowedUserCount: allowedTelegramUsers.length, sourceCount: this.triggerSources.size },
        'Cannot resolve unprefixed default recipient unambiguously',
      );
      return { source: null, rawUserId };
    }

    // A bare legacy owner ID is safe only when it is an explicitly configured
    // single-owner alias, or when exactly one transport exists.
    const telegram = this.triggerSources.get('telegram');
    if (telegram && this.canonicalSingleUserIds.includes(rawUserId)) {
      return { source: telegram, rawUserId };
    }
    if (this.triggerSources.size === 1) {
      const source = this.triggerSources.values().next().value as TriggerSource;
      return { source, rawUserId };
    }

    this.logger.warn({ userId: rawUserId }, 'Cannot resolve unprefixed recipient across multiple transports');
    return { source: null, rawUserId };
  }

  /** drainSubAgentDeliveries with the outer claim/release path guarded. */
  private async drainSubAgentDeliveriesSafely(): Promise<void> {
    try {
      await this.drainSubAgentDeliveries();
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message },
        'Sub-agent delivery drain failed'
      );
    }
  }

  /**
   * Lease durable child completions and hand them to the session waker. An
   * idle parent gets a new turn carrying `[agent-result: name] …` (it reacts
   * and replies to the user); a busy parent receives the same text from the
   * announce queue at its next iteration and the waker drops its copy.
   * Children of sub-agents are resumed by the executor itself.
   */
  private async drainSubAgentDeliveries(): Promise<void> {
    const db = this.scallopMemoryStore?.getDatabase();
    if (!db || !this.sessionManager || !this.sessionWaker) return;
    const deliveries = db.claimSubAgentDeliveries(10, 30_000);
    for (const delivery of deliveries) {
      if (!delivery.leaseToken) continue;
      try {
        const payload = JSON.parse(delivery.payloadJson) as {
          runId: string;
          label: string;
          kind?: string;
          message?: string;
          result?: { status?: string; summary?: string; blockers?: string[] };
        };
        const parentId = delivery.parentSessionId;
        const parent = await this.sessionManager.getSession(parentId);
        const runFooter = `[run ${payload.runId}]`;
        const legacyMarker = `[Sub-agent result:${payload.runId}]`;
        const alreadyInjected = parent?.messages.some(message =>
          typeof message.content === 'string'
          && (message.content.includes(runFooter) || message.content.startsWith(legacyMarker)),
        );
        if (parent && !parent.metadata?.isSubAgent && !alreadyInjected) {
          const message = payload.message
            ?? formatAgentResult(payload.label, [
              payload.result?.summary ?? '',
              ...(payload.result?.blockers ?? []).map(blocker => `Blocker: ${blocker}`),
            ].join('\n'), { runId: payload.runId });
          const announceQueue = this.announceQueue;
          this.sessionWaker.wake(parentId, message, {
            kind: payload.kind === 'agent-exited' ? 'agent-exited' : 'agent-result',
            isPending: () => !announceQueue?.wasDrained(parentId, payload.runId),
            claim: () => { announceQueue?.acknowledge(parentId, payload.runId); },
          });
        }
        db.completeSubAgentDelivery(delivery.runId, delivery.leaseToken);
      } catch (error) {
        db.failSubAgentDelivery(delivery.runId, delivery.leaseToken, (error as Error).message);
        this.logger.warn({ runId: delivery.runId, error: (error as Error).message }, 'Sub-agent delivery deferred');
      }
    }
  }

  /**
   * Start a parent turn for harness messages (agent results, background bash)
   * while the session is idle. Returns 'started', 'queued' (busy: retried when
   * idle unless the running turn consumes it first) or 'unavailable'.
   */
  onIdleWake(sessionId: string, message: string, opts: WakeOptions = { kind: 'wake' }): WakeOutcome | 'unavailable' {
    return this.sessionWaker ? this.sessionWaker.wake(sessionId, message, opts) : 'unavailable';
  }

  /** One wake turn: run the parent agent and deliver its reply to the user's channel. */
  private async runWakeTurn(request: WakeTurnRequest): Promise<void> {
    if (!this.agent || !this.sessionManager) return;
    const session = await this.sessionManager.getSession(request.sessionId);
    if (!session) return;
    // Progress notes that piled up while idle are stale once the result is here.
    this.announceQueue?.dropProgress(request.sessionId);
    this.logger.info({ sessionId: request.sessionId, kinds: request.kinds }, 'Waking idle session');
    const result = await this.agent.processMessage(request.sessionId, request.message);
    const reply = result.response?.trim();
    const userId = typeof session.metadata?.userId === 'string' ? session.metadata.userId : undefined;
    if (!reply || !userId) return;
    const sent = await this.handleProactiveMessage(userId, reply);
    if (!sent || (!messageWasDelivered(sent) && !isMessageDeliverySuppressed(sent))) {
      this.logger.warn({ sessionId: request.sessionId }, 'Wake turn reply was not delivered');
    }
  }

  /**
   * Handle sending a proactive message to a user
   * Used by TriggerEvaluator for agent-initiated messages
   */
  private async handleProactiveMessage(userId: string, message: string): Promise<MessageDeliveryResult> {
    this.logger.debug({ userId, messageLength: message.length }, 'Sending proactive message');

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(userId);

    if (!triggerSource) {
      this.logger.warn({ userId }, 'No trigger source available for proactive message');
      return false;
    }

    try {
      return await triggerSource.sendMessage(rawUserId, message);
    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  /**
   * Handle sending a file to a user
   * Uses trigger source abstraction for multi-channel support
   */
  private async handleFileSend(
    userId: string,
    filePath: string,
    caption?: string,
    sessionId?: string,
    activeRequest?: string,
  ): Promise<boolean> {
    this.logger.info({ userId, filePath }, 'Sending file to user');

    if (this.outcomeBrain) {
      const decision = await this.outcomeBrain.decideFile({
        userId,
        sessionId,
        filePath,
        caption,
        activeRequest,
      });
      if (!decision.approved) return false;
      caption = decision.caption;
    }

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

    // Progress updates go out as the model wrote them, minus private reasoning.
    message = stripThinkTags(message).trim();
    if (!message) return false;

    const { source: triggerSource, rawUserId } = this.resolveTriggerSource(userId);

    if (triggerSource) {
      this.logger.debug({ triggerSource: triggerSource.getName(), userId: rawUserId }, 'Using trigger source for message send');
      return messageWasDelivered(await triggerSource.sendMessage(rawUserId, message));
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
