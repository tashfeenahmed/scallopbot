import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  BotConfigManager,
  type UserBotConfig,
} from './bot-config.js';
import { ScallopDatabase } from '../memory/db.js';

describe('BotConfigManager', () => {
  let dbPath: string;
  let db: ScallopDatabase;
  let manager: BotConfigManager;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `bot-config-test-${Date.now()}.db`);
    db = new ScallopDatabase(dbPath);
    manager = new BotConfigManager(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  describe('load', () => {
    it('should return default config when no data exists', async () => {
      await manager.load();

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('ScallopBot');
      expect(config.onboardingComplete).toBe(false);
    });

    it('should read existing config from SQLite', async () => {
      // Insert directly into db
      db.upsertBotConfig('user456', {
        botName: 'Jarvis',
        personalityId: 'custom',
        modelId: 'claude-sonnet-4-5-20250929',
        timezone: 'Europe/Dublin',
        onboardingComplete: true,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });

      await manager.load();

      const config = manager.getUserConfig('user456');
      expect(config.botName).toBe('Jarvis');
      expect(config.onboardingComplete).toBe(true);
      expect(config.timezone).toBe('Europe/Dublin');
    });
  });

  describe('getUserConfig', () => {
    it('should return default config for new user', async () => {
      await manager.load();

      const config = manager.getUserConfig('newuser');

      expect(config.botName).toBe('ScallopBot');
      expect(config.personalityId).toBe('custom');
      expect(config.modelId).toBe('auto');
      expect(config.timezone).toBe('UTC');
      expect(config.onboardingComplete).toBe(false);
      expect(config.onboardingStep).toBe('welcome');
    });

    it('should return same config for existing user', async () => {
      await manager.load();

      const config1 = manager.getUserConfig('user123');
      const config2 = manager.getUserConfig('user123');

      expect(config1.botName).toBe(config2.botName);
      expect(config1.personalityId).toBe(config2.personalityId);
    });
  });

  describe('updateUserConfig', () => {
    it('should update user config', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'Friday',
        onboardingStep: 'custom_personality',
      });

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('Friday');
      expect(config.onboardingStep).toBe('custom_personality');
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

    it('should update timezone', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        timezone: 'America/New_York',
      });

      const config = manager.getUserConfig('user123');
      expect(config.timezone).toBe('America/New_York');
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

  describe('getUserSystemPrompt', () => {
    it('should return custom personality prompt when set', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        personalityId: 'custom',
        customPersonality: 'Be a pirate captain assistant. Say arrr a lot.',
      });

      const prompt = manager.getUserSystemPrompt('user123');

      expect(prompt).toBe('Be a pirate captain assistant. Say arrr a lot.');
    });

    it('should return default personality when no custom set', async () => {
      await manager.load();

      const prompt = manager.getUserSystemPrompt('user123');

      expect(prompt).toContain('friendly');
    });
  });

  describe('getUserTimezone', () => {
    it('should return UTC by default', async () => {
      await manager.load();

      expect(manager.getUserTimezone('newuser')).toBe('UTC');
    });

    it('should return stored timezone', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', { timezone: 'Asia/Tokyo' });

      expect(manager.getUserTimezone('user123')).toBe('Asia/Tokyo');
    });
  });

  describe('resetUserConfig', () => {
    it('should reset user config to defaults', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'CustomBot',
        personalityId: 'custom',
        customPersonality: 'Be sassy',
        timezone: 'Europe/Dublin',
        onboardingComplete: true,
      });

      await manager.resetUserConfig('user123');

      const config = manager.getUserConfig('user123');
      expect(config.botName).toBe('ScallopBot');
      expect(config.personalityId).toBe('custom');
      expect(config.timezone).toBe('UTC');
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

  describe('persistence', () => {
    it('should persist config across manager instances', async () => {
      await manager.load();

      await manager.updateUserConfig('user123', {
        botName: 'TestBot',
        timezone: 'US/Pacific',
        onboardingComplete: true,
      });

      // New manager instance on same db
      const manager2 = new BotConfigManager(db);
      const config = manager2.getUserConfig('user123');

      expect(config.botName).toBe('TestBot');
      expect(config.timezone).toBe('US/Pacific');
      expect(config.onboardingComplete).toBe(true);
    });
  });
});
