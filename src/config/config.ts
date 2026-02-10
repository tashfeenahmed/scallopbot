import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Shared defaults (single source of truth)
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_API_PORT = 3000;

// Provider configuration schemas
const anthropicProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('claude-sonnet-4-20250514'),
});

const openaiProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4o'),
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
});

// Context management configuration schema (M2: Sliding Window)
const contextSchema = z.object({
  hotWindowSize: z.number().int().positive().default(50),
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

// Main configuration schema
export const configSchema = z.object({
  providers: providersSchema,
  channels: channelsSchema,
  agent: agentSchema,
  logging: loggingSchema.default({ level: 'info' }),
  routing: routingSchema.default({ providerOrder: ['anthropic', 'openai', 'groq', 'ollama'], enableComplexityAnalysis: true }),
  cost: costSchema.default({ warningThreshold: 0.75 }),
  context: contextSchema.default({ hotWindowSize: 50, maxContextTokens: 128000, compressionThreshold: 0.7, maxToolOutputBytes: 30000 }),
  memory: memorySchema.default({ filePath: 'memories.jsonl', persist: true, dbPath: 'memories.db' }),
  gateway: gatewaySchema.default({ port: DEFAULT_API_PORT, host: DEFAULT_HOST }),
  tailscale: tailscaleSchema.default({ mode: 'off', resetOnExit: true }),
});

// Type inference from schema
export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providersSchema>;
export type ChannelConfig = z.infer<typeof channelsSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type RoutingConfig = z.infer<typeof routingSchema>;
export type CostConfig = z.infer<typeof costSchema>;
export type ContextConfig = z.infer<typeof contextSchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type GatewayConfig = z.infer<typeof gatewaySchema>;
export type TailscaleConfig = z.infer<typeof tailscaleSchema>;

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

  const rawConfig = {
    providers: {
      anthropic: {
        apiKey: anthropicApiKey,
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      },
      openai: {
        apiKey: openaiApiKey || '',
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
      providerOrder: process.env.PROVIDER_ORDER
        ? process.env.PROVIDER_ORDER.split(',').map((p) => p.trim())
        : ['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama'],
      enableComplexityAnalysis: process.env.ENABLE_COMPLEXITY_ANALYSIS !== 'false',
    },
    cost: {
      dailyBudget: process.env.DAILY_BUDGET ? parseFloat(process.env.DAILY_BUDGET) : undefined,
      monthlyBudget: process.env.MONTHLY_BUDGET ? parseFloat(process.env.MONTHLY_BUDGET) : undefined,
      warningThreshold: process.env.BUDGET_WARNING_THRESHOLD
        ? parseFloat(process.env.BUDGET_WARNING_THRESHOLD)
        : 0.75,
    },
    context: {
      hotWindowSize: process.env.HOT_WINDOW_SIZE ? parseInt(process.env.HOT_WINDOW_SIZE, 10) : 50,
      maxContextTokens: process.env.MAX_CONTEXT_TOKENS ? parseInt(process.env.MAX_CONTEXT_TOKENS, 10) : 128000,
      compressionThreshold: process.env.COMPRESSION_THRESHOLD ? parseFloat(process.env.COMPRESSION_THRESHOLD) : 0.7,
      maxToolOutputBytes: process.env.MAX_TOOL_OUTPUT_BYTES ? parseInt(process.env.MAX_TOOL_OUTPUT_BYTES, 10) : 30000,
    },
    memory: {
      filePath: process.env.MEMORY_FILE_PATH || 'memories.jsonl',
      persist: process.env.MEMORY_PERSIST !== 'false',
      dbPath: process.env.MEMORY_DB_PATH || 'memories.db',
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
