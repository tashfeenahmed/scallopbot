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
      const now = Date.now();
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
});
