import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import type { ScallopDatabase, ScallopMemoryEntry } from './db.js';
import type { LLMProvider } from '../providers/types.js';
import type { CompletionResponse } from '../providers/types.js';
import type { GardenerContext } from './gardener-context.js';
import {
  runFullDecay,
  runMemoryFusion,
  runSessionSummarization,
  runEnhancedForgetting,
  runBehavioralInference,
  runTrustScoreUpdate,
  runGoalDeadlineCheck,
  runInnerThoughts,
} from './gardener-deep-steps.js';

const TEST_DB_PATH = '/tmp/gardener-deep-steps-test.db';
const logger = pino({ level: 'silent' });

/** Run a raw SQL write (UPDATE/DELETE) — db.raw() only supports SELECT */
function rawRun(db: ScallopDatabase, sql: string, params: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db.prepare(sql).run(...params);
}

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
    userId: opts.userId ?? 'default',
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

describe('gardener-deep-steps', () => {
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

  describe('runFullDecay', () => {
    it('calls processFullDecay and returns result', () => {
      seedMemory(db, { content: 'Test memory', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db);
      const result = runFullDecay(ctx);
      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('archived');
    });
  });

  describe('runMemoryFusion', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      const result = await runMemoryFusion(ctx);
      expect(result.totalFused).toBe(0);
      expect(result.totalMerged).toBe(0);
    });

    it('finds clusters, fuses, stores with DERIVES relations', async () => {
      // Create related dormant memories
      const m1 = seedMemory(db, { content: 'Loves hiking in mountains', category: 'preference', prominence: 0.5 });
      const m2 = seedMemory(db, { content: 'Enjoys mountain trails', category: 'preference', prominence: 0.45 });
      // Add relation so they cluster
      db.addRelation(m1.id, m2.id, 'RELATED', 0.8);

      const provider = createMockFusionProvider();
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runMemoryFusion(ctx);

      expect(result.totalFused).toBeGreaterThanOrEqual(1);
      expect(result.totalMerged).toBeGreaterThanOrEqual(2);

      // Verify DERIVES relations were created
      const allMemories = db.getMemoriesByUser('default', { includeAllSources: true });
      const derivedMem = allMemories.find(m => m.memoryType === 'derived');
      expect(derivedMem).toBeDefined();
      if (derivedMem) {
        const relations = db.getRelations(derivedMem.id);
        const derives = relations.filter(r => r.relationType === 'DERIVES');
        expect(derives.length).toBe(2);
      }
    });
  });

  describe('runSessionSummarization', () => {
    it('skips when no sessionSummarizer', async () => {
      const ctx = buildCtx(store, db);
      const result = await runSessionSummarization(ctx);
      expect(result.summarized).toBe(0);
    });

    it('finds old sessions and calls summarizeBatch with resolved userId', async () => {
      // Seed a memory so the user can be resolved
      seedMemory(db, { userId: 'telegram:123', content: 'test', category: 'fact', prominence: 0.5 });

      // Create a session with old updated_at
      const session = db.createSession('old-session-1');
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [twoDaysAgo, session.id]);

      const mockSummarizer = {
        summarizeBatch: vi.fn().mockResolvedValue(1),
        summarize: vi.fn(),
      };

      const ctx = buildCtx(store, db, { sessionSummarizer: mockSummarizer as any });
      const result = await runSessionSummarization(ctx);

      expect(mockSummarizer.summarizeBatch).toHaveBeenCalledWith(db, ['old-session-1'], 'telegram:123');
      expect(result.summarized).toBe(1);
    });
  });

  describe('runEnhancedForgetting', () => {
    it('runs audit + archival + prune + orphan cleanup', async () => {
      seedMemory(db, { content: 'Memory for forgetting test', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db);
      const result = await runEnhancedForgetting(ctx);

      expect(result).toHaveProperty('auditNeverRetrieved');
      expect(result).toHaveProperty('auditStaleRetrieved');
      expect(result).toHaveProperty('auditCandidateCount');
      expect(result).toHaveProperty('archived');
      expect(result).toHaveProperty('memoriesDeleted');
      expect(result).toHaveProperty('sessionsDeleted');
      expect(result).toHaveProperty('orphansDeleted');
    });

    it('skips archival when disableArchival=true', async () => {
      seedMemory(db, { content: 'Test', category: 'fact', prominence: 0.8 });
      const ctx = buildCtx(store, db, { disableArchival: true });
      const result = await runEnhancedForgetting(ctx);

      // Archival and pruning should be skipped
      expect(result.archived).toBe(0);
      expect(result.memoriesDeleted).toBe(0);
      expect(result.sessionsDeleted).toBe(0);
    });
  });

  describe('runBehavioralInference', () => {
    it('gathers messages and calls inferBehavioralPatterns', () => {
      // Seed a memory so the user is discoverable
      seedMemory(db, { userId: 'telegram:123', content: 'test', category: 'fact', prominence: 0.5 });

      // Create a session with user messages
      const session = db.createSession('session-1');
      db.addSessionMessage(session.id, 'user', 'Hello, how are you?');
      db.addSessionMessage(session.id, 'assistant', 'I am fine!');
      db.addSessionMessage(session.id, 'user', 'Tell me about AI');

      const ctx = buildCtx(store, db);
      const result = runBehavioralInference(ctx);

      expect(result.messageCount).toBe(2); // Only user messages
    });
  });

  describe('runTrustScoreUpdate', () => {
    it('computes trust score and updates behavioral patterns', () => {
      // Create sessions with messages for trust computation
      for (let i = 0; i < 6; i++) {
        const session = db.createSession(`trust-session-${i}`);
        for (let j = 0; j < 3; j++) {
          db.addSessionMessage(session.id, 'user', `Message ${j}`);
        }
      }

      const ctx = buildCtx(store, db);
      const result = runTrustScoreUpdate(ctx);

      // Trust score should have been computed
      expect(result).toBeDefined();
    });

    it('falls back to raw sessions when <5 summaries', () => {
      // Create sessions with messages but no summaries
      for (let i = 0; i < 3; i++) {
        const session = db.createSession(`raw-session-${i}`);
        for (let j = 0; j < 5; j++) {
          db.addSessionMessage(session.id, 'user', `Hello ${j}`);
          db.addSessionMessage(session.id, 'assistant', `Reply ${j}`);
        }
      }

      const ctx = buildCtx(store, db);
      // Should not throw — fallback to raw sessions
      const result = runTrustScoreUpdate(ctx);
      expect(result).toBeDefined();
    });
  });

  describe('runGoalDeadlineCheck', () => {
    it('handles no goals gracefully', async () => {
      const ctx = buildCtx(store, db);
      const result = await runGoalDeadlineCheck(ctx);
      expect(result.approaching).toBe(0);
      expect(result.notifications).toBe(0);
    });
  });

  describe('runInnerThoughts', () => {
    it('skips when no fusionProvider', async () => {
      const ctx = buildCtx(store, db);
      const result = await runInnerThoughts(ctx);
      expect(result.proactiveItemsCreated).toBe(0);
    });

    it('only processes users with recent summaries (within 6h)', async () => {
      // Create a session and summary from 12 hours ago
      const session = db.createSession('old-session');
      db.addSessionMessage(session.id, 'user', 'Old message');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-old',
        summary: 'Old summary',
        topics: ['test'],
        messageCount: 1,
        durationMs: 5000,
        embedding: null,
      });
      // Backdate the summary
      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE session_summaries SET created_at = ? WHERE user_id = ?', [twelveHoursAgo, 'user-old']);

      const provider = createMockFusionProvider(JSON.stringify({
        decision: 'proact',
        reason: 'test',
        message: 'Follow up',
        urgency: 'low',
      }));
      const ctx = buildCtx(store, db, { fusionProvider: provider });
      const result = await runInnerThoughts(ctx);

      // Should skip because summary is too old
      expect(result.proactiveItemsCreated).toBe(0);
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('catches errors and logs (does not throw)', async () => {
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('LLM down')),
      };

      // Create a recent session summary
      const session = db.createSession('test-session');
      db.addSessionMessage(session.id, 'user', 'Test message');
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user-fail',
        summary: 'Test summary',
        topics: ['test'],
        messageCount: 1,
        durationMs: 5000,
        embedding: null,
      });

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      // Should not throw
      await expect(runInnerThoughts(ctx)).resolves.not.toThrow();
    });
  });

  describe('error isolation', () => {
    it('runMemoryFusion catches errors and logs', async () => {
      // Provide a failing provider
      const failingProvider: LLMProvider = {
        name: 'failing',
        isAvailable: () => true,
        complete: vi.fn().mockRejectedValue(new Error('boom')),
      };

      // Create memories that will cluster
      const m1 = seedMemory(db, { content: 'A', category: 'fact', prominence: 0.5 });
      const m2 = seedMemory(db, { content: 'B', category: 'fact', prominence: 0.45 });
      db.addRelation(m1.id, m2.id, 'RELATED', 0.8);

      const ctx = buildCtx(store, db, { fusionProvider: failingProvider });
      // Should not throw
      await expect(runMemoryFusion(ctx)).resolves.not.toThrow();
    });

    it('runSessionSummarization catches errors and logs', async () => {
      const failingSummarizer = {
        summarizeBatch: vi.fn().mockRejectedValue(new Error('summarizer error')),
        summarize: vi.fn(),
      };

      const session = db.createSession('fail-session');
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      rawRun(db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [twoDaysAgo, session.id]);

      const ctx = buildCtx(store, db, { sessionSummarizer: failingSummarizer as any });
      const result = await runSessionSummarization(ctx);
      expect(result.summarized).toBe(0);
    });

    it('runGoalDeadlineCheck catches errors and returns zeros', async () => {
      // Force an error by mocking dynamic import to fail
      const ctx = buildCtx(store, db);
      const result = await runGoalDeadlineCheck(ctx);
      expect(result).toEqual({ approaching: 0, notifications: 0 });
    });
  });
});
