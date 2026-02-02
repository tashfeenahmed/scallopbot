import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  BotConfigManager,
  DEFAULT_PERSONALITIES,
  AVAILABLE_MODELS,
  type UserBotConfig,
} from './bot-config.js';

describe('BotConfigManager', () => {
  let testDir: string;
  let manager: BotConfigManager;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-config-test-'));
    manager = new BotConfigManager(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should create empty store if no config file exists', async () => {
      await manager.load();

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('ScallopBot');
      expect(config.onboardingComplete).toBe(false);
    });

    it('should load existing config from disk', async () => {
      const existingConfig = {
        version: 1,
        users: {
          user456: {
            botName: 'Jarvis',
            personalityId: 'professional',
            modelId: 'claude-sonnet-4-5-20250929',
            onboardingComplete: true,
            updatedAt: '2025-01-01T00:00:00Z',
            createdAt: '2025-01-01T00:00:00Z',
          },
        },
      };

      await fs.writeFile(
        path.join(testDir, 'bot-config.json'),
        JSON.stringify(existingConfig)
      );

      await manager.load();

      const config = manager.getUserConfig('user456');
      expect(config.botName).toBe('Jarvis');
      expect(config.onboardingComplete).toBe(true);
    });
  });

  describe('getUserConfig', () => {
    it('should return default config for new user', async () => {
      await manager.load();

      const config = manager.getUserConfig('newuser');

      expect(config.botName).toBe('ScallopBot');
      expect(config.personalityId).toBe('friendly');
      expect(config.modelId).toBe('moonshot-v1-128k');
      expect(config.onboardingComplete).toBe(false);
      expect(config.onboardingStep).toBe('welcome');
    });

    it('should return cached config for existing user', async () => {
      await manager.load();

      const config1 = manager.getUserConfig('user123');
      const config2 = manager.getUserConfig('user123');

      expect(config1).toBe(config2);
    });
  });

  describe('updateUserConfig', () => {
    it('should update user config', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'Friday',
        onboardingStep: 'personality',
      });

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('Friday');
      expect(config.onboardingStep).toBe('personality');
    });

    it('should update updatedAt timestamp', async () => {
      await manager.load();

      const before = manager.getUserConfig('user123');
      const originalUpdatedAt = before.updatedAt;

      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      await manager.updateUserConfig('user123', { botName: 'Max' });

      const after = manager.getUserConfig('user123');
      expect(after.updatedAt).not.toBe(originalUpdatedAt);
    });

    it('should preserve createdAt timestamp', async () => {
      await manager.load();

      const before = manager.getUserConfig('user123');
      const originalCreatedAt = before.createdAt;

      await manager.updateUserConfig('user123', { botName: 'Max' });

      const after = manager.getUserConfig('user123');
      expect(after.createdAt).toBe(originalCreatedAt);
    });
  });

  describe('hasCompletedOnboarding', () => {
    it('should return false for new user', async () => {
      await manager.load();

      expect(manager.hasCompletedOnboarding('newuser')).toBe(false);
    });

    it('should return true after completing onboarding', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', { onboardingComplete: true });

      expect(manager.hasCompletedOnboarding('user123')).toBe(true);
    });
  });

  describe('getPersonality', () => {
    it('should return personality by id', async () => {
      await manager.load();

      const personality = manager.getPersonality('professional');

      expect(personality).toBeDefined();
      expect(personality?.name).toBe('Professional & Concise');
    });

    it('should return undefined for unknown personality', async () => {
      await manager.load();

      const personality = manager.getPersonality('unknown');

      expect(personality).toBeUndefined();
    });
  });

  describe('getModel', () => {
    it('should return model by id', async () => {
      await manager.load();

      const model = manager.getModel('claude-sonnet-4-5-20250929');

      expect(model).toBeDefined();
      expect(model?.name).toBe('Claude Sonnet 4.5');
    });

    it('should return undefined for unknown model', async () => {
      await manager.load();

      const model = manager.getModel('unknown-model');

      expect(model).toBeUndefined();
    });
  });

  describe('getUserSystemPrompt', () => {
    it('should return personality system prompt', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        personalityId: 'technical',
      });

      const prompt = manager.getUserSystemPrompt('user123');

      expect(prompt).toContain('technical expert');
    });

    it('should return custom personality prompt when set', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        personalityId: 'custom',
        customPersonality: 'Be a pirate captain assistant. Say arrr a lot.',
      });

      const prompt = manager.getUserSystemPrompt('user123');

      expect(prompt).toBe('Be a pirate captain assistant. Say arrr a lot.');
    });

    it('should fallback to friendly personality for unknown id', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        personalityId: 'unknown-personality',
      });

      const prompt = manager.getUserSystemPrompt('user123');

      // Should get the friendly personality (index 1)
      expect(prompt).toContain('friendly');
    });
  });

  describe('resetUserConfig', () => {
    it('should reset user config to defaults', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'CustomBot',
        personalityId: 'technical',
        onboardingComplete: true,
      });

      await manager.resetUserConfig('user123');

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('ScallopBot');
      expect(config.personalityId).toBe('friendly');
      expect(config.onboardingComplete).toBe(false);
    });

    it('should preserve original createdAt', async () => {
      await manager.load();

      const original = manager.getUserConfig('user123');
      const originalCreatedAt = original.createdAt;

      await manager.updateUserConfig('user123', { botName: 'Test' });
      await manager.resetUserConfig('user123');

      const config = manager.getUserConfig('user123');
      expect(config.createdAt).toBe(originalCreatedAt);
    });
  });

  describe('saveNow', () => {
    it('should persist config to disk immediately', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'TestBot',
        onboardingComplete: true,
      });

      await manager.saveNow();

      // Read the file directly
      const data = await fs.readFile(
        path.join(testDir, 'bot-config.json'),
        'utf-8'
      );
      const saved = JSON.parse(data);

      expect(saved.users.user123.botName).toBe('TestBot');
      expect(saved.users.user123.onboardingComplete).toBe(true);
    });
  });
});

describe('DEFAULT_PERSONALITIES', () => {
  it('should have at least 4 personalities', () => {
    expect(DEFAULT_PERSONALITIES.length).toBeGreaterThanOrEqual(4);
  });

  it('should have required fields for each personality', () => {
    for (const personality of DEFAULT_PERSONALITIES) {
      expect(personality.id).toBeDefined();
      expect(personality.name).toBeDefined();
      expect(personality.description).toBeDefined();
      expect(personality.systemPrompt).toBeDefined();
    }
  });
});

describe('AVAILABLE_MODELS', () => {
  it('should have at least 4 models', () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThanOrEqual(4);
  });

  it('should have required fields for each model', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.provider).toBeDefined();
      expect(model.description).toBeDefined();
    }
  });

  it('should include Moonshot V1 128K as the first (recommended) model', () => {
    expect(AVAILABLE_MODELS[0].name).toContain('Moonshot');
    expect(AVAILABLE_MODELS[0].id).toBe('moonshot-v1-128k');
  });
});
