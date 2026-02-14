/**
 * E2E Cognitive Affect & Heartbeat Tests
 *
 * Validates end-to-end:
 * 1. Affect detection via processMessage — classify, smooth, persist
 * 2. Affect context injection into system prompt
 * 3. Trust score computation via deepTick
 * 4. Goal deadline check via deepTick — creates scheduled_items
 * 5. Utility-based forgetting via deepTick — archives low-utility memories
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { GoalService } from '../goals/goal-service.js';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  createMockLLMProvider,
  createMockEmbeddingProvider,
  testLogger,
  type E2EGatewayContext,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Suite 1: Affect detection via processMessage
// ---------------------------------------------------------------------------
describe('E2E Cognitive Affect & Heartbeat', () => {

  describe('affect detection via processMessage', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: ['I can see you are excited! That sounds amazing. [DONE]'],
        factExtractorResponses: [JSON.stringify({ facts: [] })],
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    });

    it('should persist affectState and smoothedAffect after processing a happy message', async () => {
      const client = await createWsClient(ctx.port);
      try {
        // Send a clearly positive/excited message (WebSocket uses type 'chat' with 'message' field)
        client.send({
          type: 'chat',
          message: 'I am so excited about this amazing wonderful project!',
        });

        // Wait for the response to complete
        await client.collectUntilResponse(15000);

        // Query behavioral patterns for affect data
        const profileManager = ctx.scallopStore.getProfileManager();
        const patterns = profileManager.getBehavioralPatterns('default');

        // Assert affectState was persisted (EMA state)
        expect(patterns).not.toBeNull();
        expect(patterns!.affectState).not.toBeNull();
        expect(patterns!.affectState!.lastUpdateMs).toBeGreaterThan(0);

        // Assert smoothedAffect was persisted with emotion label
        expect(patterns!.smoothedAffect).not.toBeNull();
        expect(patterns!.smoothedAffect!.emotion).toBeTruthy();
        expect(typeof patterns!.smoothedAffect!.valence).toBe('number');
        expect(typeof patterns!.smoothedAffect!.arousal).toBe('number');

        // Positive message should have positive valence
        expect(patterns!.smoothedAffect!.valence).toBeGreaterThan(0);

        // Goal signal should be defined
        expect(patterns!.smoothedAffect!.goalSignal).toBeTruthy();
      } finally {
        await client.close();
      }
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Affect context in system prompt
  // ---------------------------------------------------------------------------
  describe('affect context in system prompt', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: ['Sure, I can help with that! [DONE]'],
        factExtractorResponses: [JSON.stringify({ facts: [] })],
      });

      // Pre-seed smoothedAffect so the system prompt will include the affect block
      const profileManager = ctx.scallopStore.getProfileManager();
      profileManager.updateBehavioralPatterns('default', {
        smoothedAffect: {
          valence: 0.6,
          arousal: 0.5,
          emotion: 'happy',
          goalSignal: 'user_engaged',
        },
        affectState: {
          fastValence: 0.6,
          slowValence: 0.5,
          fastArousal: 0.5,
          slowArousal: 0.4,
          lastUpdateMs: Date.now(),
        },
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    });

    it('should include USER AFFECT CONTEXT in system prompt when smoothedAffect is set', async () => {
      const client = await createWsClient(ctx.port);
      try {
        // Send any message to trigger system prompt construction (WebSocket uses type 'chat' with 'message' field)
        client.send({
          type: 'chat',
          message: 'Tell me something interesting.',
        });

        // Wait for response
        await client.collectUntilResponse(15000);

        // Inspect the last request sent to the mock LLM provider
        const lastRequest = ctx.mockProvider.lastRequest;
        expect(lastRequest).not.toBeNull();

        // The system prompt should contain the affect context block
        const systemPrompt = typeof lastRequest!.system === 'string'
          ? lastRequest!.system
          : Array.isArray(lastRequest!.system)
            ? lastRequest!.system.map((b: { text?: string }) => b.text || '').join('\n')
            : '';

        expect(systemPrompt).toContain('USER AFFECT CONTEXT');

        // The affect block should contain an emotion label (may be 'happy', 'excited', etc.
        // depending on EMA update from the test message)
        expect(systemPrompt).toMatch(/Emotion: \w+/);

        // Should contain valence and arousal observations
        expect(systemPrompt).toContain('Valence:');
        expect(systemPrompt).toContain('Arousal:');

        // It should be observation only — the disclaimer says "not an instruction to change your tone"
        expect(systemPrompt).toContain('Observation');
        expect(systemPrompt).toContain('not an instruction to change your tone');
      } finally {
        await client.close();
      }
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Trust score computation via deepTick
  // ---------------------------------------------------------------------------
  describe('trust score computation via deepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-trust-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();
      const now = Date.now();

      // Seed a memory so user 'default' is discoverable by gardener
      db.addMemory({
        userId: 'default', content: 'test', category: 'fact', memoryType: 'regular',
        importance: 5, confidence: 0.8, isLatest: true, source: 'user',
        documentDate: now, eventDate: null, prominence: 0.5, lastAccessed: null,
        accessCount: 0, sourceChunk: null, embedding: null, metadata: null, learnedFrom: null,
      });

      // Seed 6+ session summaries to exceed cold-start threshold of 5
      for (let i = 0; i < 7; i++) {
        const sessionId = `trust-session-${i}`;
        db.createSession(sessionId);
        // Add a few messages to each session so they are valid
        db.addSessionMessage(sessionId, 'user', `Test message ${i}`);
        db.addSessionSummary({
          sessionId,
          userId: 'default',
          summary: `Session ${i} summary about coding topics`,
          topics: ['typescript', 'testing'],
          messageCount: 5,
          durationMs: 15 * 60 * 1000, // 15 min sessions
          embedding: null,
        });
      }

      // Seed 3+ scheduled items with status 'acted' and source 'agent'
      for (let i = 0; i < 4; i++) {
        db.addScheduledItem({
          userId: 'default',
          sessionId: null,
          source: 'agent',
          type: 'follow_up',
          message: `Proactive follow-up ${i}`,
          context: null,
          triggerAt: now - (i + 1) * DAY_MS,
          recurring: null,
          sourceMemoryId: null,
          status: 'acted',
        });
      }

      // Create BackgroundGardener (no fusionProvider needed for trust score)
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('should compute trustScore and proactivenessDial after deepTick', async () => {
      await gardener.deepTick();

      const profileManager = scallopStore.getProfileManager();
      const patterns = profileManager.getBehavioralPatterns('default');

      expect(patterns).not.toBeNull();
      expect(patterns!.responsePreferences).toBeDefined();

      // Trust score should be a number > 0
      const trustScore = patterns!.responsePreferences.trustScore as number;
      expect(typeof trustScore).toBe('number');
      expect(trustScore).toBeGreaterThan(0);
      expect(trustScore).toBeLessThanOrEqual(1);

      // Proactiveness dial should be one of the valid values
      const dial = patterns!.responsePreferences.proactivenessDial as string;
      expect(['conservative', 'moderate', 'eager']).toContain(dial);
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Goal deadline check via deepTick
  // ---------------------------------------------------------------------------
  describe('goal deadline check via deepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-goaldeadline-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Create an active goal with a deadline approaching in 2 days
      const goalService = new GoalService({ db, logger: testLogger });
      await goalService.createGoal('default', {
        title: 'Finish the quarterly report',
        status: 'active',
        dueDate: Date.now() + 2 * DAY_MS,
      });

      // Create BackgroundGardener
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('should create goal_checkin scheduled items for approaching deadlines', async () => {
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // Query scheduled items for goal_checkin type
      const scheduledItems = db.raw<{
        id: string;
        type: string;
        message: string;
        source: string;
      }>(
        "SELECT id, type, message, source FROM scheduled_items WHERE type = 'goal_checkin' AND user_id = 'default'",
        []
      );

      // At least one goal_checkin should exist
      expect(scheduledItems.length).toBeGreaterThanOrEqual(1);

      // Verify it references the goal
      const checkin = scheduledItems.find(item =>
        item.message.includes('quarterly report')
      );
      expect(checkin).toBeDefined();
      expect(checkin!.source).toBe('agent');
    }, 30000);

    it('should not create duplicate scheduled items on second deepTick', async () => {
      const db = scallopStore.getDatabase();

      // Count items before second deepTick
      const beforeItems = db.raw<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM scheduled_items WHERE type = 'goal_checkin' AND user_id = 'default'",
        []
      );
      const countBefore = beforeItems[0].cnt;

      // Run deepTick again
      await gardener.deepTick();

      // Count items after
      const afterItems = db.raw<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM scheduled_items WHERE type = 'goal_checkin' AND user_id = 'default'",
        []
      );
      const countAfter = afterItems[0].cnt;

      // Should not create duplicates
      expect(countAfter).toBe(countBefore);
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Utility-based forgetting via deepTick
  // ---------------------------------------------------------------------------
  describe('utility-based forgetting via deepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;
    let lowUtilityIds: string[];
    let highAccessId: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-forgetting-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();
      const oldDate = Date.now() - 60 * DAY_MS; // 60 days old

      lowUtilityIds = [];

      // Seed 3 old memories with zero access count (low utility: prominence * ln(1+0) = 0)
      for (let i = 0; i < 3; i++) {
        const embedding = await mockEmbedder.embed(`Low utility forgotten memory ${i}`);
        const mem = db.addMemory({
          userId: 'default',
          content: `Low utility forgotten memory ${i}`,
          category: 'fact',
          memoryType: 'regular',
          importance: 3,
          confidence: 0.7,
          isLatest: true,
          source: 'user',
          documentDate: oldDate,
          eventDate: null,
          prominence: 0.3,
          lastAccessed: null,
          accessCount: 0,
          sourceChunk: null,
          embedding,
          metadata: null,
        });
        lowUtilityIds.push(mem.id);
      }

      // Seed 1 old memory with high access count (should survive — utility = 0.5 * ln(1+20) ≈ 1.52)
      const highAccessEmbedding = await mockEmbedder.embed('High access important memory');
      const highAccessMem = db.addMemory({
        userId: 'default',
        content: 'High access important memory that should survive',
        category: 'fact',
        memoryType: 'regular',
        importance: 7,
        confidence: 0.9,
        isLatest: true,
        source: 'user',
        documentDate: oldDate,
        eventDate: null,
        prominence: 0.5,
        lastAccessed: Date.now(),
        accessCount: 20,
        sourceChunk: null,
        embedding: highAccessEmbedding,
        metadata: null,
      });
      highAccessId = highAccessMem.id;

      // Create BackgroundGardener
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('should archive low-utility memories and preserve high-access ones', async () => {
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // Check that low-utility memories are archived (is_latest=0, memory_type='superseded')
      for (const id of lowUtilityIds) {
        const rows = db.raw<{ is_latest: number; memory_type: string }>(
          'SELECT is_latest, memory_type FROM memories WHERE id = ?',
          [id]
        );
        expect(rows.length).toBe(1);
        expect(rows[0].is_latest).toBe(0);
        expect(rows[0].memory_type).toBe('superseded');
      }

      // Check that the high-access memory remains active
      const highRows = db.raw<{ is_latest: number; memory_type: string }>(
        'SELECT is_latest, memory_type FROM memories WHERE id = ?',
        [highAccessId]
      );
      expect(highRows.length).toBe(1);
      expect(highRows[0].is_latest).toBe(1);
      expect(highRows[0].memory_type).toBe('regular');
    }, 30000);
  });
});
