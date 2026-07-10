import { z } from 'zod';
import dotenv from 'dotenv';
import { parseModelRef, DEFAULT_MODELS, type ModelRef, type ModelsConfig } from './model-routing.js';
import { DEFAULT_EVOLUTION_CONFIG } from '../evolution/config.js';

// Load environment variables from .env file
dotenv.config();

// Shared defaults (single source of truth)
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_API_PORT = 3000;

/** Parse an integer env var, falling back to a default when unset/invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a float env var, falling back to a default when unset/invalid. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

const modelPricingSchema = z.object({
  inputPerMillion: z.number().min(0),
  outputPerMillion: z.number().min(0),
});

function parseCostModelPricingEnv(): Record<string, z.infer<typeof modelPricingSchema>> {
  const raw = process.env.COST_MODEL_PRICING;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, z.infer<typeof modelPricingSchema>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = modelPricingSchema.parse(value);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`COST_MODEL_PRICING must be JSON like {"provider/model":{"inputPerMillion":1,"outputPerMillion":2}}: ${message}`);
  }
}

// Provider configuration schemas
const anthropicProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('claude-sonnet-4-20250514'),
});

const openaiProviderSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().optional(),
  model: z.string().default('gpt-4.1'),
});

const groqProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('llama-3.3-70b-versatile'),
});

const ollamaProviderSchema = z.object({
  baseUrl: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  model: z.string().default('llama3.2'),
});

const openrouterProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('anthropic/claude-3.5-sonnet'),
});

const moonshotProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('kimi-k2.5'),
  /** Enable extended thinking mode for Kimi K2.5 (uses more tokens, better reasoning) */
  enableThinking: z.boolean().default(true),
});

const xaiProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('grok-4'),
});

const providersSchema = z.object({
  anthropic: anthropicProviderSchema,
  openai: openaiProviderSchema.default({ apiKey: '', model: 'gpt-4o' }),
  groq: groqProviderSchema.default({ apiKey: '', model: 'llama-3.3-70b-versatile' }),
  ollama: ollamaProviderSchema.default({ baseUrl: DEFAULT_OLLAMA_BASE_URL, model: 'llama3.2' }),
  openrouter: openrouterProviderSchema.default({ apiKey: '', model: 'anthropic/claude-3.5-sonnet' }),
  moonshot: moonshotProviderSchema.default({ apiKey: '', model: 'kimi-k2.5', enableThinking: true }),
  xai: xaiProviderSchema.default({ apiKey: '', model: 'grok-4' }),
});

// Channel configuration schemas
const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  /** Comma-separated list of allowed Telegram user IDs. Empty = allow all */
  allowedUsers: z.array(z.string()).default([]),
  /** Enable voice reply when receiving voice messages */
  enableVoiceReply: z.boolean().default(false),
});

const discordChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  applicationId: z.string().default(''),
});

const apiChannelSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(DEFAULT_API_PORT),
  host: z.string().default(DEFAULT_HOST),
  apiKey: z.string().optional(),
});

const channelsSchema = z.object({
  telegram: telegramChannelSchema,
  discord: discordChannelSchema.default({ enabled: false, botToken: '', applicationId: '' }),
  api: apiChannelSchema.default({ enabled: false, port: DEFAULT_API_PORT, host: DEFAULT_HOST }),
});

// Agent configuration schema
const agentSchema = z.object({
  workspace: z.string().min(1, 'Workspace path is required'),
  maxIterations: z.number().int().positive().default(100),
});

// Logging configuration schema
const loggingSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

// Routing configuration schema (M2: Smart Routing)
const routingSchema = z.object({
  providerOrder: z.array(z.string()).default(['anthropic', 'openai', 'groq', 'ollama']),
  enableComplexityAnalysis: z.boolean().default(true),
});

// Cost tracking configuration schema (M2: Cost Tracking)
const costSchema = z.object({
  dailyBudget: z.number().positive().optional(),
  monthlyBudget: z.number().positive().optional(),
  warningThreshold: z.number().min(0).max(1).default(0.75),
  customPricing: z.record(z.string(), modelPricingSchema).default({}),
});

const eventRelaySchema = z.object({
  webhookUrl: z.string().url().optional(),
  webhookSecret: z.string().optional(),
  webhookTimeoutMs: z.number().int().positive().default(5000),
  agentId: z.string().min(1).default('scallopbot'),
});

// Context management configuration schema (M2: Sliding Window)
const contextSchema = z.object({
  hotWindowSize: z.number().int().positive().default(200),
  maxContextTokens: z.number().int().positive().default(128000),
  compressionThreshold: z.number().min(0).max(1).default(0.7),
  maxToolOutputBytes: z.number().int().positive().default(30000),
});

// Memory configuration schema
const memorySchema = z.object({
  /** Path to legacy JSONL memory file (kept for migration, relative to workspace) */
  filePath: z.string().default('memories.jsonl'),
  /** Enable memory persistence (default: true) */
  persist: z.boolean().default(true),
  /** Path to SQLite database (relative to workspace) */
  dbPath: z.string().default('memories.db'),
  /** Enable MMR (Maximal Marginal Relevance) for search diversity */
  mmrEnabled: z.boolean().default(false),
  /** MMR lambda: balance between relevance (1.0) and diversity (0.0) */
  mmrLambda: z.number().min(0).max(1).default(0.7),
});

// Tool policy configuration schema
const toolPolicyEntrySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const toolPolicySchema = z.object({
  /** Global tool policy — owner-controlled defaults */
  policy: toolPolicyEntrySchema.optional(),
  /** Per-channel tool policies */
  channelPolicies: z.record(z.string(), toolPolicyEntrySchema).optional(),
});

// Gateway configuration schema
const gatewaySchema = z.object({
  port: z.number().int().positive().default(DEFAULT_API_PORT),
  host: z.string().default(DEFAULT_HOST),
});

// Tailscale configuration schema
const tailscaleSchema = z.object({
  mode: z.enum(['off', 'serve', 'funnel']).default('off'),
  hostname: z.string().optional(),
  port: z.number().int().positive().optional(),
  resetOnExit: z.boolean().default(true),
});

// Sub-agent configuration schema
const subagentSchema = z.object({
  maxConcurrentPerSession: z.number().int().positive().default(3),
  maxConcurrentGlobal: z.number().int().positive().default(5),
  defaultTimeoutSeconds: z.number().int().positive().default(120),
  maxTimeoutSeconds: z.number().int().positive().default(300),
  defaultModelTier: z.enum(['fast', 'standard', 'capable']).default('fast'),
  maxIterations: z.number().int().positive().default(20),
  cleanupAfterSeconds: z.number().int().positive().default(3600),
  allowMemoryWrites: z.boolean().default(false),
});

// Per-purpose model routing schema (single place each LLM job picks its model).
// See src/config/model-routing.ts for the resolver. Defaults preserve the prior
// inline behavior exactly; each is overridable via MODEL_<PURPOSE> env vars.
const modelRefSchema = z.union([
  z.object({ use: z.enum(['main', 'background']) }),
  z.object({ tier: z.enum(['fast', 'standard', 'capable']) }),
  z.object({ provider: z.string().min(1), model: z.string().optional() }),
]);

// Operational tuning knobs — the central, env-overridable surface for the
// constants an operator actually adjusts. Deep algorithm internals (decay rates,
// emotion-lexicon weights, compaction char thresholds) intentionally stay in
// their module homes. Defaults equal the prior hardcoded values exactly.
const TUNING_DEFAULTS = {
  gardener: {
    lightIntervalMs: 60_000,
    deepIntervalMs: 72 * 60 * 1000,
    sleepIntervalMs: 20 * 60 * 60 * 1000,
    quietHoursStart: 2,
    quietHoursEnd: 5,
  },
  critic: { bestOfN: 1, bestOfNThreshold: 0.85 },
  skills: { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
};

const tuningSchema = z.object({
  gardener: z
    .object({
      /** Light-tick (decay) cadence. */
      lightIntervalMs: z.number().int().positive().default(TUNING_DEFAULTS.gardener.lightIntervalMs),
      /** Deep-tick (summaries, behavioral inference, proactive) cadence. */
      deepIntervalMs: z.number().int().positive().default(TUNING_DEFAULTS.gardener.deepIntervalMs),
      /** Sleep-tick (dream/reflection) cadence. */
      sleepIntervalMs: z.number().int().positive().default(TUNING_DEFAULTS.gardener.sleepIntervalMs),
      /** Quiet-hours window for the sleep tick (local hour, 0-23). */
      quietHoursStart: z.number().int().min(0).max(23).default(TUNING_DEFAULTS.gardener.quietHoursStart),
      quietHoursEnd: z.number().int().min(0).max(23).default(TUNING_DEFAULTS.gardener.quietHoursEnd),
    })
    .default(TUNING_DEFAULTS.gardener),
  critic: z
    .object({
      /** Best-of-N candidate count for the main loop (1 = disabled). */
      bestOfN: z.number().int().positive().default(TUNING_DEFAULTS.critic.bestOfN),
      /** Quality bar below which best-of-N resampling kicks in. */
      bestOfNThreshold: z.number().min(0).max(1).default(TUNING_DEFAULTS.critic.bestOfNThreshold),
    })
    .default(TUNING_DEFAULTS.critic),
  skills: z
    .object({
      /** Default skill-script execution timeout. */
      timeoutMs: z.number().int().positive().default(TUNING_DEFAULTS.skills.timeoutMs),
      /** Max captured stdout/stderr per skill run. */
      maxOutputBytes: z.number().int().positive().default(TUNING_DEFAULTS.skills.maxOutputBytes),
    })
    .default(TUNING_DEFAULTS.skills),
});

// Self-evolution engine config. The model it runs on lives in models.evolution;
// these are the feature toggle + capture/optimizer thresholds.
const evolutionSchema = z.object({
  enabled: z.boolean().default(DEFAULT_EVOLUTION_CONFIG.enabled),
  minToolCalls: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.minToolCalls),
  reusableScoreBar: z.number().min(0).max(1).default(DEFAULT_EVOLUTION_CONFIG.reusableScoreBar),
  lowQualityThreshold: z.number().min(0).max(1).default(DEFAULT_EVOLUTION_CONFIG.lowQualityThreshold),
  maxProposals: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.maxProposals),
  fitnessEpsilon: z.number().min(0).max(1).default(DEFAULT_EVOLUTION_CONFIG.fitnessEpsilon),
  requireFitnessGate: z.literal(true).default(true),
  includeSessionContent: z.boolean().default(DEFAULT_EVOLUTION_CONFIG.includeSessionContent),
  allowSeparateEvalProvider: z.boolean().default(DEFAULT_EVOLUTION_CONFIG.allowSeparateEvalProvider),
  rollbackWindow: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.rollbackWindow),
  useLlmJudge: z.boolean().default(DEFAULT_EVOLUTION_CONFIG.useLlmJudge),
  curatorEnabled: z.boolean().default(DEFAULT_EVOLUTION_CONFIG.curatorEnabled),
  curatorStaleDays: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.curatorStaleDays),
  curatorArchiveDays: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.curatorArchiveDays),
  curatorBackupKeep: z.number().int().positive().default(DEFAULT_EVOLUTION_CONFIG.curatorBackupKeep),
});

const modelsSchema = z.object({
  reranker: modelRefSchema.default(DEFAULT_MODELS.reranker),
  factExtraction: modelRefSchema.default(DEFAULT_MODELS.factExtraction),
  cognition: modelRefSchema.default(DEFAULT_MODELS.cognition),
  critic: modelRefSchema.default(DEFAULT_MODELS.critic),
  evolution: modelRefSchema.default(DEFAULT_MODELS.evolution),
  eval: modelRefSchema.default(DEFAULT_MODELS.eval),
});

// Multi-model mode: user-defined OpenAI-compatible endpoints, each registered as
// a provider under its own name. Lets one ScallopBot route different purposes to
// different models (e.g. a fine-tuned memory model + a fine-tuned tools model on
// a local llama-server) instead of one model for everything. Off by default —
// a single-model setup needs none of this.
const customProviderSchema = z.object({
  /** Registry name; usable in PROVIDER_ORDER and MODEL_<PURPOSE> refs. */
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, _ and - only; must start with a letter'),
  /** OpenAI-compatible /v1 endpoint, e.g. http://localhost:11434/v1 */
  baseUrl: z.string().url(),
  /** Model id to request from the endpoint. */
  model: z.string().min(1),
  /** Bearer key. Local llama-server-style endpoints accept any non-empty value. */
  apiKey: z.string().min(1).default('sk-local'),
});

const multiModelSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(customProviderSchema).default([]),
});

/** Built-in provider names that CUSTOM_PROVIDER_* entries may not shadow. */
export const RESERVED_PROVIDER_NAMES = new Set([
  'anthropic', 'openai', 'local', 'groq', 'ollama', 'openrouter', 'moonshot', 'xai',
]);

// Main configuration schema
export const configSchema = z.object({
  providers: providersSchema,
  models: modelsSchema.default(DEFAULT_MODELS),
  // Purposes explicitly pinned via MODEL_<PURPOSE> — excluded from the runtime
  // /model switch so memory/tools can stay on a separate model.
  modelPins: z.array(z.string()).default([]),
  multiModel: multiModelSchema.default({ enabled: false, providers: [] }),
  tuning: tuningSchema.default(TUNING_DEFAULTS),
  evolution: evolutionSchema.default({ ...DEFAULT_EVOLUTION_CONFIG, requireFitnessGate: true as const }),
  channels: channelsSchema,
  agent: agentSchema,
  logging: loggingSchema.default({ level: 'info' }),
  routing: routingSchema.default({ providerOrder: ['anthropic', 'openai', 'groq', 'ollama'], enableComplexityAnalysis: true }),
  cost: costSchema.default({ warningThreshold: 0.75, customPricing: {} }),
  eventRelay: eventRelaySchema.default({ webhookTimeoutMs: 5000, agentId: 'scallopbot' }),
  context: contextSchema.default({ hotWindowSize: 200, maxContextTokens: 128000, compressionThreshold: 0.7, maxToolOutputBytes: 30000 }),
  memory: memorySchema.default({ filePath: 'memories.jsonl', persist: true, dbPath: 'memories.db', mmrEnabled: false, mmrLambda: 0.7 }),
  tools: toolPolicySchema.default({}),
  gateway: gatewaySchema.default({ port: DEFAULT_API_PORT, host: DEFAULT_HOST }),
  tailscale: tailscaleSchema.default({ mode: 'off', resetOnExit: true }),
  subagent: subagentSchema.default({
    maxConcurrentPerSession: 3,
    maxConcurrentGlobal: 5,
    defaultTimeoutSeconds: 120,
    maxTimeoutSeconds: 300,
    defaultModelTier: 'fast' as const,
    maxIterations: 20,
    cleanupAfterSeconds: 3600,
    allowMemoryWrites: false,
  }),
});

// Type inference from schema
export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providersSchema>;
export type MultiModelConfig = z.infer<typeof multiModelSchema>;
export type CustomProviderConfig = z.infer<typeof customProviderSchema>;
export type { ModelsConfig, ModelRef } from './model-routing.js';
export type ChannelConfig = z.infer<typeof channelsSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type RoutingConfig = z.infer<typeof routingSchema>;
export type CostConfig = z.infer<typeof costSchema>;
export type EventRelayConfig = z.infer<typeof eventRelaySchema>;
export type ContextConfig = z.infer<typeof contextSchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type GatewayConfig = z.infer<typeof gatewaySchema>;
export type TailscaleConfig = z.infer<typeof tailscaleSchema>;
export type SubagentConfig = z.infer<typeof subagentSchema>;
export type ToolPolicyConfig = z.infer<typeof toolPolicySchema>;
export type TuningConfig = z.infer<typeof tuningSchema>;
export type EvolutionConfigSchema = z.infer<typeof evolutionSchema>;

/**
 * Load configuration from environment variables
 * @returns Validated configuration object
 * @throws Error if configuration is invalid
 */
export function loadConfig(): Config {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordAppId = process.env.DISCORD_APPLICATION_ID;
  const workspace = process.env.AGENT_WORKSPACE || process.cwd();
  const maxIterations = process.env.AGENT_MAX_ITERATIONS
    ? parseInt(process.env.AGENT_MAX_ITERATIONS, 10)
    : 100;
  const logLevel = process.env.LOG_LEVEL || 'info';
  const parsePolicyJson = (name: string): unknown => {
    const raw = process.env[name];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`${name}: expected valid JSON (${(error as Error).message})`);
    }
  };

  // Multi-model mode: CUSTOM_PROVIDER_<NAME>="<baseUrl>|<model>[|<apiKey>]".
  // Always parsed (so a typo fails fast at startup), only registered by the
  // gateway when MULTI_MODEL_ENABLED=true. Parsed before the MODEL switch below
  // so that switch can validate against custom provider names too.
  const customProviders: Array<{ name: string; baseUrl: string; model: string; apiKey?: string }> = [];
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith('CUSTOM_PROVIDER_') || !raw) continue;
    const name = key.slice('CUSTOM_PROVIDER_'.length).toLowerCase();
    if (RESERVED_PROVIDER_NAMES.has(name)) {
      throw new Error(`${key}: "${name}" shadows a built-in provider — pick another name`);
    }
    const [baseUrl, model, apiKey] = raw.split('|').map((s) => s.trim());
    if (!baseUrl || !model) {
      throw new Error(`${key}: expected "<baseUrl>|<model>[|<apiKey>]", got "${raw}"`);
    }
    customProviders.push({ name, baseUrl, model, ...(apiKey && { apiKey }) });
  }

  // ── Single switch: MODEL ──────────────────────────────────────────────────
  // One var points the WHOLE bot at a model/provider: the chat provider chain
  // AND every background purpose (reranker, fact-extraction, cognition, critic,
  // evolution, eval). It's a global default — more specific settings still win:
  //   chat:    PROVIDER_ORDER   > MODEL > built-in chain
  //   purpose: MODEL_<PURPOSE>  > MODEL > built-in per-purpose default
  // Value is a provider name (built-in or a CUSTOM_PROVIDER_* name), optionally
  // "provider:model". Typos fail fast.
  const globalModelRef = parseModelRef(process.env.MODEL);
  if (globalModelRef && 'provider' in globalModelRef) {
    const knownProviders = new Set<string>([
      ...RESERVED_PROVIDER_NAMES,
      ...customProviders.map((p) => p.name),
    ]);
    if (!knownProviders.has(globalModelRef.provider)) {
      throw new Error(
        `MODEL="${process.env.MODEL}": unknown provider "${globalModelRef.provider}". ` +
        `Use a built-in (${[...RESERVED_PROVIDER_NAMES].sort().join(', ')}) or a CUSTOM_PROVIDER_* name.`,
      );
    }
  }

  // Per-purpose model config. Precedence: MODEL_<PURPOSE> env > MODEL global
  // switch > built-in default (zod fills unset keys from DEFAULT_MODELS, so
  // default behavior is unchanged when neither MODEL nor MODEL_<PURPOSE> is set).
  const modelsRaw: Partial<Record<keyof ModelsConfig, ModelRef>> = {};
  const ALL_PURPOSES: (keyof ModelsConfig)[] = [
    'reranker', 'factExtraction', 'cognition', 'critic', 'evolution', 'eval',
  ];
  if (globalModelRef) {
    for (const key of ALL_PURPOSES) modelsRaw[key] = globalModelRef;
  }
  // Purposes explicitly pinned via MODEL_<PURPOSE>. These are excluded from the
  // runtime /model switch so memory/tools can be kept on a separate model.
  const modelPins: (keyof ModelsConfig)[] = [];
  const addModelOverride = (key: keyof ModelsConfig, envVar: string): void => {
    const ref = parseModelRef(process.env[envVar]);
    if (ref) {
      modelsRaw[key] = ref;
      modelPins.push(key);
    }
  };
  addModelOverride('reranker', 'MODEL_RERANKER');
  addModelOverride('factExtraction', 'MODEL_FACT_EXTRACTION');
  addModelOverride('cognition', 'MODEL_COGNITION');
  addModelOverride('critic', 'MODEL_CRITIC');
  addModelOverride('evolution', 'MODEL_EVOLUTION');
  addModelOverride('eval', 'MODEL_EVAL');

  const rawConfig = {
    models: modelsRaw,
    modelPins,
    multiModel: {
      enabled: process.env.MULTI_MODEL_ENABLED === 'true',
      providers: customProviders,
    },
    tuning: {
      gardener: {
        lightIntervalMs: envInt('GARDENER_LIGHT_INTERVAL_MS', 60_000),
        deepIntervalMs: envInt('GARDENER_DEEP_INTERVAL_MS', 72 * 60 * 1000),
        sleepIntervalMs: envInt('GARDENER_SLEEP_INTERVAL_MS', 20 * 60 * 60 * 1000),
        quietHoursStart: envInt('GARDENER_QUIET_HOURS_START', 2),
        quietHoursEnd: envInt('GARDENER_QUIET_HOURS_END', 5),
      },
      critic: {
        bestOfN: envInt('BEST_OF_N', 1),
        bestOfNThreshold: envFloat('BEST_OF_N_THRESHOLD', 0.85),
      },
      skills: {
        timeoutMs: envInt('SKILL_TIMEOUT_MS', 120_000),
        maxOutputBytes: envInt('SKILL_MAX_OUTPUT_BYTES', 1024 * 1024),
      },
    },
    evolution: {
      enabled: process.env.EVOLUTION_ENABLED === 'true',
      minToolCalls: envInt('EVOLUTION_MIN_TOOL_CALLS', DEFAULT_EVOLUTION_CONFIG.minToolCalls),
      reusableScoreBar: envFloat('EVOLUTION_REUSABLE_SCORE_BAR', DEFAULT_EVOLUTION_CONFIG.reusableScoreBar),
      lowQualityThreshold: envFloat('EVOLUTION_LOW_QUALITY_THRESHOLD', DEFAULT_EVOLUTION_CONFIG.lowQualityThreshold),
      maxProposals: envInt('EVOLUTION_MAX_PROPOSALS', DEFAULT_EVOLUTION_CONFIG.maxProposals),
      fitnessEpsilon: envFloat('EVOLUTION_FITNESS_EPSILON', DEFAULT_EVOLUTION_CONFIG.fitnessEpsilon),
      requireFitnessGate: true,
      includeSessionContent: process.env.EVOLUTION_INCLUDE_SESSION_CONTENT === 'true',
      allowSeparateEvalProvider: process.env.EVOLUTION_ALLOW_SEPARATE_EVAL_PROVIDER === 'true',
      rollbackWindow: envInt('EVOLUTION_ROLLBACK_WINDOW', DEFAULT_EVOLUTION_CONFIG.rollbackWindow),
      useLlmJudge: process.env.EVOLUTION_USE_LLM_JUDGE !== 'false',
      curatorEnabled: process.env.EVOLUTION_CURATOR_ENABLED !== 'false',
      curatorStaleDays: envInt('EVOLUTION_CURATOR_STALE_DAYS', DEFAULT_EVOLUTION_CONFIG.curatorStaleDays),
      curatorArchiveDays: envInt('EVOLUTION_CURATOR_ARCHIVE_DAYS', DEFAULT_EVOLUTION_CONFIG.curatorArchiveDays),
      curatorBackupKeep: envInt('EVOLUTION_CURATOR_BACKUP_KEEP', DEFAULT_EVOLUTION_CONFIG.curatorBackupKeep),
    },
    providers: {
      anthropic: {
        apiKey: anthropicApiKey,
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      },
      openai: {
        apiKey: openaiApiKey || '',
        baseUrl: process.env.OPENAI_BASE_URL || undefined,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
      },
      groq: {
        apiKey: groqApiKey || '',
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      },
      ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
        model: process.env.OLLAMA_MODEL || 'llama3.2',
      },
      openrouter: {
        apiKey: openrouterApiKey || '',
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
      },
      moonshot: {
        apiKey: process.env.MOONSHOT_API_KEY || '',
        model: process.env.MOONSHOT_MODEL || 'kimi-k2.5',
        enableThinking: process.env.KIMI_THINKING_ENABLED !== 'false',
      },
      xai: {
        apiKey: process.env.XAI_API_KEY || '',
        model: process.env.XAI_MODEL || 'grok-4',
      },
    },
    channels: {
      telegram: {
        enabled: !!telegramBotToken,
        botToken: telegramBotToken || '',
        allowedUsers: process.env.TELEGRAM_ALLOWED_USERS
          ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map((id) => id.trim()).filter(Boolean)
          : [],
        enableVoiceReply: process.env.TELEGRAM_VOICE_REPLY === 'true',
      },
      discord: {
        enabled: !!discordBotToken,
        botToken: discordBotToken || '',
        applicationId: discordAppId || '',
      },
      api: {
        enabled: process.env.WEB_UI_ENABLED === 'true',
        port: process.env.WEB_UI_PORT ? parseInt(process.env.WEB_UI_PORT, 10) : DEFAULT_API_PORT,
        host: process.env.WEB_UI_HOST || DEFAULT_HOST,
        apiKey: process.env.WEB_UI_API_KEY || undefined,
      },
    },
    agent: {
      workspace,
      maxIterations,
    },
    logging: {
      level: logLevel,
    },
    routing: {
      // Chat provider chain. Precedence: explicit PROVIDER_ORDER > MODEL single
      // switch (as a one-provider chain) > built-in default chain.
      providerOrder: process.env.PROVIDER_ORDER
        ? process.env.PROVIDER_ORDER.split(',').map((p) => p.trim())
        : globalModelRef && 'provider' in globalModelRef
          ? [globalModelRef.provider]
          : ['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama'],
      enableComplexityAnalysis: process.env.ENABLE_COMPLEXITY_ANALYSIS !== 'false',
    },
    cost: {
      dailyBudget: process.env.DAILY_BUDGET ? parseFloat(process.env.DAILY_BUDGET) || undefined : undefined,
      monthlyBudget: process.env.MONTHLY_BUDGET ? parseFloat(process.env.MONTHLY_BUDGET) || undefined : undefined,
      warningThreshold: process.env.BUDGET_WARNING_THRESHOLD
        ? parseFloat(process.env.BUDGET_WARNING_THRESHOLD) || 0.75
        : 0.75,
      customPricing: parseCostModelPricingEnv(),
    },
    eventRelay: {
      webhookUrl: process.env.SCALLOPBOT_EVENT_WEBHOOK_URL || undefined,
      webhookSecret: process.env.SCALLOPBOT_EVENT_WEBHOOK_SECRET || undefined,
      webhookTimeoutMs: envInt('SCALLOPBOT_EVENT_WEBHOOK_TIMEOUT_MS', 5000),
      agentId: process.env.SCALLOPBOT_AGENT_ID || 'scallopbot',
    },
    context: {
      hotWindowSize: process.env.HOT_WINDOW_SIZE ? parseInt(process.env.HOT_WINDOW_SIZE, 10) : 200,
      maxContextTokens: process.env.MAX_CONTEXT_TOKENS ? parseInt(process.env.MAX_CONTEXT_TOKENS, 10) : 128000,
      compressionThreshold: process.env.COMPRESSION_THRESHOLD ? parseFloat(process.env.COMPRESSION_THRESHOLD) : 0.7,
      maxToolOutputBytes: process.env.MAX_TOOL_OUTPUT_BYTES ? parseInt(process.env.MAX_TOOL_OUTPUT_BYTES, 10) : 30000,
    },
    memory: {
      filePath: process.env.MEMORY_FILE_PATH || 'memories.jsonl',
      persist: process.env.MEMORY_PERSIST !== 'false',
      dbPath: process.env.MEMORY_DB_PATH || 'memories.db',
      mmrEnabled: process.env.MMR_ENABLED === 'true',
      mmrLambda: process.env.MMR_LAMBDA ? parseFloat(process.env.MMR_LAMBDA) : 0.7,
    },
    tools: {
      policy: parsePolicyJson('TOOL_POLICY_JSON'),
      channelPolicies: parsePolicyJson('TOOL_CHANNEL_POLICIES_JSON'),
    },
    gateway: {
      port: process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : DEFAULT_API_PORT,
      host: process.env.GATEWAY_HOST || DEFAULT_HOST,
    },
    tailscale: {
      mode: (process.env.TAILSCALE_MODE as 'off' | 'serve' | 'funnel') || 'off',
      hostname: process.env.TAILSCALE_HOSTNAME || undefined,
      port: process.env.TAILSCALE_PORT ? parseInt(process.env.TAILSCALE_PORT, 10) : undefined,
      resetOnExit: process.env.TAILSCALE_RESET_ON_EXIT !== 'false',
    },
    subagent: {
      maxConcurrentPerSession: process.env.SUBAGENT_MAX_CONCURRENT_PER_SESSION ? parseInt(process.env.SUBAGENT_MAX_CONCURRENT_PER_SESSION, 10) : 3,
      maxConcurrentGlobal: process.env.SUBAGENT_MAX_CONCURRENT_GLOBAL ? parseInt(process.env.SUBAGENT_MAX_CONCURRENT_GLOBAL, 10) : 5,
      defaultTimeoutSeconds: process.env.SUBAGENT_DEFAULT_TIMEOUT ? parseInt(process.env.SUBAGENT_DEFAULT_TIMEOUT, 10) : 120,
      maxTimeoutSeconds: process.env.SUBAGENT_MAX_TIMEOUT ? parseInt(process.env.SUBAGENT_MAX_TIMEOUT, 10) : 300,
      defaultModelTier: (process.env.SUBAGENT_MODEL_TIER as 'fast' | 'standard' | 'capable') || 'fast',
      maxIterations: process.env.SUBAGENT_MAX_ITERATIONS ? parseInt(process.env.SUBAGENT_MAX_ITERATIONS, 10) : 20,
      cleanupAfterSeconds: process.env.SUBAGENT_CLEANUP_AFTER ? parseInt(process.env.SUBAGENT_CLEANUP_AFTER, 10) : 3600,
      allowMemoryWrites: process.env.SUBAGENT_ALLOW_MEMORY_WRITES === 'true',
    },
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map((err) => `${err.path.map(String).join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errorMessages}`);
  }

  // Validate that at least one LLM provider has an API key
  const providers = result.data.providers;
  const hasProvider =
    providers.anthropic.apiKey ||
    providers.openai.apiKey ||
    providers.groq.apiKey ||
    providers.openrouter.apiKey ||
    providers.moonshot.apiKey ||
    providers.xai.apiKey;

  if (!hasProvider) {
    throw new Error('At least one LLM provider API key is required (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, MOONSHOT_API_KEY, XAI_API_KEY, or OPENROUTER_API_KEY)');
  }

  return result.data;
}

// Export a singleton config instance (lazy loaded)
let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
