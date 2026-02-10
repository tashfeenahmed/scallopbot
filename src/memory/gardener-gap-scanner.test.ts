/**
 * Integration tests for gap scanner pipeline wired into BackgroundGardener.sleepTick().
 *
 * Tests the full pipeline: sleepTick -> scanForGaps -> diagnoseGaps -> createGapActions -> scheduled item insertion.
 * Does NOT re-test pure gap-scanner/diagnosis/actions behavior (covered in their own tests).
 *
 * Key invariants:
 * - Gap scanner runs AFTER dream cycle and self-reflection
 * - Gap scanner failure does NOT affect dream cycle or reflection results
 * - Gap scanner is gated on fusionProvider (skipped when absent)
 * - Proactiveness dial gates which actions pass through
 * - No signals means no LLM calls and no scheduled items
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import pino from 'pino';
import {
  ScallopMemoryStore,
  BackgroundGardener,
  type EmbeddingProvider,
} from './index.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

// ─── Shared Helpers ─────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/gardener-gap-scanner-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch { /* noop */ }
  }
}

/** Simple mock embedder that returns zero vectors */
function createMockEmbedder(): EmbeddingProvider {
  return {
    name: 'mock-embedder',
    dimension: 32,
    embed: vi.fn().mockResolvedValue(new Array(32).fill(0)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => new Array(32).fill(0))),
    ),
    isAvailable: () => true,
  };
}

/** Valid gap diagnosis LLM response — marks signal as actionable with high confidence */
function makeGapDiagnosisResponse(opts?: { actionable?: boolean; confidence?: number }) {
  return JSON.stringify({
    gaps: [{
      index: 0,
      actionable: opts?.actionable ?? true,
      confidence: opts?.confidence ?? 0.8,
      diagnosis: 'This goal has not been updated in a while.',
      suggestedAction: 'Check in on the stale goal and update progress.',
    }],
  });
}

/** Valid NREM fusion JSON (for dream cycle passthrough) */
const VALID_NREM_FUSION_RESPONSE = JSON.stringify({
  summary: 'Fused insight from NREM',
  importance: 7,
  category: 'insight',
});

/** Valid REM judge JSON (for dream cycle passthrough) */
const VALID_REM_JUDGE_RESPONSE = JSON.stringify({
  novelty: 4,
  plausibility: 4,
  usefulness: 4,
  connection: 'Related morning activities',
  confidence: 0.8,
});

/** Valid reflection JSON (for reflection passthrough) */
const VALID_REFLECTION_RESPONSE = JSON.stringify({
  insights: [
    { content: 'User prefers concise responses', topics: ['communication'] },
  ],
  principles: ['Keep responses focused'],
});

/** Valid SOUL distillation markdown (for reflection passthrough) */
const VALID_SOUL_RESPONSE = `# Behavioral Guidelines\n\nBe concise.`;

/**
 * Creates a mock LLM provider that distinguishes between gap diagnosis calls
 * vs dream/reflection calls by examining prompt content.
 */
function createGapScannerProvider(opts?: {
  gapDiagnosisResponse?: string;
  throwOnGapDiagnosis?: boolean;
}): LLMProvider {
  return {
    name: 'mock-gap-scanner',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }>; system?: string }) => {
      const userMsg = req.messages[0]?.content ?? '';
      const systemMsg = req.system ?? '';

      // Gap diagnosis prompt — identified by "SIGNALS TO TRIAGE"
      if (userMsg.includes('SIGNALS TO TRIAGE')) {
        if (opts?.throwOnGapDiagnosis) {
          throw new Error('Gap diagnosis LLM failure');
        }
        return {
          content: [{ type: 'text', text: opts?.gapDiagnosisResponse ?? makeGapDiagnosisResponse() }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }

      // Reflection prompt
      if (systemMsg.includes('self-reflection engine') || userMsg.includes('Analyze these sessions')) {
        return {
          content: [{ type: 'text', text: VALID_REFLECTION_RESPONSE }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }

      // SOUL distillation prompt
      if (systemMsg.includes('behavioral guidelines distiller') || userMsg.includes('SOUL guidelines')) {
        return {
          content: [{ type: 'text', text: VALID_SOUL_RESPONSE }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }

      // REM judge prompts
      if (userMsg.includes('SEED MEMORY:') && userMsg.includes('DISCOVERED NEIGHBOR:')) {
        return {
          content: [{ type: 'text', text: VALID_REM_JUDGE_RESPONSE }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }

      // NREM/other prompts — return default fusion
      return {
        content: [{ type: 'text', text: VALID_NREM_FUSION_RESPONSE }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'mock-model',
      } satisfies CompletionResponse;
    }),
  };
}

/** Seed a memory directly in the DB (needed for user row to exist in memories table) */
function seedMemory(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    importance?: number;
    metadata?: Record<string, unknown> | null;
    documentDate?: number;
  },
) {
  return db.addMemory({
    userId: opts.userId ?? 'user-1',
    content: opts.content,
    category: opts.category,
    memoryType: 'regular',
    importance: opts.importance ?? 6,
    confidence: 0.8,
    isLatest: true,
    source: 'user',
    documentDate: opts.documentDate ?? Date.now(),
    eventDate: null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: opts.metadata ?? null,
  });
}

/** Seed a goal as an insight memory with GoalMetadata */
function seedStaleGoal(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts?: {
    userId?: string;
    title?: string;
    daysOld?: number;
    dueDate?: number;
    status?: string;
  },
) {
  const daysOld = opts?.daysOld ?? 20;
  const oldTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

  // Temporarily mock Date.now so updated_at is set to old time
  const originalNow = Date.now;
  Date.now = () => oldTime;
  try {
    return db.addMemory({
      userId: opts?.userId ?? 'user-1',
      content: opts?.title ?? 'Learn Rust programming',
      category: 'insight',
      memoryType: 'regular',
      importance: 7,
      confidence: 0.9,
      isLatest: true,
      source: 'user',
      documentDate: oldTime,
      eventDate: null,
      prominence: 0.8,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: {
        goalType: 'goal',
        status: opts?.status ?? 'active',
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

/** Seed a recently-updated goal (should NOT trigger stale detection) */
function seedFreshGoal(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts?: { userId?: string; title?: string },
) {
  return db.addMemory({
    userId: opts?.userId ?? 'user-1',
    content: opts?.title ?? 'Active fresh goal',
    category: 'insight',
    memoryType: 'regular',
    importance: 7,
    confidence: 0.9,
    isLatest: true,
    source: 'user',
    documentDate: Date.now(),
    eventDate: null,
    prominence: 0.8,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: {
      goalType: 'goal',
      status: 'active',
    },
  });
}

/** Seed a recent session summary */
function seedRecentSessionSummary(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts?: {
    userId?: string;
    sessionId?: string;
    topics?: string[];
    messageCount?: number;
  },
) {
  const sessionId = opts?.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.createSession(sessionId);
  return db.addSessionSummary({
    sessionId,
    userId: opts?.userId ?? 'user-1',
    summary: 'User discussed various topics in this session.',
    topics: opts?.topics ?? ['typescript', 'testing'],
    messageCount: opts?.messageCount ?? 8,
    durationMs: 300000,
    embedding: null,
  });
}

// ─── Tests ─────────────────────────────────────────────────────

describe('BackgroundGardener gap scanner integration', () => {
  let store: ScallopMemoryStore;
  let gardener: BackgroundGardener;
  let tmpWorkspace: string | null = null;

  afterEach(async () => {
    if (gardener) gardener.stop();
    if (store) store.close();
    cleanupTestDb();
    if (tmpWorkspace) {
      try { await fsPromises.rm(tmpWorkspace, { recursive: true, force: true }); } catch { /* noop */ }
      tmpWorkspace = null;
    }
  });

  async function createTmpWorkspace(): Promise<string> {
    tmpWorkspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'smartbot-gap-scanner-'));
    return tmpWorkspace;
  }

  // ─── Test 1: Creates scheduled items when stale goals detected ─────

  it('creates scheduled items when stale goals detected', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();
    const fusionProvider = createGapScannerProvider();

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
      workspace,
    });

    const db = store.getDatabase();

    // Seed a stale goal (20 days old, exceeds 14-day STALE_THRESHOLD_DAYS)
    seedStaleGoal(db, { title: 'Learn Rust programming', daysOld: 20 });

    // Seed a session summary so the user shows up in memory queries
    seedRecentSessionSummary(db);

    await gardener.sleepTick();

    // Verify: scheduled items created
    const items = db.getScheduledItemsByUser('user-1');
    const gapItems = items.filter(i => i.type === 'follow_up' && i.source === 'agent');
    expect(gapItems.length).toBeGreaterThanOrEqual(1);

    // Verify the item has gap context
    const item = gapItems[0];
    expect(item.message).toBeTruthy();
    expect(item.context).toBeTruthy();
    const context = JSON.parse(item.context!);
    expect(context.gapType).toBe('stale_goal');
  });

  // ─── Test 2: Skips gap scanner when no fusionProvider ─────

  it('skips gap scanner when no fusionProvider', async () => {
    cleanupTestDb();

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    // No fusionProvider
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
    });

    const db = store.getDatabase();

    // Seed a stale goal
    seedStaleGoal(db);
    seedRecentSessionSummary(db);

    // sleepTick should complete without error
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // Verify: no scheduled items created
    const items = db.getScheduledItemsByUser('user-1');
    const gapItems = items.filter(i => i.type === 'follow_up' && i.source === 'agent');
    expect(gapItems.length).toBe(0);
  });

  // ─── Test 3: Skips gap scanner when no signals detected ─────

  it('skips gap scanner when no signals detected', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();
    const fusionProvider = createGapScannerProvider();

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
      workspace,
    });

    const db = store.getDatabase();

    // Seed a FRESH goal (just created, not stale)
    seedFreshGoal(db);
    seedRecentSessionSummary(db);

    await gardener.sleepTick();

    // Verify: no scheduled items created (Stage 1 returns empty)
    const items = db.getScheduledItemsByUser('user-1');
    const gapItems = items.filter(i => i.type === 'follow_up' && i.source === 'agent');
    expect(gapItems.length).toBe(0);

    // Verify: gap diagnosis LLM was NOT called (no signals to diagnose)
    const completeCalls = (fusionProvider.complete as ReturnType<typeof vi.fn>).mock.calls;
    const gapDiagnosisCalls = completeCalls.filter(
      (call: unknown[]) => {
        const req = call[0] as { messages: Array<{ content: string }> };
        return req.messages[0]?.content?.includes('SIGNALS TO TRIAGE');
      },
    );
    expect(gapDiagnosisCalls.length).toBe(0);
  });

  // ─── Test 4: Error isolation — gap scanner failure does not affect dream/reflection ─────

  it('error isolation: gap scanner failure does not affect dream/reflection', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();

    // Provider throws on gap diagnosis but succeeds for everything else
    const fusionProvider = createGapScannerProvider({ throwOnGapDiagnosis: true });

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
      workspace,
    });

    const db = store.getDatabase();

    // Seed memories for dream cycle (NREM)
    seedMemory(db, { content: 'Enjoys morning walks in the park', category: 'preference', prominence: 0.4 });
    const m2 = seedMemory(db, { content: 'Likes listening to podcasts while walking', category: 'preference', prominence: 0.38 });
    const m3 = seedMemory(db, { content: 'Usually walks for 30 minutes', category: 'fact', prominence: 0.35 });
    const m4 = seedMemory(db, { content: 'Prefers walking over running', category: 'preference', prominence: 0.42 });
    const m1 = db.getMemoriesByUser('user-1', { includeAllSources: true })[0];

    // Connect them for NREM clustering
    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    // Seed a stale goal to trigger gap scanner (which will fail)
    seedStaleGoal(db);

    // Seed session summaries for reflection
    seedRecentSessionSummary(db, { messageCount: 10 });

    // sleepTick should not throw (error isolated)
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // Verify: NREM fused memories were created (dream cycle succeeded)
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const nremMemories = allMemories.filter(m => m.learnedFrom === 'nrem_consolidation');
    expect(nremMemories.length).toBeGreaterThanOrEqual(1);

    // Verify: reflection insights were created (reflection succeeded)
    const reflectionMemories = allMemories.filter(m => m.learnedFrom === 'self_reflection');
    expect(reflectionMemories.length).toBeGreaterThanOrEqual(1);

    // Verify: no gap scanner scheduled items (gap scanner failed)
    const items = db.getScheduledItemsByUser('user-1');
    const gapItems = items.filter(i => i.type === 'follow_up' && i.source === 'agent');
    expect(gapItems.length).toBe(0);
  });

  // ─── Test 5: Respects proactiveness dial gating ─────

  it('respects proactiveness dial gating', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();

    // Mock LLM: diagnoses signal as actionable but with LOW confidence (0.4)
    // Conservative dial requires minConfidence 0.7, so this should be filtered out
    const fusionProvider = createGapScannerProvider({
      gapDiagnosisResponse: makeGapDiagnosisResponse({ actionable: true, confidence: 0.4 }),
    });

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
      workspace,
    });

    const db = store.getDatabase();

    // Seed a stale goal (will produce a signal)
    seedStaleGoal(db, { daysOld: 20 });

    // Seed session summary
    seedRecentSessionSummary(db);

    // Set behavioral patterns with conservative dial
    const profileManager = store.getProfileManager();
    profileManager.updateBehavioralPatterns('user-1', {
      responsePreferences: {
        proactivenessDial: 'conservative',
        trustScore: 0.3,
      },
    });

    await gardener.sleepTick();

    // Verify: gap diagnosis LLM WAS called (signals were found)
    const completeCalls = (fusionProvider.complete as ReturnType<typeof vi.fn>).mock.calls;
    const gapDiagnosisCalls = completeCalls.filter(
      (call: unknown[]) => {
        const req = call[0] as { messages: Array<{ content: string }> };
        return req.messages[0]?.content?.includes('SIGNALS TO TRIAGE');
      },
    );
    expect(gapDiagnosisCalls.length).toBeGreaterThanOrEqual(1);

    // Verify: no scheduled items created (conservative dial + low confidence = filtered)
    const items = db.getScheduledItemsByUser('user-1');
    const gapItems = items.filter(i => i.type === 'follow_up' && i.source === 'agent');
    expect(gapItems.length).toBe(0);
  });
});
