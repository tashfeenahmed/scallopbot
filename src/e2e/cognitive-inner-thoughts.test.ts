/**
 * E2E Inner Thoughts & Proactive Feedback Tests
 *
 * Validates end-to-end:
 * 1. Inner thoughts creates proactive scheduled item via deepTick
 * 2. Inner thoughts suppressed when user is distressed
 * 3. Proactive feedback loop detects engagement within window
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { createMockLLMProvider, createMockEmbeddingProvider } from './helpers.js';
import { detectProactiveEngagement } from '../proactive/feedback.js';
import type { ScheduledItem } from '../memory/db.js';

const testLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Suite 1: Inner thoughts creates proactive scheduled item via deepTick
// ---------------------------------------------------------------------------
describe('E2E Inner Thoughts & Proactive Feedback', () => {

  describe('inner thoughts creates proactive scheduled item via deepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-inner-thoughts-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // fusionProvider mock responses — deepTick step 7 (inner thoughts) calls:
      //   1. evaluateInnerThoughts -> provider.complete (the inner thoughts LLM call)
      // Steps 1-6 don't use fusionProvider when no dormant memories/goals exist.
      // However, the gap scanner in step 7 also calls scanForGaps (pure, no LLM)
      // and the GoalService.listGoals (pure DB query, no LLM).
      // Only inner thoughts itself calls the provider.
      const fusionProvider = createMockLLMProvider([
        // Call 1: Inner thoughts evaluation response
        JSON.stringify({
          decision: 'proact',
          reason: 'User was working on async patterns and seemed stuck',
          message: 'I noticed you were working on async/await patterns earlier. Would you like me to walk through some common pitfalls like error handling in Promise.all?',
          urgency: 'medium',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Create session first (foreign key constraint on session_summaries)
      db.createSession('inner-thoughts-sess-1');

      // Seed session summary with createdAt = now (within 6h window)
      db.addSessionSummary({
        sessionId: 'inner-thoughts-sess-1',
        userId: 'default',
        summary: 'User asked about async/await patterns and error handling',
        topics: ['async', 'javascript'],
        messageCount: 5,
        durationMs: 300000,
        embedding: null,
      });

      // Seed behavioral patterns via db.updateBehavioralPatterns
      // proactivenessDial: 'moderate', smoothedAffect: calm (NOT distressed)
      db.updateBehavioralPatterns('default', {
        responsePreferences: {
          proactivenessDial: 'moderate',
        },
        smoothedAffect: {
          valence: 0.1,
          arousal: 0.3,
          emotion: 'calm',
          goalSignal: 'stable',
        },
        messageFrequency: {
          dailyRate: 3,
          weeklyAvg: 15,
          trend: 'stable' as const,
          lastComputed: Date.now(),
        },
      });

      // Do NOT seed any recent 'fired' scheduled items (no 6h cooldown block)

      // Create BackgroundGardener with fusionProvider
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
        fusionProvider,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('should create a follow_up scheduled item from inner thoughts', async () => {
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // Query scheduled items for the user
      const scheduledItems = db.getScheduledItemsByUser('default');

      // Find item with source='agent' AND type='follow_up'
      const followUpItems = scheduledItems.filter(
        (item) => item.source === 'agent' && item.type === 'follow_up'
      );

      // Assert item exists
      expect(followUpItems.length).toBeGreaterThanOrEqual(1);

      const item = followUpItems[0];

      // Assert item message contains 'async' or 'await' (from inner thoughts output)
      const messageContainsAsyncContent =
        item.message.toLowerCase().includes('async') ||
        item.message.toLowerCase().includes('await');
      expect(messageContainsAsyncContent).toBe(true);

      // Assert item context JSON contains source: 'inner_thoughts'
      expect(item.context).not.toBeNull();
      const context = JSON.parse(item.context!);
      expect(context.source).toBe('inner_thoughts');

      // Assert item triggerAt is a future timestamp (from timing model)
      expect(item.triggerAt).toBeGreaterThan(Date.now() - 5000); // Allow small clock drift
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Inner thoughts suppressed when user is distressed
  // ---------------------------------------------------------------------------
  describe('inner thoughts suppressed when user is distressed', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-inner-distressed-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // fusionProvider: should NOT be called for inner thoughts (distress suppression)
      // but provide a response just in case other steps call it
      const fusionProvider = createMockLLMProvider([
        JSON.stringify({
          decision: 'proact',
          reason: 'Should not reach this',
          message: 'This should not be created',
          urgency: 'medium',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Create session
      db.createSession('distressed-sess-1');

      // Seed session summary (same as Suite 1)
      db.addSessionSummary({
        sessionId: 'distressed-sess-1',
        userId: 'default',
        summary: 'User asked about async/await patterns and error handling',
        topics: ['async', 'javascript'],
        messageCount: 5,
        durationMs: 300000,
        embedding: null,
      });

      // Seed behavioral patterns with goalSignal: 'user_distressed'
      db.updateBehavioralPatterns('default', {
        responsePreferences: {
          proactivenessDial: 'moderate',
        },
        smoothedAffect: {
          valence: -0.6,
          arousal: 0.7,
          emotion: 'anxious',
          goalSignal: 'user_distressed',
        },
        messageFrequency: {
          dailyRate: 3,
          weeklyAvg: 15,
          trend: 'stable' as const,
          lastComputed: Date.now(),
        },
      });

      // Create BackgroundGardener with fusionProvider
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
        fusionProvider,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('should NOT create follow_up items when user is distressed', async () => {
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // Query scheduled items with source='agent' AND type='follow_up'
      const scheduledItems = db.getScheduledItemsByUser('default');
      const followUpItems = scheduledItems.filter(
        (item) => item.source === 'agent' && item.type === 'follow_up'
      );

      // Assert NO items created (distress suppression blocked inner thoughts)
      expect(followUpItems.length).toBe(0);
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Proactive feedback loop detects engagement
  // ---------------------------------------------------------------------------
  describe('proactive feedback loop detects engagement', () => {
    it('should detect engagement for items fired within window', () => {
      const now = Date.now();

      // Create a mock fired item within the 15-min engagement window (5 min ago)
      const recentItem: ScheduledItem = {
        id: 'test-item-1',
        userId: 'default',
        sessionId: null,
        source: 'agent',
        type: 'follow_up',
        message: 'Would you like help with that async pattern?',
        context: null,
        triggerAt: now - 10 * 60 * 1000,
        recurring: null,
        status: 'fired',
        firedAt: now - 5 * 60 * 1000, // 5 minutes ago — within 15-min window
        sourceMemoryId: null,
        createdAt: now - 15 * 60 * 1000,
        updatedAt: now - 5 * 60 * 1000,
      };

      const result = detectProactiveEngagement(
        'default',
        [recentItem],
        15 * 60 * 1000,
        now,
      );

      // Assert returned array contains the item ID (engagement detected)
      expect(result).toContain('test-item-1');
    });

    it('should NOT detect engagement for items fired outside window', () => {
      const now = Date.now();

      // Create a mock fired item outside the 15-min engagement window (20 min ago)
      const oldItem: ScheduledItem = {
        id: 'test-item-2',
        userId: 'default',
        sessionId: null,
        source: 'agent',
        type: 'follow_up',
        message: 'Would you like help with that async pattern?',
        context: null,
        triggerAt: now - 30 * 60 * 1000,
        recurring: null,
        status: 'fired',
        firedAt: now - 20 * 60 * 1000, // 20 minutes ago — outside 15-min window
        sourceMemoryId: null,
        createdAt: now - 35 * 60 * 1000,
        updatedAt: now - 20 * 60 * 1000,
      };

      const result = detectProactiveEngagement(
        'default',
        [oldItem],
        15 * 60 * 1000,
        now,
      );

      // Assert the 20-min-old item is NOT in the returned array
      expect(result).not.toContain('test-item-2');
      expect(result.length).toBe(0);
    });
  });
});
