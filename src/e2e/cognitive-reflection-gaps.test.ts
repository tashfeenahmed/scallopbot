/**
 * E2E Cognitive Reflection & Gap Scanner Tests
 *
 * Validates end-to-end:
 * 1. Self-reflection via sleepTick — insight memories + SOUL.md generation
 * 2. Gap scanner detects stale goals via sleepTick — creates scheduled items
 * 3. Gap scanner respects conservative dial — filters low-severity gaps
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { createMockLLMProvider, createMockEmbeddingProvider } from './helpers.js';

const testLogger = pino({ level: 'silent' });
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Suite 1: Self-reflection via sleepTick
// ---------------------------------------------------------------------------
describe('E2E Cognitive Reflection & Gaps', () => {

  describe('self-reflection via sleepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;
    let workspace: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-reflection-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reflection-'));

      const mockEmbedder = createMockEmbeddingProvider();

      // fusionProvider mock responses — called sequentially:
      // Dream cycle runs first but with only 1 high-prominence memory seeded,
      // eligibleMemories < 3, so dream cycle skips entirely (no provider calls).
      // Reflection then makes 2 calls:
      //   1. Reflection prompt → JSON with insights array
      //   2. Soul distillation prompt → raw markdown
      // Gap scanner also runs but needs provider for diagnosis.
      const fusionProvider = createMockLLMProvider([
        // Call 1: Reflection response — composite reflections
        JSON.stringify({
          insights: [
            {
              content: 'I notice the user consistently works on TypeScript projects and asks about testing patterns. They value clean code and TDD.',
              topics: ['typescript', 'testing', 'tdd'],
            },
          ],
          principles: [
            'Always provide type-safe code examples',
            'Emphasize test-driven development when discussing code structure',
          ],
        }),
        // Call 2: Soul distillation response — raw markdown
        '# SOUL\n\nI am a coding assistant who helps with TypeScript and testing. I emphasize clean code practices and TDD methodology.\n\n## Communication Style\n\nYou should always provide clear, well-typed examples. When discussing code structure, emphasize testing patterns.',
        // Call 3: Gap diagnosis (if gap scanner finds signals) — empty diagnoses
        JSON.stringify({
          gaps: [],
        }),
        // Call 4+: Inner thoughts (if triggered) — no proaction
        JSON.stringify({
          decision: 'silent',
          reason: 'No action needed',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Create sessions first (foreign key constraint on session_summaries)
      db.createSession('sess-1');
      db.createSession('sess-2');

      // Seed 2 session summaries within last 24 hours (qualify for reflection)
      db.addSessionSummary({
        sessionId: 'sess-1',
        userId: 'default',
        summary: 'Discussion about TypeScript patterns including generics, mapped types, and conditional types. User asked about best practices for type-safe API clients.',
        topics: ['typescript', 'generics', 'api-clients'],
        messageCount: 6,
        durationMs: 12 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: 'sess-2',
        userId: 'default',
        summary: 'Testing best practices conversation covering unit tests, integration tests, and TDD workflow. User prefers vitest over jest.',
        topics: ['testing', 'tdd', 'vitest'],
        messageCount: 4,
        durationMs: 8 * 60000,
        embedding: null,
      });

      // Seed a memory so the user appears in the memories table
      // (sleepTick queries distinct user_ids from memories and session_summaries)
      await scallopStore.add({
        userId: 'default',
        content: 'User prefers TypeScript for all projects',
        category: 'preference',
        importance: 5,
        confidence: 0.8,
        detectRelations: false,
      });

      // Create BackgroundGardener with fusionProvider AND workspace
      gardener = new BackgroundGardener({
        scallopStore,
        logger: testLogger,
        fusionProvider,
        workspace,
      });
    }, 30000);

    afterAll(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('should generate insight memories and write SOUL.md', async () => {
      await gardener.sleepTick();

      const db = scallopStore.getDatabase();

      // Assert insight memory exists with correct attributes
      const insightMemories = db.raw<{
        id: string;
        content: string;
        memory_type: string;
        category: string;
        learned_from: string;
        metadata: string | null;
      }>(
        "SELECT id, content, memory_type, category, learned_from, metadata FROM memories WHERE user_id = 'default' AND category = 'insight' AND learned_from = 'self_reflection'",
        []
      );
      expect(insightMemories.length).toBeGreaterThanOrEqual(1);

      const insight = insightMemories[0];
      // Assert content contains reflection text
      expect(insight.content).toContain('TypeScript');
      // Assert memoryType is 'derived'
      expect(insight.memory_type).toBe('derived');
      // Assert category is 'insight'
      expect(insight.category).toBe('insight');
      // Assert learnedFrom is 'self_reflection'
      expect(insight.learned_from).toBe('self_reflection');

      // Assert metadata has sourceSessionIds
      const metadata = insight.metadata ? JSON.parse(insight.metadata) : null;
      expect(metadata).not.toBeNull();
      expect(metadata.sourceSessionIds).toBeDefined();
      expect(Array.isArray(metadata.sourceSessionIds)).toBe(true);
      expect(metadata.sourceSessionIds.length).toBeGreaterThan(0);

      // Assert SOUL.md was written to workspace
      const soulPath = path.join(workspace, 'SOUL.md');
      expect(fs.existsSync(soulPath)).toBe(true);

      const soulContent = fs.readFileSync(soulPath, 'utf-8');
      // Assert SOUL.md contains relevant content
      expect(soulContent).toContain('SOUL');
      // Assert it is valid markdown (not JSON — should not start with '{')
      expect(soulContent.trim().startsWith('{')).toBe(false);
      // Assert it contains TypeScript-related content
      expect(soulContent.toLowerCase()).toContain('typescript');
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Gap scanner detects stale goals via sleepTick
  // ---------------------------------------------------------------------------
  describe('gap scanner detects stale goals via sleepTick', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-gap-stale-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // Provider call sequence for sleepTick:
      // Dream cycle: only 1 memory (the goal) with high prominence, < 3 eligible, skips.
      // Reflection: no workspace provided, skips.
      // Gap scanner:
      //   Call 1: Gap diagnosis — returns actionable stale goal diagnosis
      // Inner thoughts (deepTick step 7 in sleepTick):
      //   Call 2+: Inner thoughts evaluation — no proaction
      const fusionProvider = createMockLLMProvider([
        // Call 1: Gap diagnosis — stale goal is actionable
        JSON.stringify({
          gaps: [
            {
              index: 0,
              actionable: true,
              confidence: 0.85,
              diagnosis: 'Goal has not been updated in over two weeks',
              suggestedAction: 'Check in about progress on learning Rust programming',
            },
          ],
        }),
        // Call 2+: Inner thoughts — silent
        JSON.stringify({
          decision: 'silent',
          reason: 'No action needed',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Seed an active goal with old documentDate and updatedAt (stale: 15 days ago)
      // GoalService creates goals as memories with category='insight' and goal metadata.
      // We insert directly via db.addMemory to control documentDate.
      // Note: addMemory sets updated_at = Date.now(), but scanStaleGoals reads
      // updatedAt from the memory entry, so we must also backdate updated_at.
      const staleDate = Date.now() - 15 * DAY_MS;
      const goalEmbedding = await mockEmbedder.embed('Learn Rust programming');
      const goalMem = db.addMemory({
        userId: 'default',
        content: 'Learn Rust programming',
        category: 'insight',
        memoryType: 'regular',
        importance: 8,
        confidence: 1.0,
        isLatest: true,
        source: 'user',
        documentDate: staleDate,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: goalEmbedding,
        metadata: {
          goalType: 'goal',
          status: 'active',
          progress: 0,
        },
      });
      // Backdate updated_at so scanStaleGoals sees it as 15 days old.
      // addMemory sets updated_at = Date.now(); we must override it.
      // Access the private SQLite db via cast (acceptable in E2E tests).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqliteDb = (db as any).db;
      sqliteDb.prepare('UPDATE memories SET updated_at = ?, document_date = ? WHERE id = ?')
        .run(staleDate, staleDate, goalMem.id);

      // Seed 2 session summaries (needed for scanForGaps input)
      db.createSession('gap-sess-1');
      db.createSession('gap-sess-2');
      db.addSessionSummary({
        sessionId: 'gap-sess-1',
        userId: 'default',
        summary: 'Discussed project architecture and Rust basics',
        topics: ['rust', 'architecture'],
        messageCount: 5,
        durationMs: 10 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: 'gap-sess-2',
        userId: 'default',
        summary: 'Talked about memory safety and ownership in Rust',
        topics: ['rust', 'memory-safety'],
        messageCount: 4,
        durationMs: 8 * 60000,
        embedding: null,
      });

      // Seed behavioral patterns with proactivenessDial = 'moderate'
      db.updateBehavioralPatterns('default', {
        responsePreferences: {
          proactivenessDial: 'moderate',
        },
      });

      // Create BackgroundGardener with fusionProvider (no workspace — reflection skipped)
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

    it('should create scheduled items for stale goals', async () => {
      await gardener.sleepTick();

      const db = scallopStore.getDatabase();

      // Query scheduled_items where source='agent' AND type='follow_up'
      const scheduledItems = db.raw<{
        id: string;
        user_id: string;
        source: string;
        type: string;
        message: string;
        context: string | null;
        trigger_at: number;
        status: string;
      }>(
        "SELECT id, user_id, source, type, message, context, trigger_at, status FROM scheduled_items WHERE source = 'agent' AND type = 'follow_up'",
        []
      );

      // Assert at least one scheduled item exists
      expect(scheduledItems.length).toBeGreaterThanOrEqual(1);

      // Assert item message references learning Rust or the goal
      const rustItem = scheduledItems.find(
        item => item.message.toLowerCase().includes('rust') || item.message.toLowerCase().includes('progress')
      );
      expect(rustItem).toBeDefined();

      // Assert item has context JSON with source information
      expect(rustItem!.context).not.toBeNull();
      const context = JSON.parse(rustItem!.context!);
      expect(context.gapType).toBe('stale_goal');
      expect(context.sourceId).toBeDefined();
    }, 30000);
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Gap scanner respects conservative dial
  // ---------------------------------------------------------------------------
  describe('gap scanner respects conservative dial', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-gap-conservative-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // Provider call sequence:
      // Dream cycle: skips (< 3 eligible memories).
      // Reflection: skips (no workspace).
      // Gap scanner:
      //   Call 1: Gap diagnosis — returns low confidence, actionable but low severity
      const fusionProvider = createMockLLMProvider([
        // Call 1: Gap diagnosis — low confidence, low severity
        JSON.stringify({
          gaps: [
            {
              index: 0,
              actionable: true,
              confidence: 0.5,
              diagnosis: 'Goal is somewhat stale but not critical',
              suggestedAction: 'Consider checking in on Rust learning progress',
            },
          ],
        }),
        // Call 2+: Inner thoughts — silent
        JSON.stringify({
          decision: 'silent',
          reason: 'No action needed',
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Seed an active goal — 15 days old (stale, generates medium-severity signal)
      // Conservative dial requires high severity, so medium will be filtered out
      const staleDate = Date.now() - 15 * DAY_MS;
      const goalEmbedding = await mockEmbedder.embed('Learn Rust programming');
      const goalMem = db.addMemory({
        userId: 'default',
        content: 'Learn Rust programming',
        category: 'insight',
        memoryType: 'regular',
        importance: 8,
        confidence: 1.0,
        isLatest: true,
        source: 'user',
        documentDate: staleDate,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: goalEmbedding,
        metadata: {
          goalType: 'goal',
          status: 'active',
          progress: 0,
        },
      });
      // Backdate updated_at so scanStaleGoals sees it as stale
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqliteDb = (db as any).db;
      sqliteDb.prepare('UPDATE memories SET updated_at = ?, document_date = ? WHERE id = ?')
        .run(staleDate, staleDate, goalMem.id);

      // Seed 2 session summaries
      db.createSession('cons-sess-1');
      db.createSession('cons-sess-2');
      db.addSessionSummary({
        sessionId: 'cons-sess-1',
        userId: 'default',
        summary: 'General discussion about programming languages',
        topics: ['programming', 'languages'],
        messageCount: 5,
        durationMs: 10 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: 'cons-sess-2',
        userId: 'default',
        summary: 'Talked about web development frameworks',
        topics: ['web', 'frameworks'],
        messageCount: 4,
        durationMs: 8 * 60000,
        embedding: null,
      });

      // Seed behavioral patterns with proactivenessDial = 'conservative'
      db.updateBehavioralPatterns('default', {
        responsePreferences: {
          proactivenessDial: 'conservative',
        },
      });

      // Create BackgroundGardener with fusionProvider (no workspace — reflection skipped)
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

    it('should NOT create scheduled items when conservative dial filters low-severity gaps', async () => {
      await gardener.sleepTick();

      const db = scallopStore.getDatabase();

      // Query scheduled_items where source='agent' AND type='follow_up'
      const scheduledItems = db.raw<{
        id: string;
        source: string;
        type: string;
        message: string;
      }>(
        "SELECT id, source, type, message FROM scheduled_items WHERE source = 'agent' AND type = 'follow_up'",
        []
      );

      // Assert NO scheduled items created
      // Conservative dial requires high severity + high confidence.
      // The stale goal signal has medium severity (generic stale),
      // which is below the conservative threshold of 'high'.
      expect(scheduledItems.length).toBe(0);
    }, 30000);
  });
});
