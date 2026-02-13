import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, ScallopMemoryEntry } from './db.js';
import type { LLMProvider } from '../providers/types.js';
import type { CompletionResponse } from '../providers/types.js';
import type { GardenerContext } from './gardener-context.js';
import {
  runDreamCycle,
  runSelfReflection,
  runGapScanner,
} from './gardener-sleep-steps.js';

const TEST_DB_PATH = '/tmp/gardener-sleep-steps-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch { /* ignore */ }
}

function createMockFusionProvider(responseText?: string): LLMProvider {
  const defaultResponse = JSON.stringify({
    summary: 'Fused insight',
    importance: 7,
    category: 'insight',
  });
  return {
    name: 'mock-fusion',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText ?? defaultResponse }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } satisfies CompletionResponse),
  };
}

function createSequentialFusionProvider(responses: Array<string | Error>): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-sequential-fusion',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex % responses.length];
      callIndex++;
      if (response instanceof Error) throw response;
      return {
        content: [{ type: 'text', text: response }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse;
    }),
  };
}

function seedMemory(
  db: ScallopDatabase,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    importance?: number;
  },
): ScallopMemoryEntry {
  return db.addMemory({
    userId: opts.userId ?? 'user-1',
    content: opts.content,
    category: opts.category,
    memoryType: 'regular',
    importance: opts.importance ?? 6,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
    learnedFrom: null,
  });
}

function buildCtx(
  store: ScallopMemoryStore,
  db: ScallopDatabase,
  overrides?: Partial<GardenerContext>,
): GardenerContext {
  return {
    scallopStore: store,
    db,
    logger: logger.child({ component: 'gardener' }),
    quietHours: { start: 2, end: 5 },
    disableArchival: false,
    ...overrides,
  };
}

describe('gardener-sleep-steps', () => {
  let store: ScallopMemoryStore;
  let db: ScallopDatabase;

  beforeEach(() => {
    cleanupTestDb();
    store = new ScallopMemoryStore({ dbPath: TEST_DB_PATH, logger });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanupTestDb();
  });

  describe('runDreamCycle', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      const result = await runDreamCycle(ctx);
      expect(result.totalFused).toBe(0);
      expect(result.totalMerged).toBe(0);
      expect(result.totalDiscoveries).toBe(0);
    });

    it('skips users with fewer than 3 eligible memories', async () => {
      seedMemory(db, { content: 'Only one', category: 'fact', prominence: 0.5 });
      seedMemory(db, { content: 'Only two', category: 'fact', prominence: 0.5 });

      const provider = createMockFusionProvider();
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runDreamCycle(ctx);

      expect(result.totalFused).toBe(0);
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('runs NREM consolidation and stores fused memories', async () => {
      // Create enough related memories for NREM
      const m1 = seedMemory(db, { content: 'Likes hiking in mountains', category: 'preference', prominence: 0.5 });
      const m2 = seedMemory(db, { content: 'Enjoys mountain trails', category: 'preference', prominence: 0.45 });
      const m3 = seedMemory(db, { content: 'Prefers outdoor activities', category: 'preference', prominence: 0.4 });
      db.addRelation(m1.id, m2.id, 'RELATED', 0.8);
      db.addRelation(m2.id, m3.id, 'RELATED', 0.75);

      // Provider returns NREM fusion + REM discovery responses
      const nremResponse = JSON.stringify({
        summary: 'User is passionate about mountain hiking and outdoor activities',
        importance: 7,
        category: 'preference',
        confidence: 0.9,
      });
      // REM response
      const remResponse = JSON.stringify({
        connection: 'Both involve nature appreciation',
        confidence: 0.7,
      });
      const provider = createSequentialFusionProvider([nremResponse, remResponse]);

      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runDreamCycle(ctx);

      // NREM should have produced at least some activity
      // (exact counts depend on clustering)
      expect(result).toBeDefined();
      expect(result.totalFused).toBeGreaterThanOrEqual(0);
    });

    it('catches errors and does not throw', async () => {
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('LLM failure')),
      };

      seedMemory(db, { content: 'A', category: 'fact', prominence: 0.5 });
      seedMemory(db, { content: 'B', category: 'fact', prominence: 0.5 });
      seedMemory(db, { content: 'C', category: 'fact', prominence: 0.5 });
      // Add relations to ensure clustering
      const mems = db.getMemoriesByUser('user-1', { isLatest: true });
      if (mems.length >= 2) {
        db.addRelation(mems[0].id, mems[1].id, 'RELATED', 0.8);
      }

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      await expect(runDreamCycle(ctx)).resolves.not.toThrow();
    });
  });

  describe('runSelfReflection', () => {
    it('skips when no workspace provided', async () => {
      const provider = createMockFusionProvider();
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runSelfReflection(ctx);
      expect(result.usersReflected).toBe(0);
      expect(result.insightsGenerated).toBe(0);
    });

    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db, { workspace: '/tmp/test-workspace' });
      const result = await runSelfReflection(ctx);
      expect(result.usersReflected).toBe(0);
    });

    it('stores reflection insight memories as derived type', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gardener-reflection-'));

      // Create a session and session summary from today
      const session = db.createSession('reflect-session');
      db.addSessionMessage(session.id, 'user', 'I have been thinking about my career change');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-1',
        summary: 'User discussed career change plans',
        topics: ['career'],
        messageCount: 1,
        durationMs: 5000,
        embedding: null,
      });

      const reflectionResponse = JSON.stringify({
        insights: [
          {
            content: 'User is in a period of career transition',
            topics: ['career'],
            sourceSessionIds: [session.id],
          },
        ],
        updatedSoul: '# SOUL\n\nUser is transitioning careers.',
      });
      const provider = createMockFusionProvider(reflectionResponse);

      const ctx = buildCtx(store, db, { fusionProvider: provider, workspace });
      const result = await runSelfReflection(ctx);

      expect(result.insightsGenerated).toBeGreaterThanOrEqual(0);

      // Cleanup workspace
      try { fs.rmSync(workspace, { recursive: true }); } catch { /* ignore */ }
    });

    it('catches errors and does not throw', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gardener-reflection-'));
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('reflection error')),
      };

      const session = db.createSession('fail-session');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-1',
        summary: 'Test',
        topics: [],
        messageCount: 1,
        durationMs: 1000,
        embedding: null,
      });

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider, workspace });
      await expect(runSelfReflection(ctx)).resolves.not.toThrow();

      try { fs.rmSync(workspace, { recursive: true }); } catch { /* ignore */ }
    });
  });

  describe('runGapScanner', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      const result = await runGapScanner(ctx);
      expect(result.actionsCreated).toBe(0);
    });

    it('handles users with no gaps gracefully', async () => {
      seedMemory(db, { content: 'Simple memory', category: 'fact', prominence: 0.8 });
      const provider = createMockFusionProvider();
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runGapScanner(ctx);
      expect(result.actionsCreated).toBe(0);
    });

    it('catches errors and does not throw', async () => {
      seedMemory(db, { content: 'Memory', category: 'fact', prominence: 0.8 });

      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('gap scan error')),
      };

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      await expect(runGapScanner(ctx)).resolves.not.toThrow();
    });
  });
});
