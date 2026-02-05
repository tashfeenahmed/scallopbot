/**
 * Bot Configuration Storage
 *
 * Stores per-user bot configuration (name, personality, model, etc.)
 * Persisted in SQLite for durability across restarts.
 */

import type { Logger } from 'pino';
import type { ScallopDatabase } from '../memory/db.js';

export interface BotPersonality {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export const DEFAULT_PERSONALITIES: BotPersonality[] = [
  {
    id: 'professional',
    name: 'Professional & Concise',
    description: 'Direct, efficient responses focused on getting things done',
    systemPrompt: 'You are a professional assistant. Be concise, direct, and efficient. Focus on actionable answers without unnecessary elaboration.',
  },
  {
    id: 'friendly',
    name: 'Friendly & Conversational',
    description: 'Warm, approachable, and engaging communication style',
    systemPrompt: 'You are a friendly and helpful assistant. Be warm, conversational, and approachable. Use a casual tone while remaining helpful and accurate.',
  },
  {
    id: 'technical',
    name: 'Technical & Detailed',
    description: 'In-depth explanations with technical precision',
    systemPrompt: 'You are a technical expert assistant. Provide detailed, thorough explanations with technical precision. Include relevant context and considerations.',
  },
  {
    id: 'creative',
    name: 'Creative & Playful',
    description: 'Imaginative and fun while still being helpful',
    systemPrompt: 'You are a creative and playful assistant. Be imaginative, use humor when appropriate, and make interactions enjoyable while remaining helpful.',
  },
];

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'moonshot-v1-128k',
    name: 'Moonshot V1 128K',
    provider: 'moonshot',
    description: '128K context, tool-capable (Recommended)',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    description: 'Fast & capable',
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    description: 'Most powerful, best for complex tasks',
  },
  {
    id: 'grok-4',
    name: 'Grok 4',
    provider: 'xai',
    description: 'Fast reasoning model',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    description: 'OpenAI flagship model',
  },
  {
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B',
    provider: 'groq',
    description: 'Fast open-source via Groq',
  },
];

export interface UserBotConfig {
  /** User's chosen name for the bot */
  botName: string;
  /** Personality ID from DEFAULT_PERSONALITIES */
  personalityId: string;
  /** Custom personality prompt (if personalityId is 'custom') */
  customPersonality?: string;
  /** Model ID from AVAILABLE_MODELS */
  modelId: string;
  /** Whether onboarding has been completed */
  onboardingComplete: boolean;
  /** Current onboarding step (for resuming) */
  onboardingStep?: OnboardingStep;
  /** Timestamp of last update */
  updatedAt: string;
  /** Timestamp of creation */
  createdAt: string;
}

export type OnboardingStep =
  | 'welcome'
  | 'name'
  | 'personality'
  | 'custom_personality'
  | 'model'
  | 'complete';

export interface BotConfigStore {
  /** User ID -> Config mapping */
  users: Record<string, UserBotConfig>;
  /** Schema version for migrations */
  version: number;
}

const DEFAULT_CONFIG: UserBotConfig = {
  botName: 'ScallopBot',
  personalityId: 'friendly',
  modelId: 'moonshot-v1-128k',
  onboardingComplete: false,
  onboardingStep: 'welcome',
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

export class BotConfigManager {
  private db: ScallopDatabase;
  private logger?: Logger;

  constructor(db: ScallopDatabase, logger?: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Load configuration — no-op for SQLite (kept for API compat)
   */
  async load(): Promise<void> {
    // SQLite is always ready; no load step needed
  }

  /**
   * Force immediate save — no-op for SQLite (kept for API compat)
   */
  async saveNow(): Promise<void> {
    // SQLite writes are immediate; no flush needed
  }

  /**
   * Get user config, creating default if not exists
   */
  getUserConfig(userId: string): UserBotConfig {
    const row = this.db.getBotConfig(userId);
    if (row) {
      return this.rowToUserConfig(row);
    }

    // Create default
    const now = new Date().toISOString();
    this.db.upsertBotConfig(userId, {
      botName: DEFAULT_CONFIG.botName,
      personalityId: DEFAULT_CONFIG.personalityId,
      modelId: DEFAULT_CONFIG.modelId,
      onboardingComplete: DEFAULT_CONFIG.onboardingComplete,
      onboardingStep: DEFAULT_CONFIG.onboardingStep,
      createdAt: now,
      updatedAt: now,
    });
    return { ...DEFAULT_CONFIG, createdAt: now, updatedAt: now };
  }

  /**
   * Update user config
   */
  async updateUserConfig(userId: string, updates: Partial<UserBotConfig>): Promise<UserBotConfig> {
    // Ensure user exists first
    this.getUserConfig(userId);

    this.db.upsertBotConfig(userId, {
      botName: updates.botName,
      personalityId: updates.personalityId,
      customPersonality: updates.customPersonality,
      modelId: updates.modelId,
      onboardingComplete: updates.onboardingComplete,
      onboardingStep: updates.onboardingStep,
    });

    return this.getUserConfig(userId);
  }

  /**
   * Check if user has completed onboarding
   */
  hasCompletedOnboarding(userId: string): boolean {
    const row = this.db.getBotConfig(userId);
    return row?.onboardingComplete ?? false;
  }

  /**
   * Get personality by ID
   */
  getPersonality(personalityId: string): BotPersonality | undefined {
    return DEFAULT_PERSONALITIES.find(p => p.id === personalityId);
  }

  /**
   * Get model by ID
   */
  getModel(modelId: string): ModelOption | undefined {
    return AVAILABLE_MODELS.find(m => m.id === modelId);
  }

  /**
   * Get the system prompt for a user
   */
  getUserSystemPrompt(userId: string): string {
    const config = this.getUserConfig(userId);

    if (config.personalityId === 'custom' && config.customPersonality) {
      return config.customPersonality;
    }

    const personality = this.getPersonality(config.personalityId);
    return personality?.systemPrompt || DEFAULT_PERSONALITIES[1].systemPrompt;
  }

  /**
   * Reset user to defaults
   */
  async resetUserConfig(userId: string): Promise<void> {
    const existing = this.db.getBotConfig(userId);
    const now = new Date().toISOString();
    this.db.upsertBotConfig(userId, {
      botName: DEFAULT_CONFIG.botName,
      personalityId: DEFAULT_CONFIG.personalityId,
      customPersonality: undefined,
      modelId: DEFAULT_CONFIG.modelId,
      onboardingComplete: DEFAULT_CONFIG.onboardingComplete,
      onboardingStep: DEFAULT_CONFIG.onboardingStep,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private rowToUserConfig(row: import('../memory/db.js').BotConfigRow): UserBotConfig {
    return {
      botName: row.botName,
      personalityId: row.personalityId,
      customPersonality: row.customPersonality ?? undefined,
      modelId: row.modelId,
      onboardingComplete: row.onboardingComplete,
      onboardingStep: (row.onboardingStep as OnboardingStep) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
