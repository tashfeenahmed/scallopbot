/**
 * Bot Configuration Storage
 *
 * Stores per-user bot configuration (name, personality, model, etc.)
 * Persisted to disk as JSON for durability across restarts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Logger } from 'pino';

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

const CURRENT_VERSION = 1;

export class BotConfigManager {
  private configPath: string;
  private store: BotConfigStore;
  private saveDebounce: NodeJS.Timeout | null = null;
  private logger?: Logger;

  constructor(workspacePath: string, logger?: Logger) {
    this.configPath = path.join(workspacePath, 'bot-config.json');
    this.store = { users: {}, version: CURRENT_VERSION };
    this.logger = logger;
  }

  /**
   * Load configuration from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.store = JSON.parse(data);

      // Handle version migrations if needed
      if (this.store.version < CURRENT_VERSION) {
        await this.migrate();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist, use defaults
      this.store = { users: {}, version: CURRENT_VERSION };
    }
  }

  /**
   * Save configuration to disk (debounced)
   */
  private async save(): Promise<void> {
    if (this.saveDebounce) {
      clearTimeout(this.saveDebounce);
    }

    this.saveDebounce = setTimeout(async () => {
      try {
        await fs.writeFile(this.configPath, JSON.stringify(this.store, null, 2));
      } catch (error) {
        this.logger?.error({ error }, 'Failed to save bot config');
      }
    }, 500);
  }

  /**
   * Force immediate save
   */
  async saveNow(): Promise<void> {
    if (this.saveDebounce) {
      clearTimeout(this.saveDebounce);
      this.saveDebounce = null;
    }
    await fs.writeFile(this.configPath, JSON.stringify(this.store, null, 2));
  }

  /**
   * Get user config, creating default if not exists
   */
  getUserConfig(userId: string): UserBotConfig {
    if (!this.store.users[userId]) {
      this.store.users[userId] = {
        ...DEFAULT_CONFIG,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.save();
    }
    return this.store.users[userId];
  }

  /**
   * Update user config
   */
  async updateUserConfig(userId: string, updates: Partial<UserBotConfig>): Promise<UserBotConfig> {
    const current = this.getUserConfig(userId);
    this.store.users[userId] = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
    return this.store.users[userId];
  }

  /**
   * Check if user has completed onboarding
   */
  hasCompletedOnboarding(userId: string): boolean {
    const config = this.store.users[userId];
    return config?.onboardingComplete ?? false;
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
    this.store.users[userId] = {
      ...DEFAULT_CONFIG,
      createdAt: this.store.users[userId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Migrate old config versions
   */
  private async migrate(): Promise<void> {
    // Add migration logic here as versions change
    this.store.version = CURRENT_VERSION;
    await this.save();
  }
}
