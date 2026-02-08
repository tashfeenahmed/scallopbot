/**
 * Bot Configuration Storage
 *
 * Stores per-user bot configuration (name, personality, timezone, etc.)
 * Persisted in SQLite for durability across restarts.
 */

import type { Logger } from 'pino';
import type { ScallopDatabase } from '../memory/db.js';

export interface UserBotConfig {
  /** User's chosen name for the bot */
  botName: string;
  /** Personality ID (kept for backwards compat, always 'custom') */
  personalityId: string;
  /** Custom personality prompt */
  customPersonality?: string;
  /** Model ID (kept for backwards compat) */
  modelId: string;
  /** User's IANA timezone (e.g. 'Europe/Dublin') */
  timezone: string;
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
  | 'custom_personality'
  | 'timezone'
  | 'complete';

export interface BotConfigStore {
  /** User ID -> Config mapping */
  users: Record<string, UserBotConfig>;
  /** Schema version for migrations */
  version: number;
}

const DEFAULT_CONFIG: UserBotConfig = {
  botName: 'ScallopBot',
  personalityId: 'custom',
  modelId: 'moonshot-v1-128k',
  timezone: 'UTC',
  onboardingComplete: false,
  onboardingStep: 'welcome',
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

const DEFAULT_PERSONALITY_PROMPT =
  'You are a friendly and helpful assistant. Be warm, conversational, and approachable. Use a casual tone while remaining helpful and accurate.';

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
      timezone: DEFAULT_CONFIG.timezone,
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
      timezone: updates.timezone,
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
   * Get the system prompt for a user
   */
  getUserSystemPrompt(userId: string): string {
    const config = this.getUserConfig(userId);
    return config.customPersonality || DEFAULT_PERSONALITY_PROMPT;
  }

  /**
   * Get the user's timezone (IANA name)
   */
  getUserTimezone(userId: string): string {
    const config = this.getUserConfig(userId);
    return config.timezone || 'UTC';
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
      timezone: DEFAULT_CONFIG.timezone,
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
      timezone: row.timezone || 'UTC',
      onboardingComplete: row.onboardingComplete,
      onboardingStep: (row.onboardingStep as OnboardingStep) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
