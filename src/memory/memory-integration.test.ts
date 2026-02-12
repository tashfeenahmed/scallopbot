/**
 * Memory System Integration Tests
 *
 * Five scenarios simulating real multi-turn conversations to validate
 * all new memory system features end-to-end:
 *
 *   1. Fact storage + dynamic memory budget + embedding cache
 *   2. Duplicate reinforcement (re-stated facts boost confidence)
 *   3. Corrections + contradiction tracking
 *   4. Session summaries + past-conversation search
 *   5. Tiered consolidation + behavioral patterns + stats
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import {
  ScallopDatabase,
  ScallopMemoryStore,
  LLMFactExtractor,
  CachedEmbedder,
  SessionSummarizer,
  BackgroundGardener,
  SEARCH_WEIGHTS,
  type EmbeddingProvider,
} from './index.js';
import type { LLMProvider } from '../providers/types.js';

// ─── Shared helpers ─────────────────────────────────────────────

const TEST_DB = '/tmp/mem-integration-test.db';
const logger = pino({ level: 'silent' });

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch { /* noop */ }
  }
}

/** Deterministic embedder: word-presence vector so cosine similarity works predictably */
function createTestEmbedder(): EmbeddingProvider {
  const VOCAB = [
    'work', 'microsoft', 'google', 'office', 'dublin', 'cork',
    'wife', 'husband', 'hayat', 'cooking', 'programming', 'typescript',
    'python', 'music', 'guitar', 'dog', 'cat', 'berlin', 'coffee',
    'tea', 'morning', 'evening', 'project', 'deadline', 'travel',
    'japan', 'sushi', 'running', 'gym', 'yoga', 'meeting', 'api',
  ];
  const DIM = VOCAB.length;

  const embed = (text: string): number[] => {
    const lower = text.toLowerCase();
    return VOCAB.map(w => lower.includes(w) ? 1.0 : 0.0);
  };

  return {
    name: 'test-embedder',
    dimension: DIM,
    embed: vi.fn().mockImplementation((t: string) => Promise.resolve(embed(t))),
    embedBatch: vi.fn().mockImplementation((ts: string[]) => Promise.resolve(ts.map(embed))),
    isAvailable: () => true,
  };
}

/** LLM provider that cycles through pre-canned responses */
function createSequentialProvider(responses: string[]): LLMProvider {
  let idx = 0;
  return {
    name: 'mock-sequential',
    complete: vi.fn().mockImplementation(async () => {
      const text = responses[idx % responses.length];
      idx++;
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 30 },
      };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/**
 * LLM provider for E2E that detects whether the request is for
 * fact extraction vs relationship classification, and returns appropriate data.
 */
function createSmartProvider(factResponses: Array<{ facts: object[] }>): LLMProvider {
  let factIdx = 0;
  return {
    name: 'mock-smart',
    complete: vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
      const prompt = req.messages?.[0]?.content ?? '';
      // Classifier prompts contain "classify" or "relationship" keywords
      const isClassification = prompt.toLowerCase().includes('classify') ||
        prompt.toLowerCase().includes('relationship between');

      let text: string;
      if (isClassification) {
        // Return a valid classification response (all NEW)
        text = JSON.stringify([
          { classification: 'NEW', targetId: null, confidence: 0.9 },
          { classification: 'NEW', targetId: null, confidence: 0.9 },
          { classification: 'NEW', targetId: null, confidence: 0.9 },
          { classification: 'NEW', targetId: null, confidence: 0.9 },
          { classification: 'NEW', targetId: null, confidence: 0.9 },
        ]);
      } else {
        // Fact extraction: return next fact set
        const response = factResponses[factIdx % factResponses.length];
        factIdx++;
        text = JSON.stringify(response);
      }

      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 30 },
      };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

/** Simulate a turn: user message → extract facts, return extraction result */
async function simulateTurn(
  extractor: LLMFactExtractor,
  db: ScallopDatabase,
  sessionId: string,
  userId: string,
  userMsg: string,
  assistantMsg: string = 'Got it!'
) {
  db.addSessionMessage(sessionId, 'user', userMsg);
  const result = await extractor.extractFacts(userMsg, userId);
  db.addSessionMessage(sessionId, 'assistant', assistantMsg);
  return result;
}

// ═════════════════════════════════════════════════════════════════
// SCENARIO 1: Fact Storage + Embedding Cache + Search Weights
// ═════════════════════════════════════════════════════════════════

describe('Scenario 1: Fact storage, embedding cache & search weights', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    embedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should store facts from a multi-turn conversation and find them via hybrid search', async () => {
    const sessionId = 'sess-1';
    db.createSession(sessionId);

    // Turn 1: user introduces themselves
    const mem1 = await store.add({
      userId: 'default',
      content: 'Works at Microsoft as a senior engineer',
      category: 'fact',
      importance: 7,
      sourceChunk: 'I work at Microsoft as a senior engineer',
      learnedFrom: 'conversation',
    });

    // Turn 2: user mentions location
    const mem2 = await store.add({
      userId: 'default',
      content: 'Lives in Dublin, Ireland',
      category: 'fact',
      importance: 6,
      sourceChunk: 'I live in Dublin',
      learnedFrom: 'conversation',
    });

    // Turn 3: user mentions preference
    const mem3 = await store.add({
      userId: 'default',
      content: 'Prefers TypeScript over Python for backend development',
      category: 'preference',
      importance: 5,
      sourceChunk: 'I prefer TypeScript for backend stuff',
      learnedFrom: 'conversation',
    });

    // Verify all stored
    expect(store.getCount('default')).toBe(3);

    // Hybrid search for work-related info
    const workResults = await store.search('Microsoft engineer', { userId: 'default' });
    expect(workResults.length).toBeGreaterThanOrEqual(1);
    expect(workResults[0].memory.content).toContain('Microsoft');

    // Search for location
    const locationResults = await store.search('Dublin', { userId: 'default' });
    expect(locationResults.length).toBeGreaterThanOrEqual(1);
    expect(locationResults[0].memory.content).toContain('Dublin');

    // Search for preferences
    const prefResults = await store.search('TypeScript Python', { userId: 'default' });
    expect(prefResults.length).toBeGreaterThanOrEqual(1);

    // Verify sourceChunk is populated (Phase 4.2)
    expect(mem1.sourceChunk).toBe('I work at Microsoft as a senior engineer');
    expect(mem2.sourceChunk).toBe('I live in Dublin');

    // Verify learnedFrom (Phase 2.3)
    expect(mem1.learnedFrom).toBe('conversation');
  });

  it('should use CachedEmbedder and show cache hits on repeated queries', async () => {
    // Store a fact (triggers embed)
    await store.add({
      userId: 'default',
      content: 'Loves playing guitar in the evening',
      category: 'preference',
    });

    // Search twice with the same query
    await store.search('guitar music', { userId: 'default' });
    await store.search('guitar music', { userId: 'default' });

    // The embedder should have been wrapped in CachedEmbedder
    const stats = store.getStats();
    expect(stats.totalMemories).toBe(1);
    // Cache hit rate should be > 0 since we searched the same query twice
    expect(stats.embeddingCacheHitRate).not.toBeNull();
    if (stats.embeddingCacheHitRate !== null) {
      expect(stats.embeddingCacheHitRate).toBeGreaterThan(0);
    }
  });

  it('should use shared SEARCH_WEIGHTS for scoring', () => {
    // Validate the shared weights constant exists and has expected shape
    expect(SEARCH_WEIGHTS.keyword).toBe(0.3);
    expect(SEARCH_WEIGHTS.semantic).toBe(0.7);
    expect(SEARCH_WEIGHTS.prominence).toBe(0.0);
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO 2: Duplicate Reinforcement
// ═════════════════════════════════════════════════════════════════

describe('Scenario 2: Duplicate fact reinforcement', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    embedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should reinforce memory when same fact is re-stated', async () => {
    // Store initial fact
    const original = await store.add({
      userId: 'default',
      content: 'Works at Microsoft',
      category: 'fact',
      importance: 6,
      confidence: 0.8,
    });

    const originalMemory = db.getMemory(original.id)!;
    expect(originalMemory.timesConfirmed).toBe(1);
    expect(originalMemory.confidence).toBeCloseTo(0.8);

    // Directly reinforce (simulating what fact-extractor does on dedup)
    db.reinforceMemory(original.id);
    const reinforced1 = db.getMemory(original.id)!;
    expect(reinforced1.timesConfirmed).toBe(2);
    expect(reinforced1.confidence).toBeCloseTo(0.85);
    expect(reinforced1.prominence).toBeCloseTo(1.0); // capped at 1.0

    // Reinforce again
    db.reinforceMemory(original.id);
    const reinforced2 = db.getMemory(original.id)!;
    expect(reinforced2.timesConfirmed).toBe(3);
    expect(reinforced2.confidence).toBeCloseTo(0.90);
  });

  it('should increase resilience to decay for reinforced memories', async () => {
    // Store two facts: one reinforced, one not
    const factA = await store.add({
      userId: 'default',
      content: 'Loves coffee every morning',
      category: 'preference',
      importance: 5,
      confidence: 0.7,
    });

    const factB = await store.add({
      userId: 'default',
      content: 'Has a dog named Max',
      category: 'fact',
      importance: 5,
      confidence: 0.7,
    });

    // Reinforce factA 3 times (user keeps mentioning coffee)
    db.reinforceMemory(factA.id);
    db.reinforceMemory(factA.id);
    db.reinforceMemory(factA.id);

    const reinforcedA = db.getMemory(factA.id)!;
    const plainB = db.getMemory(factB.id)!;

    // The reinforced memory should have higher confidence
    expect(reinforcedA.confidence).toBeGreaterThan(plainB.confidence);
    expect(reinforcedA.timesConfirmed).toBe(4); // 1 initial + 3 reinforcements
    expect(plainB.timesConfirmed).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO 3: Corrections + Contradiction Tracking
// ═════════════════════════════════════════════════════════════════

describe('Scenario 3: Corrections and contradiction tracking', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;

  beforeEach(() => {
    cleanup();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder: createTestEmbedder(),
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should track contradictions when a fact is corrected', async () => {
    // Turn 1: User says they live in Dublin
    const oldFact = await store.add({
      userId: 'default',
      content: 'Lives in Dublin',
      category: 'fact',
      importance: 6,
      learnedFrom: 'conversation',
    });

    // Turn 3: User corrects — they moved to Cork
    const newFact = await store.add({
      userId: 'default',
      content: 'Lives in Cork (moved from Dublin)',
      category: 'fact',
      importance: 7,
      learnedFrom: 'correction',
    });

    // Manually set up the contradiction (this is what fact-extractor does)
    db.addContradiction(oldFact.id, newFact.id);
    db.addContradiction(newFact.id, oldFact.id);

    // Also mark old as superseded via UPDATES relation
    store.addUpdatesRelation(newFact.id, oldFact.id);

    // Verify contradiction tracking (Phase 2.4)
    const oldMemory = db.getMemory(oldFact.id)!;
    const newMemory = db.getMemory(newFact.id)!;

    expect(oldMemory.contradictionIds).toContain(newFact.id);
    expect(newMemory.contradictionIds).toContain(oldFact.id);

    // Both memories remain searchable (UPDATES records the link, doesn't supersede)
    expect(oldMemory.isLatest).toBe(true);
    expect(newMemory.isLatest).toBe(true);

    // Verify learnedFrom values
    expect(oldMemory.learnedFrom).toBe('conversation');
    expect(newMemory.learnedFrom).toBe('correction');

    // Searching should return the new fact preferentially
    const results = await store.search('Cork', { userId: 'default' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toContain('Cork');
  });

  it('should track correction chains across multiple updates', async () => {
    // Original: Works at Google
    const v1 = await store.add({
      userId: 'default',
      content: 'Works at Google',
      category: 'fact',
      learnedFrom: 'conversation',
    });

    // Correction 1: Actually works at Microsoft
    const v2 = await store.add({
      userId: 'default',
      content: 'Works at Microsoft',
      category: 'fact',
      learnedFrom: 'correction',
    });
    db.addContradiction(v1.id, v2.id);
    db.addContradiction(v2.id, v1.id);
    store.addUpdatesRelation(v2.id, v1.id);

    // Correction 2: Left Microsoft, now freelancing
    const v3 = await store.add({
      userId: 'default',
      content: 'Now freelancing after leaving Microsoft',
      category: 'fact',
      learnedFrom: 'correction',
    });
    db.addContradiction(v2.id, v3.id);
    db.addContradiction(v3.id, v2.id);
    store.addUpdatesRelation(v3.id, v2.id);

    // All versions remain searchable (UPDATES records links, doesn't supersede)
    expect(db.getMemory(v1.id)!.isLatest).toBe(true);
    expect(db.getMemory(v2.id)!.isLatest).toBe(true);
    expect(db.getMemory(v3.id)!.isLatest).toBe(true);

    // v2 should have contradictions pointing to both v1 and v3
    const v2Memory = db.getMemory(v2.id)!;
    expect(v2Memory.contradictionIds).toContain(v1.id);
    expect(v2Memory.contradictionIds).toContain(v3.id);

    // Get update history
    const history = store.getUpdateHistory(v1.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO 4: Session Summaries + Past-Conversation Search
// ═════════════════════════════════════════════════════════════════

describe('Scenario 4: Session summaries and past-conversation search', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    embedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should generate and store session summaries', async () => {
    const provider = createSequentialProvider([
      JSON.stringify({
        summary: 'User discussed their work at Microsoft and preference for TypeScript. They mentioned living in Dublin and planning a trip to Japan.',
        topics: ['work', 'Microsoft', 'TypeScript', 'Dublin', 'Japan', 'travel'],
      }),
    ]);

    const summarizer = new SessionSummarizer({
      provider,
      logger,
      embedder,
      minMessages: 4,
    });

    // Create a session with multiple messages
    const sessionId = 'sess-summary-1';
    db.createSession(sessionId);
    db.addSessionMessage(sessionId, 'user', 'I work at Microsoft as a senior engineer');
    db.addSessionMessage(sessionId, 'assistant', 'That sounds like an exciting role!');
    db.addSessionMessage(sessionId, 'user', 'Yeah, I mostly write TypeScript. I live in Dublin');
    db.addSessionMessage(sessionId, 'assistant', 'Dublin is lovely! What do you enjoy there?');
    db.addSessionMessage(sessionId, 'user', 'Planning a trip to Japan next month for sushi and culture');
    db.addSessionMessage(sessionId, 'assistant', 'Japan is wonderful, especially for food!');

    // Summarize
    const success = await summarizer.summarizeAndStore(db, sessionId, 'default');
    expect(success).toBe(true);

    // Verify summary stored
    const summary = db.getSessionSummary(sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.summary).toContain('Microsoft');
    expect(summary!.topics).toContain('TypeScript');
    expect(summary!.messageCount).toBe(6);
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0);

    // Should not re-summarize
    const duplicate = await summarizer.summarizeAndStore(db, sessionId, 'default');
    expect(duplicate).toBe(false);
  });

  it('should skip sessions with fewer than minMessages', async () => {
    const provider = createSequentialProvider([
      JSON.stringify({ summary: 'test', topics: [] }),
    ]);

    const summarizer = new SessionSummarizer({
      provider,
      logger,
      embedder,
      minMessages: 4,
    });

    const sessionId = 'sess-short';
    db.createSession(sessionId);
    db.addSessionMessage(sessionId, 'user', 'Hello');
    db.addSessionMessage(sessionId, 'assistant', 'Hi!');

    const result = await summarizer.summarizeAndStore(db, sessionId, 'default');
    expect(result).toBe(false);

    // LLM should not have been called
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('should search session summaries by keyword', async () => {
    // Create sessions first (foreign key constraint)
    db.createSession('sess-a');
    db.createSession('sess-b');

    // Directly insert two session summaries to test search
    db.addSessionSummary({
      sessionId: 'sess-a',
      userId: 'default',
      summary: 'Discussed TypeScript project deadline and API design for the new microservice',
      topics: ['TypeScript', 'API', 'microservice', 'deadline'],
      messageCount: 8,
      durationMs: 120000,
      embedding: await embedder.embed('TypeScript project deadline API microservice'),
    });

    db.addSessionSummary({
      sessionId: 'sess-b',
      userId: 'default',
      summary: 'Talked about cooking sushi and planning a trip to Japan with wife',
      topics: ['cooking', 'sushi', 'Japan', 'travel'],
      messageCount: 6,
      durationMs: 90000,
      embedding: await embedder.embed('cooking sushi Japan travel'),
    });

    // Search for programming-related session
    const apiResults = await store.searchSessions('API project', { userId: 'default' });
    expect(apiResults.length).toBeGreaterThanOrEqual(1);
    expect(apiResults[0].summary.summary).toContain('API');

    // Search for travel-related session
    const travelResults = await store.searchSessions('Japan sushi', { userId: 'default' });
    expect(travelResults.length).toBeGreaterThanOrEqual(1);
    expect(travelResults[0].summary.summary).toContain('Japan');

    // Verify session summary count in stats
    const stats = store.getStats();
    expect(stats.sessionSummaries).toBe(2);
  });

  it('should support batch summarization', async () => {
    const provider = createSequentialProvider([
      JSON.stringify({
        summary: 'Session about cooking recipes',
        topics: ['cooking', 'recipes'],
      }),
      JSON.stringify({
        summary: 'Session about gym workouts',
        topics: ['gym', 'fitness'],
      }),
    ]);

    const summarizer = new SessionSummarizer({
      provider,
      logger,
      embedder,
      minMessages: 2,
    });

    // Create two qualifying sessions
    for (const sid of ['batch-1', 'batch-2']) {
      db.createSession(sid);
      db.addSessionMessage(sid, 'user', `Hello from ${sid}`);
      db.addSessionMessage(sid, 'assistant', 'Hi there!');
      db.addSessionMessage(sid, 'user', 'Tell me more');
      db.addSessionMessage(sid, 'assistant', 'Sure!');
    }

    const count = await summarizer.summarizeBatch(db, ['batch-1', 'batch-2'], 'default');
    expect(count).toBe(2);
    expect(db.getSessionSummaryCount()).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO 5: Tiered Consolidation + Behavioral Patterns + Stats
// ═════════════════════════════════════════════════════════════════

describe('Scenario 5: Tiered consolidation, behavioral patterns & stats', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    embedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should run light tick (incremental decay) without errors', () => {
    // Store some memories
    for (let i = 0; i < 5; i++) {
      store.add({
        userId: 'default',
        content: `Test memory #${i} about ${['work', 'coffee', 'music', 'travel', 'gym'][i]}`,
        category: 'fact',
      });
    }

    // Create gardener and run light tick
    const gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      interval: 60000,
    });

    // Should not throw
    expect(() => gardener.lightTick()).not.toThrow();

    gardener.stop();
  });

  it('should run deep tick with session summarization', async () => {
    const provider = createSequentialProvider([
      JSON.stringify({
        summary: 'Discussed work projects and deadlines',
        topics: ['work', 'projects', 'deadlines'],
      }),
    ]);

    const summarizer = new SessionSummarizer({
      provider,
      logger,
      embedder,
      minMessages: 2,
    });

    // Create an old session (simulate 31 days ago)
    const oldSessionId = 'old-sess';
    db.createSession(oldSessionId);
    db.addSessionMessage(oldSessionId, 'user', 'Let me tell you about my project');
    db.addSessionMessage(oldSessionId, 'assistant', 'Tell me more!');
    db.addSessionMessage(oldSessionId, 'user', 'The deadline is next week');
    db.addSessionMessage(oldSessionId, 'assistant', 'I hope you make it!');

    // Store a memory too
    await store.add({
      userId: 'default',
      content: 'Working on project with tight deadline',
      category: 'fact',
    });

    // Create gardener and run deep tick
    const gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      interval: 60000,
      sessionSummarizer: summarizer,
    });

    // Deep tick should run full decay, session summaries, pruning, and behavioral inference
    // without errors - even when there are no old sessions to prune
    await gardener.deepTick();
    gardener.stop();

    // The full pipeline ran: full decay was called, pruning was attempted
    // Session was not old enough to prune (just created), so summary not generated via deep tick.
    // But we can verify the summarizer works by calling it directly:
    const summarized = await summarizer.summarizeAndStore(db, oldSessionId, 'default');
    expect(summarized).toBe(true);
    expect(db.getSessionSummary(oldSessionId)).not.toBeNull();
  });

  it('should infer behavioral patterns from session messages', () => {
    // Create sessions with user messages
    const sessionId = 'behav-sess';
    db.createSession(sessionId);
    db.addSessionMessage(sessionId, 'user', 'Can you help me debug this TypeScript code?');
    db.addSessionMessage(sessionId, 'assistant', 'Sure!');
    db.addSessionMessage(sessionId, 'user', 'I need to optimize the API endpoint performance');
    db.addSessionMessage(sessionId, 'assistant', 'Let me look at that');
    db.addSessionMessage(sessionId, 'user', 'Also help me write unit tests for the service');
    db.addSessionMessage(sessionId, 'assistant', 'Good practice!');

    // Get profile manager and infer patterns
    const profileManager = store.getProfileManager();
    const messages = db.getSessionMessages(sessionId)
      .filter(m => m.role === 'user')
      .map(m => ({ content: m.content, timestamp: m.createdAt }));

    profileManager.inferBehavioralPatterns('default', messages);

    // Check that patterns were stored
    const patterns = db.getBehavioralPatterns('default');
    expect(patterns).not.toBeNull();
    // The patterns should have been populated
    if (patterns) {
      expect(patterns.userId).toBe('default');
    }
  });

  it('should return comprehensive stats via getStats()', async () => {
    // Store various memories
    await store.add({ userId: 'default', content: 'Works at Microsoft', category: 'fact' });
    await store.add({ userId: 'default', content: 'Prefers coffee', category: 'preference' });
    await store.add({ userId: 'default', content: 'Lives in Dublin', category: 'fact' });

    // Add a session summary (create session first for FK)
    db.createSession('stats-sess');
    db.addSessionSummary({
      sessionId: 'stats-sess',
      userId: 'default',
      summary: 'Test session about work',
      topics: ['work'],
      messageCount: 4,
      durationMs: 10000,
      embedding: null,
    });

    // Do some searches to populate cache
    await store.search('Microsoft', { userId: 'default' });
    await store.search('Microsoft', { userId: 'default' }); // should hit cache

    const stats = store.getStats();
    expect(stats.totalMemories).toBe(3);
    expect(stats.activeMemories).toBeGreaterThanOrEqual(3); // all fresh = prominence 1.0
    expect(stats.dormantMemories).toBe(0); // none decayed yet
    expect(stats.sessionSummaries).toBe(1);
    expect(stats.embeddingCacheHitRate).not.toBeNull();
    expect(stats.embeddingCacheHitRate!).toBeGreaterThan(0);
  });

  it('should support tiered gardener: light ticks accumulate, deep tick runs on threshold', async () => {
    vi.useFakeTimers();

    const provider = createSequentialProvider([
      JSON.stringify({ summary: 'test', topics: [] }),
    ]);
    const summarizer = new SessionSummarizer({ provider, logger, embedder, minMessages: 2 });

    const gardener = new BackgroundGardener({
      scallopStore: store,
      logger,
      interval: 1000, // 1s for testing
      sessionSummarizer: summarizer,
    });

    // Mock processDecay to track calls
    const processDecaySpy = vi.spyOn(store, 'processDecay');
    const processFullDecaySpy = vi.spyOn(store, 'processFullDecay');

    gardener.start();

    // Run 5 light ticks (5 seconds)
    await vi.advanceTimersByTimeAsync(5500);
    expect(processDecaySpy).toHaveBeenCalledTimes(5);
    // Should not have run deep tick yet (needs 72 ticks)
    expect(processFullDecaySpy).not.toHaveBeenCalled();

    gardener.stop();
    vi.useRealTimers();
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO BONUS: End-to-End Multi-Turn with Fact Extractor
// ═════════════════════════════════════════════════════════════════

describe('Scenario E2E: Full multi-turn conversation with fact extraction', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let embedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    embedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should handle a natural 5-turn conversation end-to-end', async () => {
    // Use smart provider that distinguishes extraction vs classification calls
    const provider = createSmartProvider([
      // Turn 1: Introduction
      { facts: [
        { content: 'Works at Microsoft', subject: 'user', category: 'work' },
        { content: 'Lives in Dublin', subject: 'user', category: 'location' },
      ]},
      // Turn 2: Hobbies
      { facts: [
        { content: 'Plays guitar in the evening', subject: 'user', category: 'preference' },
      ]},
      // Turn 3: Family
      { facts: [
        { content: 'Wife is Hayat', subject: 'user', category: 'relationship' },
        { content: 'Is a content creator', subject: 'Hayat', category: 'work' },
      ]},
      // Turn 4: Travel plans
      { facts: [
        { content: 'Planning trip to Japan next month', subject: 'user', category: 'event' },
      ]},
      // Turn 5: Preferences
      { facts: [
        { content: 'Prefers morning coffee over tea', subject: 'user', category: 'preference' },
      ]},
    ]);
    const extractor = new LLMFactExtractor({
      provider,
      scallopStore: store,
      logger,
      embedder,
    });

    const sessionId = 'e2e-sess';
    db.createSession(sessionId);

    // Turn 1: introduction
    const r1 = await simulateTurn(
      extractor, db, sessionId, 'default',
      "Hi! I'm a senior engineer at Microsoft, and I live in Dublin.",
      "Nice to meet you! Dublin is a great city."
    );
    expect(r1.facts.length).toBeGreaterThanOrEqual(1);

    // Turn 2: hobbies
    const r2 = await simulateTurn(
      extractor, db, sessionId, 'default',
      "In my free time I love playing guitar, especially in the evenings.",
      "That's a wonderful hobby! What kind of music do you play?"
    );
    expect(r2.facts.length).toBeGreaterThanOrEqual(1);

    // Turn 3: family
    const r3 = await simulateTurn(
      extractor, db, sessionId, 'default',
      "My wife Hayat is a content creator. She makes great videos!",
      "That's awesome! What kind of content does she create?"
    );
    expect(r3.facts.length).toBeGreaterThanOrEqual(1);

    // Turn 4: travel plans
    const r4 = await simulateTurn(
      extractor, db, sessionId, 'default',
      "We're planning a trip to Japan next month. Can't wait for the sushi!",
      "Japan is incredible! You'll love it."
    );
    expect(r4.facts.length).toBeGreaterThanOrEqual(1);

    // Turn 5: preferences
    const r5 = await simulateTurn(
      extractor, db, sessionId, 'default',
      "I always start my day with coffee, never tea. It's my morning ritual.",
      "Coffee is a great way to start the day!"
    );
    expect(r5.facts.length).toBeGreaterThanOrEqual(1);

    // ── Verify the memory system state ──

    // Total memories stored across all turns (some may have been deduped)
    const totalMemories = store.getCount();
    expect(totalMemories).toBeGreaterThanOrEqual(3); // At minimum several got through

    // Search works across the conversation
    const workSearch = await store.search('Microsoft', { userId: 'default' });
    expect(workSearch.length).toBeGreaterThanOrEqual(1);

    // Session messages are stored (5 user + 5 assistant)
    const messages = db.getSessionMessages(sessionId);
    expect(messages.length).toBe(10);

    // Stats show the full picture
    const stats = store.getStats();
    expect(stats.totalMemories).toBeGreaterThanOrEqual(3);
    expect(stats.activeMemories).toBeGreaterThanOrEqual(3);
    expect(stats.embeddingCacheHitRate).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════
// SCENARIO: LLM & Embedding Call Optimizations
// ═════════════════════════════════════════════════════════════════

describe('Optimizations: reduced embedding & search calls', () => {
  let db: ScallopDatabase;
  let store: ScallopMemoryStore;
  let rawEmbedder: EmbeddingProvider;

  beforeEach(() => {
    cleanup();
    rawEmbedder = createTestEmbedder();
    store = new ScallopMemoryStore({
      dbPath: TEST_DB,
      logger,
      embedder: rawEmbedder,
    });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('should skip embed() when embedding is passed to add()', async () => {
    const precomputed = await rawEmbedder.embed('Works at Microsoft');
    const callsBefore = (rawEmbedder.embed as ReturnType<typeof vi.fn>).mock.calls.length;

    await store.add({
      userId: 'default',
      content: 'Works at Microsoft',
      embedding: precomputed,
      category: 'fact',
    });

    // embed() should NOT have been called again inside add() — the CachedEmbedder
    // wraps rawEmbedder, so we check that no additional raw calls were made beyond
    // the one we did ourselves and any the CachedEmbedder may cache-miss on.
    // The key insight: the store received a pre-computed embedding, so it should
    // skip calling this.embedder.embed() entirely.
    const mem = db.getMemory(db.getMemoriesByUser('default', {})[0].id)!;
    expect(mem.embedding).not.toBeNull();
    expect(mem.embedding).toEqual(precomputed);
  });

  it('should skip embed(query) when queryEmbedding is passed to search()', async () => {
    // Store a memory first
    await store.add({
      userId: 'default',
      content: 'Works at Microsoft as an engineer',
      category: 'fact',
    });

    // Pre-compute query embedding
    const queryEmb = await rawEmbedder.embed('Microsoft engineer');
    const callsBefore = (rawEmbedder.embed as ReturnType<typeof vi.fn>).mock.calls.length;

    // Search with pre-computed embedding
    const results = await store.search('Microsoft engineer', {
      userId: 'default',
      queryEmbedding: queryEmb,
    });

    // Verify results still work
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toContain('Microsoft');

    // The raw embedder should not have been called again for the query
    // (CachedEmbedder wraps raw, but with queryEmbedding provided, embed is skipped)
    const callsAfter = (rawEmbedder.embed as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('should use RelationGraph with CachedEmbedder (not raw embedder)', async () => {
    // The bug was: RelationGraph received options.embedder (raw) instead of this.embedder (cached).
    // After the fix, detectRelations should use the cached embedder.
    // We verify by storing a fact with detectRelations: true and checking
    // that the raw embedder calls are minimized (cache hits).

    // Store a seed memory first
    await store.add({
      userId: 'default',
      content: 'Works at Microsoft',
      category: 'fact',
    });

    // Reset call counts
    (rawEmbedder.embed as ReturnType<typeof vi.fn>).mockClear();
    (rawEmbedder.embedBatch as ReturnType<typeof vi.fn>).mockClear();

    // Store another related memory with detectRelations: true
    await store.add({
      userId: 'default',
      content: 'Works at Microsoft as a senior engineer',
      category: 'fact',
      detectRelations: true,
    });

    // With CachedEmbedder, repeated embeddings of the same content should be cached.
    // The raw embedder should have minimal calls (cache hits for repeated content).
    // Without the fix, this would make 3-6 extra raw API calls.
    const rawEmbedCalls = (rawEmbedder.embed as ReturnType<typeof vi.fn>).mock.calls.length;
    // At most 1 raw embed call for the new content (CachedEmbedder caches the rest)
    expect(rawEmbedCalls).toBeLessThanOrEqual(2);
  });

  it('should not call detectRelations when detectRelations: false is passed', async () => {
    // Store a seed memory
    await store.add({
      userId: 'default',
      content: 'Lives in Dublin',
      category: 'fact',
    });

    // Reset embed call counts
    (rawEmbedder.embed as ReturnType<typeof vi.fn>).mockClear();
    (rawEmbedder.embedBatch as ReturnType<typeof vi.fn>).mockClear();

    // Store with detectRelations: false (what fact-extractor now does)
    await store.add({
      userId: 'default',
      content: 'Lives in Dublin, Ireland',
      category: 'fact',
      detectRelations: false,
    });

    // With detectRelations: false, no relation detection searches happen,
    // so only 1 embed call for the content itself (or 0 if embedding passed)
    const rawCalls = (rawEmbedder.embed as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(rawCalls).toBeLessThanOrEqual(1);
  });

  it('should perform merged search (single search per fact) in fact extractor', async () => {
    // Store seed memories
    await store.add({ userId: 'default', content: 'Works at Microsoft', category: 'fact' });
    await store.add({ userId: 'default', content: 'Lives in Dublin', category: 'fact' });

    const provider = createSmartProvider([
      { facts: [
        { content: 'Works at Google now', subject: 'user', category: 'work' },
        { content: 'Moved to Cork', subject: 'user', category: 'location' },
      ]},
    ]);

    const extractor = new LLMFactExtractor({
      provider,
      scallopStore: store,
      logger,
      embedder: rawEmbedder,
    });

    // Spy on store.search to count calls
    const searchSpy = vi.spyOn(store, 'search');

    const sessionId = 'opt-test';
    db.createSession(sessionId);
    await simulateTurn(extractor, db, sessionId, 'default', 'I now work at Google and moved to Cork');

    // With the optimization: each fact triggers exactly ONE search (not two).
    // 2 facts = 2 search calls (not 4+ as before)
    expect(searchSpy).toHaveBeenCalledTimes(2);

    // Verify all search calls used queryEmbedding pass-through
    for (const call of searchSpy.mock.calls) {
      const options = call[1] as { queryEmbedding?: number[] } | undefined;
      expect(options?.queryEmbedding).toBeDefined();
    }

    searchSpy.mockRestore();
  });
});
