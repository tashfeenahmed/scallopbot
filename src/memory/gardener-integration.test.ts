/**
 * Integration tests for BackgroundGardener tick operations.
 *
 * Tests the wiring of health ping (lightTick), retrieval audit, and
 * trust score update (deepTick) into the gardener pipeline.
 * Does NOT re-test pure functions (covered in 24-01/02/03).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  ScallopMemoryStore,
  BackgroundGardener,
} from './index.js';
import pino from 'pino';

const TEST_DB_PATH = '/tmp/gardener-integration-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  try {
    fs.unlinkSync(TEST_DB_PATH);
    fs.unlinkSync(TEST_DB_PATH + '-wal');
    fs.unlinkSync(TEST_DB_PATH + '-shm');
  } catch {
    // Ignore if files don't exist
  }
}

describe('BackgroundGardener integration', () => {
  let store: ScallopMemoryStore;
  let gardener: BackgroundGardener;

  beforeEach(() => {
    cleanupTestDb();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
    });
  });

  afterEach(() => {
    gardener.stop();
    store.close();
    cleanupTestDb();
  });

  // ============ lightTick: health ping ============

  describe('lightTick health ping', () => {
    it('should run health ping without throwing', () => {
      // lightTick includes health ping; should not throw even on empty DB
      expect(() => gardener.lightTick()).not.toThrow();
    });

    it('should still work with memories in the database', async () => {
      await store.add({
        userId: 'default',
        content: 'Test memory for health ping',
        category: 'fact',
        detectRelations: false,
      });

      expect(() => gardener.lightTick()).not.toThrow();
    });
  });

  // ============ deepTick: retrieval audit ============

  describe('deepTick retrieval audit', () => {
    it('should run retrieval audit on memories with zero access count', async () => {
      const db = store.getDatabase();

      // Seed a memory that is old (>7 days), has access_count=0, and prominence >= 0.5
      const oldDate = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days ago
      db.addMemory({
        userId: 'default',
        content: 'Old never-retrieved memory for audit test',
        category: 'fact',
        memoryType: 'regular',
        importance: 6,
        confidence: 0.8,
        isLatest: true,
        documentDate: oldDate,
        eventDate: null,
        prominence: 0.6,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: null,
      });

      // deepTick should complete without error; the audit runs internally
      await expect(gardener.deepTick()).resolves.not.toThrow();
    });
  });

  // ============ deepTick: trust score ============

  describe('deepTick trust score', () => {
    it('should compute and store trust score when sufficient session summaries exist', async () => {
      const db = store.getDatabase();
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;

      // Seed 6 session summaries (above cold start threshold of 5)
      // Must create sessions first (foreign key constraint)
      for (let i = 0; i < 6; i++) {
        db.createSession(`session-${i}`);
        db.addSessionSummary({
          sessionId: `session-${i}`,
          userId: 'default',
          summary: `Session ${i} summary`,
          topics: ['testing'],
          messageCount: 5 + i,
          durationMs: 10 * 60 * 1000, // 10 minutes
          embedding: null,
        });
      }

      // Run deepTick which includes trust score computation
      await gardener.deepTick();

      // Verify trust signal is stored in behavioral patterns
      const profileManager = store.getProfileManager();
      const patterns = profileManager.getBehavioralPatterns('default');
      expect(patterns).not.toBeNull();
      expect(patterns!.responsePreferences).toBeDefined();
      expect(typeof patterns!.responsePreferences.trustScore).toBe('number');
      expect(patterns!.responsePreferences.trustScore).toBeGreaterThanOrEqual(0);
      expect(patterns!.responsePreferences.trustScore).toBeLessThanOrEqual(1);
      expect(patterns!.responsePreferences.proactivenessDial).toBeDefined();
      expect(['conservative', 'moderate', 'eager']).toContain(
        patterns!.responsePreferences.proactivenessDial,
      );
    });

    it('should not store trust score when insufficient sessions (cold start)', async () => {
      const db = store.getDatabase();

      // Seed only 3 session summaries (below cold start threshold of 5)
      for (let i = 0; i < 3; i++) {
        db.createSession(`session-${i}`);
        db.addSessionSummary({
          sessionId: `session-${i}`,
          userId: 'default',
          summary: `Session ${i} summary`,
          topics: ['testing'],
          messageCount: 5,
          durationMs: 10 * 60 * 1000,
          embedding: null,
        });
      }

      await gardener.deepTick();

      // Trust score should NOT be stored (cold start returns null)
      const profileManager = store.getProfileManager();
      const patterns = profileManager.getBehavioralPatterns('default');
      // Either patterns is null or trustScore is not set
      if (patterns) {
        expect(patterns.responsePreferences.trustScore).toBeUndefined();
      }
    });
  });

  // ============ deepTick: all operations run without error ============

  describe('deepTick full pipeline', () => {
    it('should complete all deep tick steps without error on empty database', async () => {
      await expect(gardener.deepTick()).resolves.not.toThrow();
    });

    it('should complete all deep tick steps with seeded data', async () => {
      const db = store.getDatabase();

      // Seed a memory
      await store.add({
        userId: 'default',
        content: 'Test memory for full pipeline',
        category: 'fact',
        detectRelations: false,
      });

      // Seed session summaries (create sessions first for FK constraint)
      for (let i = 0; i < 6; i++) {
        db.createSession(`pipeline-session-${i}`);
        db.addSessionSummary({
          sessionId: `pipeline-session-${i}`,
          userId: 'default',
          summary: `Pipeline session ${i}`,
          topics: ['pipeline-test'],
          messageCount: 8,
          durationMs: 15 * 60 * 1000,
          embedding: null,
        });
      }

      await expect(gardener.deepTick()).resolves.not.toThrow();
    });
  });
});
