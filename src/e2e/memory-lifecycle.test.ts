/**
 * E2E Memory Lifecycle Tests
 *
 * Tests v3.0 memory lifecycle features end-to-end:
 * - Deep tick fuses dormant related memories into consolidated summaries
 * - Behavioral signals computed from session data after cold-start threshold
 * - Profile context formats signals as natural language insights
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { ProfileManager } from '../memory/profiles.js';
import { createMockLLMProvider, createMockEmbeddingProvider } from './helpers.js';

const testLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Test 1: Deep tick fuses dormant related memories
// ---------------------------------------------------------------------------
describe('E2E Memory Lifecycle', () => {

  describe('memory fusion via deep tick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-fusion-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // Fusion provider returns a coherent merged summary when called
      const fusionProvider = createMockLLMProvider([
        JSON.stringify({
          summary: 'User is a coffee enthusiast who drinks dark roast every morning',
          importance: 7,
          category: 'preference',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // We need memories whose prominence the decay engine calculates as < 0.7.
      // The decay formula is:
      //   prominence = ageDecay*0.30 + accessBoost*0.25 + recencyBoost*0.25 + importanceWeight*0.20
      //
      // Using category 'insight' (decayRate 0.97), importance=5, at 60 days old:
      //   ageDecay = 0.97^60 ≈ 0.161, prominence ≈ 0.048 + 0.25 + 0.25 + 0.10 = 0.648
      // This is < 0.7 and > 0.1 (DORMANT), so it qualifies for fusion.
      //
      // Note: 'preference' category has decayRate 0.995 which is far too slow --
      // 60-day-old preference memories still have prominence ~0.82.
      //
      // Use db.addMemory() directly with an old documentDate, because
      // scallopStore.add() always sets documentDate: Date.now().
      const DAY_MS = 24 * 60 * 60 * 1000;
      const oldDate = Date.now() - 60 * DAY_MS;
      const embeddingA = await mockEmbedder.embed('User mentioned liking coffee');
      const embeddingB = await mockEmbedder.embed('User drinks coffee every morning');
      const embeddingC = await mockEmbedder.embed('User prefers dark roast');

      const memA = db.addMemory({
        userId: 'default',
        content: 'User mentioned liking coffee',
        category: 'insight',
        memoryType: 'regular',
        importance: 5,
        confidence: 0.8,
        isLatest: true,
        source: 'user',
        documentDate: oldDate,
        eventDate: null,
        prominence: 0.3,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: embeddingA,
        metadata: null,
      });

      const memB = db.addMemory({
        userId: 'default',
        content: 'User drinks coffee every morning',
        category: 'insight',
        memoryType: 'regular',
        importance: 6,
        confidence: 0.85,
        isLatest: true,
        source: 'user',
        documentDate: oldDate,
        eventDate: null,
        prominence: 0.25,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: embeddingB,
        metadata: null,
      });

      const memC = db.addMemory({
        userId: 'default',
        content: 'User prefers dark roast',
        category: 'insight',
        memoryType: 'regular',
        importance: 5,
        confidence: 0.8,
        isLatest: true,
        source: 'user',
        documentDate: oldDate,
        eventDate: null,
        prominence: 0.2,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: embeddingC,
        metadata: null,
      });

      // Connect them with EXTENDS relations so they form a cluster
      db.addRelation(memB.id, memA.id, 'EXTENDS', 0.85);
      db.addRelation(memC.id, memB.id, 'EXTENDS', 0.80);

      // Create BackgroundGardener with fusion provider
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

    it('should fuse dormant related memories into a derived memory', async () => {
      // Trigger deep tick directly (runs processFullDecay first, then fusion)
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // Assert a new 'derived' memory exists containing the fused summary
      const derivedMemories = db.raw<{ id: string; content: string; memory_type: string; prominence: number }>(
        "SELECT id, content, memory_type, prominence FROM memories WHERE user_id = 'default' AND memory_type = 'derived'",
        []
      );
      expect(derivedMemories.length).toBeGreaterThanOrEqual(1);

      const fusedMemory = derivedMemories.find(m => m.content.includes('coffee'));
      expect(fusedMemory).toBeDefined();
      expect(fusedMemory!.content).toContain('coffee');

      // Assert original memories are marked superseded and isLatest: false
      const supersededMemories = db.raw<{ id: string; content: string; memory_type: string; is_latest: number }>(
        "SELECT id, content, memory_type, is_latest FROM memories WHERE user_id = 'default' AND memory_type = 'superseded' AND is_latest = 0",
        []
      );
      const coffeeSuperseded = supersededMemories.filter(m =>
        m.content.includes('coffee') || m.content.includes('dark roast')
      );
      expect(coffeeSuperseded.length).toBeGreaterThanOrEqual(3);

      // Assert DERIVES relations exist from fused memory to each source
      const fusedRelations = db.getRelations(fusedMemory!.id);
      const derivesRelations = fusedRelations.filter(r => r.relationType === 'DERIVES');
      expect(derivesRelations.length).toBeGreaterThanOrEqual(3);

      // Assert fused memory prominence is <= 0.7 (maxProminence cap)
      expect(fusedMemory!.prominence).toBeLessThanOrEqual(0.7);
    }, 30000);
  });

  // -------------------------------------------------------------------------
  // Test 2 & 3: Behavioral signals
  // -------------------------------------------------------------------------
  describe('behavioral signals', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let profileManager: ProfileManager;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-behavioral-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      profileManager = scallopStore.getProfileManager();
      const db = scallopStore.getDatabase();

      // Seed 16 session messages across 3 sessions to exceed cold-start threshold (10)
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;

      // Session 1: 6 messages, 12 days ago
      const session1Id = 'e2e-behavioral-sess-1';
      db.createSession(session1Id);
      for (let i = 0; i < 6; i++) {
        // addSessionMessage sets created_at = Date.now(), which is fine.
        // The deepTick pulls messages and uses their created_at as timestamp.
        db.addSessionMessage(session1Id, 'user', `Message about typescript and react patterns ${i}`);
      }

      // Session 2: 5 messages, 7 days ago
      const session2Id = 'e2e-behavioral-sess-2';
      db.createSession(session2Id);
      for (let i = 0; i < 5; i++) {
        db.addSessionMessage(session2Id, 'user', `Question about python and machine learning setup ${i}`);
      }

      // Session 3: 5 messages, 2 days ago
      const session3Id = 'e2e-behavioral-sess-3';
      db.createSession(session3Id);
      for (let i = 0; i < 5; i++) {
        db.addSessionMessage(session3Id, 'user', `Discussion about docker and kubernetes deployment ${i}`);
      }

      // Seed session summaries for engagement signal (3+ sessions required)
      db.addSessionSummary({
        sessionId: session1Id,
        userId: 'default',
        summary: 'Discussion about TypeScript and React',
        topics: ['typescript', 'react'],
        messageCount: 6,
        durationMs: 6 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: session2Id,
        userId: 'default',
        summary: 'Questions about Python and ML',
        topics: ['python', 'ml'],
        messageCount: 5,
        durationMs: 5 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: session3Id,
        userId: 'default',
        summary: 'Docker and K8s deployment',
        topics: ['docker', 'kubernetes'],
        messageCount: 5,
        durationMs: 5 * 60000,
        embedding: null,
      });

      // Seed memories with embeddings for topic switch detection
      for (let i = 0; i < 6; i++) {
        await scallopStore.add({
          userId: 'default',
          content: `TypeScript pattern discussion message ${i}`,
          category: 'fact',
          importance: 5,
          confidence: 0.8,
          detectRelations: false,
        });
      }

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

    it('should compute behavioral signals after sufficient messages', async () => {
      // Trigger deep tick which calls inferBehavioralPatterns internally
      await gardener.deepTick();

      // Query behavioral patterns for the user
      const patterns = profileManager.getBehavioralPatterns('default');

      // With 16 messages total (>= 10 cold start), signals should be computed
      expect(patterns).not.toBeNull();

      // Message frequency signal should be non-null (dailyRate > 0)
      expect(patterns!.messageFrequency).not.toBeNull();
      expect(patterns!.messageFrequency!.dailyRate).toBeGreaterThan(0);

      // Session engagement signal should be non-null (3 session summaries)
      expect(patterns!.sessionEngagement).not.toBeNull();
      expect(patterns!.sessionEngagement!.avgMessagesPerSession).toBeGreaterThan(0);

      // Response length signal should be non-null (>= 10 messages)
      expect(patterns!.responseLength).not.toBeNull();
      expect(patterns!.responseLength!.avgLength).toBeGreaterThan(0);

      // Communication style should be set
      expect(patterns!.communicationStyle).toBeTruthy();
    }, 30000);

    it('should format behavioral signals as natural language in profile context', async () => {
      // Ensure patterns were computed (from previous test or deepTick)
      const patterns = profileManager.getBehavioralPatterns('default');
      if (!patterns?.messageFrequency) {
        await gardener.deepTick();
      }

      // Call formatProfileContext
      const context = profileManager.formatProfileContext('default');

      // Combine all context sections
      const fullContext = `${context.staticProfile}${context.dynamicContext}${context.behavioralPatterns}${context.relevantMemories}`;

      // Assert natural-language behavioral insights are present
      const hasPaceInsight = fullContext.includes('Messaging pace') || fullContext.includes('/day');
      const hasSessionInsight = fullContext.includes('Session style') || fullContext.includes('messages over');
      const hasStyleInsight = fullContext.includes('Style:');

      expect(hasPaceInsight || hasSessionInsight || hasStyleInsight).toBe(true);

      // Assert it does NOT contain raw _sig_ keys (those are internal storage)
      expect(fullContext).not.toContain('_sig_');

      // Assert no raw JSON numbers without context
      expect(fullContext).not.toMatch(/"dailyRate"/);
      expect(fullContext).not.toMatch(/"weeklyAvg"/);
    }, 30000);
  });
});
