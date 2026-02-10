/**
 * Integration tests for self-reflection wired into BackgroundGardener.sleepTick().
 *
 * Tests the full pipeline: sleepTick -> reflect() -> insight storage -> SOUL.md I/O.
 * Does NOT re-test pure reflect() behavior (covered in reflection.test.ts).
 *
 * Key invariants:
 * - Reflection runs AFTER dream cycle (NREM + REM), not instead of it
 * - Reflection failure does NOT affect dream cycle results
 * - SOUL.md is created on first run, updated on subsequent runs
 * - Insights stored as insight category with learnedFrom='self_reflection'
 * - Reflection skipped when no workspace or no recent sessions
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

const TEST_DB_PATH = '/tmp/gardener-reflection-test.db';
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

/** Valid reflection JSON response */
const VALID_REFLECTION_RESPONSE = JSON.stringify({
  insights: [
    { content: 'User prefers concise responses', topics: ['communication', 'style'] },
    { content: 'Technical topics need more examples', topics: ['technical', 'examples'] },
  ],
  principles: ['Keep responses focused and actionable', 'Include code examples for technical topics'],
});

/** Valid SOUL distillation markdown response */
const VALID_SOUL_RESPONSE = `# Behavioral Guidelines

## Communication Style
Always be concise and actionable in responses. Avoid unnecessary verbosity.

## Technical Topics
When discussing technical subjects, include relevant code examples to illustrate concepts.

## General Principles
- Keep responses focused on the user's actual question
- Provide actionable next steps when possible`;

/** Updated SOUL response (for update test) */
const UPDATED_SOUL_RESPONSE = `# Behavioral Guidelines (Updated)

## Communication Style
Be concise and direct. Use bullet points for clarity.

## Technical Topics
Always include code examples. Prefer real-world examples over contrived ones.

## New Section: User Preferences
- Respect the user's time by being brief
- Proactively suggest related topics`;

/** Valid NREM fusion JSON (for dream cycle) */
const VALID_NREM_FUSION_RESPONSE = JSON.stringify({
  summary: 'Fused insight from NREM',
  importance: 7,
  category: 'insight',
});

/** Valid REM judge JSON */
const VALID_REM_JUDGE_RESPONSE = JSON.stringify({
  novelty: 4,
  plausibility: 4,
  usefulness: 4,
  connection: 'Related morning activities',
  confidence: 0.8,
});

/**
 * Creates a mock LLM provider that distinguishes between reflection, SOUL distillation,
 * NREM fusion, and REM judge prompts by examining prompt content.
 */
function createReflectionProvider(opts?: {
  reflectionResponse?: string;
  soulResponse?: string;
  throwOnReflection?: boolean;
}): LLMProvider {
  return {
    name: 'mock-reflection',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }>; system?: string }) => {
      const userMsg = req.messages[0]?.content ?? '';
      const systemMsg = req.system ?? '';

      // Reflection prompt (generates insights) — identified by the system prompt
      if (systemMsg.includes('self-reflection engine') || userMsg.includes('Analyze these sessions')) {
        if (opts?.throwOnReflection) {
          throw new Error('Reflection LLM failure');
        }
        return {
          content: [{ type: 'text', text: opts?.reflectionResponse ?? VALID_REFLECTION_RESPONSE }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
        } satisfies CompletionResponse;
      }

      // SOUL distillation prompt — identified by "behavioral guidelines distiller"
      if (systemMsg.includes('behavioral guidelines distiller') || userMsg.includes('SOUL guidelines')) {
        if (opts?.throwOnReflection) {
          throw new Error('SOUL distillation LLM failure');
        }
        return {
          content: [{ type: 'text', text: opts?.soulResponse ?? VALID_SOUL_RESPONSE }],
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

/** Seed a memory directly in the DB */
function seedMemory(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts: {
    userId?: string;
    content: string;
    category: 'preference' | 'fact' | 'event' | 'relationship' | 'insight';
    prominence: number;
    importance?: number;
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
    documentDate: Date.now(),
    eventDate: null,
    prominence: opts.prominence,
    lastAccessed: null,
    accessCount: 0,
    sourceChunk: null,
    embedding: null,
    metadata: null,
  });
}

/** Seed a recent session summary (within last 24h) */
function seedRecentSessionSummary(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts?: {
    userId?: string;
    sessionId?: string;
    summary?: string;
    topics?: string[];
    messageCount?: number;
    durationMs?: number;
  },
) {
  const sessionId = opts?.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Create session first (foreign key constraint)
  db.createSession(sessionId);
  return db.addSessionSummary({
    sessionId,
    userId: opts?.userId ?? 'user-1',
    summary: opts?.summary ?? 'User asked about TypeScript generics. Discussed type inference and mapped types. User seemed satisfied with code examples.',
    topics: opts?.topics ?? ['typescript', 'generics', 'type-inference'],
    messageCount: opts?.messageCount ?? 8,
    durationMs: opts?.durationMs ?? 300000,
    embedding: null,
  });
}

/** Seed an old session summary (>24h ago) by temporarily mocking Date.now */
function seedOldSessionSummary(
  db: ReturnType<ScallopMemoryStore['getDatabase']>,
  opts?: {
    userId?: string;
    sessionId?: string;
    messageCount?: number;
  },
) {
  const sessionId = opts?.sessionId ?? `session-old-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Create session first (foreign key constraint)
  db.createSession(sessionId);

  // Temporarily mock Date.now to return a timestamp from 2 days ago
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const originalNow = Date.now;
  Date.now = () => twoDaysAgo;
  try {
    return db.addSessionSummary({
      sessionId,
      userId: opts?.userId ?? 'user-1',
      summary: 'Old session about something from two days ago.',
      topics: ['old-topic'],
      messageCount: opts?.messageCount ?? 8,
      durationMs: 300000,
      embedding: null,
    });
  } finally {
    Date.now = originalNow;
  }
}

// ─── Tests ─────────────────────────────────────────────────────

describe('BackgroundGardener self-reflection integration', () => {
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
    tmpWorkspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'smartbot-reflection-'));
    return tmpWorkspace;
  }

  // ─── Test 1: Generate insights and create SOUL.md on first reflection ─────

  it('should generate insights and create SOUL.md on first reflection', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();
    const fusionProvider = createReflectionProvider();

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

    // Seed 2 recent session summaries with sufficient messages
    seedRecentSessionSummary(db, {
      summary: 'User asked about TypeScript generics. Discussed type inference and mapped types.',
      topics: ['typescript', 'generics'],
      messageCount: 8,
    });
    seedRecentSessionSummary(db, {
      summary: 'User needed help debugging a React component. Solved a state management issue.',
      topics: ['react', 'debugging'],
      messageCount: 6,
    });

    await gardener.sleepTick();

    // Verify: insight memories stored
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const insightMemories = allMemories.filter(
      m => m.category === 'insight' && m.learnedFrom === 'self_reflection'
    );
    expect(insightMemories.length).toBeGreaterThanOrEqual(1);

    // Verify insight properties
    const insight = insightMemories[0];
    expect(insight.memoryType).toBe('derived');
    expect(insight.metadata).toBeDefined();
    expect(insight.metadata!.reflectedAt).toBeDefined();
    expect(insight.metadata!.topics).toBeDefined();
    expect(insight.metadata!.sourceSessionIds).toBeDefined();

    // Verify: SOUL.md file created in workspace
    const soulPath = path.join(workspace, 'SOUL.md');
    const soulContent = await fsPromises.readFile(soulPath, 'utf-8');
    expect(soulContent).toContain('Behavioral Guidelines');
    expect(soulContent.length).toBeGreaterThan(0);
  });

  // ─── Test 2: Update existing SOUL.md with new reflections ─────

  it('should update existing SOUL.md with new reflections', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();

    // Write initial SOUL.md
    const soulPath = path.join(workspace, 'SOUL.md');
    const initialSoul = '# Initial Guidelines\n\nBe helpful and concise.';
    await fsPromises.writeFile(soulPath, initialSoul, 'utf-8');

    const fusionProvider = createReflectionProvider({
      soulResponse: UPDATED_SOUL_RESPONSE,
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

    // Seed recent session summaries
    seedRecentSessionSummary(db, { messageCount: 10 });

    await gardener.sleepTick();

    // Verify: SOUL.md content was updated (not the initial content)
    const updatedContent = await fsPromises.readFile(soulPath, 'utf-8');
    expect(updatedContent).not.toBe(initialSoul);
    expect(updatedContent).toContain('Updated');

    // Verify: mock provider received existing SOUL content in the distillation prompt
    const completeCalls = (fusionProvider.complete as ReturnType<typeof vi.fn>).mock.calls;
    const soulDistillationCall = completeCalls.find(
      (call: unknown[]) => {
        const req = call[0] as { system?: string };
        return req.system?.includes('behavioral guidelines distiller');
      }
    );
    expect(soulDistillationCall).toBeDefined();
    const soulReqMsg = (soulDistillationCall![0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(soulReqMsg).toContain('Initial Guidelines');
  });

  // ─── Test 3: Skip reflection when no recent session summaries ─────

  it('should skip reflection when no recent session summaries', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();
    const fusionProvider = createReflectionProvider();

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

    // Seed only old session summaries (>24h ago)
    seedOldSessionSummary(db, { messageCount: 10 });
    seedOldSessionSummary(db, { messageCount: 8 });

    await gardener.sleepTick();

    // Verify: no insight memories created
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const insightMemories = allMemories.filter(
      m => m.category === 'insight' && m.learnedFrom === 'self_reflection'
    );
    expect(insightMemories.length).toBe(0);

    // Verify: SOUL.md not created
    const soulPath = path.join(workspace, 'SOUL.md');
    let soulExists = true;
    try { await fsPromises.access(soulPath); } catch { soulExists = false; }
    expect(soulExists).toBe(false);
  });

  // ─── Test 4: Skip reflection when sessions have too few messages ─────

  it('should skip reflection when sessions have too few messages', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();
    const fusionProvider = createReflectionProvider();

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

    // Seed session summary with very few messages (below minMessagesPerSession=3 threshold)
    seedRecentSessionSummary(db, { messageCount: 1 });

    await gardener.sleepTick();

    // Verify: no insight memories created (reflect() should return skipped)
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const insightMemories = allMemories.filter(
      m => m.category === 'insight' && m.learnedFrom === 'self_reflection'
    );
    expect(insightMemories.length).toBe(0);

    // Verify: SOUL.md not created
    const soulPath = path.join(workspace, 'SOUL.md');
    let soulExists = true;
    try { await fsPromises.access(soulPath); } catch { soulExists = false; }
    expect(soulExists).toBe(false);
  });

  // ─── Test 5: Dream cycle unaffected by reflection failure ─────

  it('should not affect dream cycle on reflection failure', async () => {
    cleanupTestDb();
    const workspace = await createTmpWorkspace();

    // Provider succeeds for NREM/REM but throws on reflection
    const fusionProvider = createReflectionProvider({ throwOnReflection: true });

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
    const m1 = seedMemory(db, { content: 'Enjoys morning walks in the park', category: 'preference', prominence: 0.4 });
    const m2 = seedMemory(db, { content: 'Likes listening to podcasts while walking', category: 'preference', prominence: 0.38 });
    const m3 = seedMemory(db, { content: 'Usually walks for 30 minutes', category: 'fact', prominence: 0.35 });
    const m4 = seedMemory(db, { content: 'Prefers walking over running', category: 'preference', prominence: 0.42 });

    // Connect them for NREM clustering
    db.addRelation(m1.id, m2.id, 'EXTENDS', 0.8);
    db.addRelation(m2.id, m3.id, 'EXTENDS', 0.7);
    db.addRelation(m3.id, m4.id, 'EXTENDS', 0.7);

    // Seed session summaries for reflection
    seedRecentSessionSummary(db, { messageCount: 10 });

    // sleepTick should not throw
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // Verify: NREM fused memories were created (dream succeeded)
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const nremMemories = allMemories.filter(m => m.learnedFrom === 'nrem_consolidation');
    expect(nremMemories.length).toBeGreaterThanOrEqual(1);

    // Verify: no self_reflection insight memories (reflection failed)
    const reflectionMemories = allMemories.filter(m => m.learnedFrom === 'self_reflection');
    expect(reflectionMemories.length).toBe(0);

    // Verify: SOUL.md not created (reflection failed before writing)
    const soulPath = path.join(workspace, 'SOUL.md');
    let soulExists = true;
    try { await fsPromises.access(soulPath); } catch { soulExists = false; }
    expect(soulExists).toBe(false);
  });

  // ─── Test 6: Skip reflection when no workspace configured ─────

  it('should skip reflection when no workspace configured', async () => {
    cleanupTestDb();
    const fusionProvider = createReflectionProvider();

    store = new ScallopMemoryStore({
      dbPath: TEST_DB_PATH,
      logger,
      embedder: createMockEmbedder(),
    });
    gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      fusionProvider,
      // No workspace option
    });

    const db = store.getDatabase();

    // Seed session summaries
    seedRecentSessionSummary(db, { messageCount: 10 });

    // sleepTick should complete without error
    await expect(gardener.sleepTick()).resolves.not.toThrow();

    // Verify: no insight memories created
    const allMemories = db.getMemoriesByUser('user-1', { includeAllSources: true });
    const insightMemories = allMemories.filter(
      m => m.category === 'insight' && m.learnedFrom === 'self_reflection'
    );
    expect(insightMemories.length).toBe(0);
  });
});
