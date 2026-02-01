import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Provider configuration schemas
const anthropicProviderSchema = z.object({
  apiKey: z.string().min(1, 'Anthropic API key is required'),
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
  baseUrl: z.string().default('http://localhost:11434'),
  model: z.string().default('llama3.2'),
});

const openrouterProviderSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default('anthropic/claude-3.5-sonnet'),
});

const providersSchema = z.object({
  anthropic: anthropicProviderSchema,
  openai: openaiProviderSchema.default({ apiKey: '', model: 'gpt-4o' }),
  groq: groqProviderSchema.default({ apiKey: '', model: 'llama-3.3-70b-versatile' }),
  ollama: ollamaProviderSchema.default({ baseUrl: 'http://localhost:11434', model: 'llama3.2' }),
  openrouter: openrouterProviderSchema.default({ apiKey: '', model: 'anthropic/claude-3.5-sonnet' }),
});

// Channel configuration schemas
const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
});

const discordChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  applicationId: z.string().default(''),
});

const channelsSchema = z.object({
  telegram: telegramChannelSchema,
  discord: discordChannelSchema.default({ enabled: false, botToken: '', applicationId: '' }),
});

// Agent configuration schema
const agentSchema = z.object({
  workspace: z.string().min(1, 'Workspace path is required'),
  maxIterations: z.number().int().positive().default(20),
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
  hotWindowSize: z.number().int().positive().default(5),
  maxContextTokens: z.number().int().positive().default(128000),
  compressionThreshold: z.number().min(0).max(1).default(0.7),
  maxToolOutputBytes: z.number().int().positive().default(30000),
});

// Main configuration schema
export const configSchema = z.object({
  providers: providersSchema,
  channels: channelsSchema,
  agent: agentSchema,
  logging: loggingSchema.default({ level: 'info' }),
  routing: routingSchema.default({ providerOrder: ['anthropic', 'openai', 'groq', 'ollama'], enableComplexityAnalysis: true }),
  cost: costSchema.default({ warningThreshold: 0.75 }),
  context: contextSchema.default({ hotWindowSize: 5, maxContextTokens: 128000, compressionThreshold: 0.7, maxToolOutputBytes: 30000 }),
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
    : 20;
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
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'llama3.2',
      },
      openrouter: {
        apiKey: openrouterApiKey || '',
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
      },
    },
    channels: {
      telegram: {
        enabled: !!telegramBotToken,
        botToken: telegramBotToken || '',
      },
      discord: {
        enabled: !!discordBotToken,
        botToken: discordBotToken || '',
        applicationId: discordAppId || '',
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
        : ['anthropic', 'openai', 'groq', 'ollama'],
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
      hotWindowSize: process.env.HOT_WINDOW_SIZE ? parseInt(process.env.HOT_WINDOW_SIZE, 10) : 5,
      maxContextTokens: process.env.MAX_CONTEXT_TOKENS ? parseInt(process.env.MAX_CONTEXT_TOKENS, 10) : 128000,
      compressionThreshold: process.env.COMPRESSION_THRESHOLD ? parseFloat(process.env.COMPRESSION_THRESHOLD) : 0.7,
      maxToolOutputBytes: process.env.MAX_TOOL_OUTPUT_BYTES ? parseInt(process.env.MAX_TOOL_OUTPUT_BYTES, 10) : 30000,
    },
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errorMessages}`);
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
