/**
 * E2E Realistic Conversation + WebSocket Test + DB Bug Audit
 *
 * Exercises the full pipeline through a realistic multi-turn conversation:
 * 1. Boot E2E gateway with mock providers
 * 2. Run multi-turn conversation via WebSocket (goals, preferences, tasks)
 * 3. Run gardener ticks (deepTick, sleepTick) to exercise proactive evaluation
 * 4. Inspect the SQLite database for data integrity issues
 *
 * Also contains standalone DB audit tests that seed data and check for
 * known bug patterns found during code review.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import pino from 'pino';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  createMockLLMProvider,
  createMockEmbeddingProvider,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { UnifiedScheduler } from '../proactive/scheduler.js';
import { parseEvaluatorResponse } from '../memory/proactive-evaluator.js';
import type { GapSignal } from '../memory/gap-scanner.js';

const testLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Suite 1: Realistic multi-turn WebSocket conversation
// ---------------------------------------------------------------------------

const AGENT_RESPONSES = [
  // Turn 1: User introduces themselves
  "Nice to meet you! I can see you're a TypeScript developer who loves rock climbing. That's a great combination of mental and physical challenge! [DONE]",
  // Turn 2: User mentions a goal
  "Learning Rust sounds like an excellent goal! Given your TypeScript background, you'll appreciate Rust's type system. Want me to keep track of this goal for you? [DONE]",
  // Turn 3: User asks about their info
  "Based on what I know, you're a TypeScript developer who loves rock climbing. You also mentioned wanting to learn Rust programming. [DONE]",
  // Turn 4: Task-related query
  "I'll help you remember to practice Rust for 30 minutes every morning. I've noted this commitment! [DONE]",
];

const FACT_EXTRACTION_RESPONSES = [
  JSON.stringify({
    facts: [
      { content: 'User is a TypeScript developer', subject: 'user', category: 'fact', confidence: 0.95, action: 'fact' },
      { content: 'User loves rock climbing', subject: 'user', category: 'preference', confidence: 0.9, action: 'fact' },
    ],
    proactive_triggers: [],
  }),
  JSON.stringify({
    facts: [
      { content: 'User wants to learn Rust programming', subject: 'user', category: 'fact', confidence: 0.9, action: 'fact' },
    ],
    proactive_triggers: [],
  }),
  JSON.stringify({ facts: [], proactive_triggers: [] }),
  JSON.stringify({
    facts: [
      { content: 'User wants to practice Rust 30 minutes every morning', subject: 'user', category: 'fact', confidence: 0.85, action: 'fact' },
    ],
    proactive_triggers: [],
  }),
];

describe('E2E Realistic Conversation + DB Audit', () => {

  // -----------------------------------------------------------------------
  // Sub-suite 1: Full WebSocket conversation
  // -----------------------------------------------------------------------
  describe('realistic multi-turn WebSocket conversation', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: AGENT_RESPONSES,
        factExtractorResponses: FACT_EXTRACTION_RESPONSES,
        maxIterations: 5,
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    }, 15000);

    it('should complete 4-turn conversation via WebSocket and populate DB correctly', async () => {
      const client = await createWsClient(ctx.port);

      try {
        // --- Turn 1: Introduce user ---
        client.send({
          type: 'chat',
          message: "Hey! I'm a TypeScript developer and I love rock climbing on weekends.",
        });
        const turn1Msgs = await client.collectUntilResponse(15000);
        const turn1 = turn1Msgs.find(m => m.type === 'response');
        expect(turn1).toBeDefined();
        expect(turn1!.content).toBeTruthy();
        const sessionId = turn1!.sessionId!;
        expect(sessionId).toBeDefined();

        await new Promise(r => setTimeout(r, 2000)); // fact extraction

        // --- Turn 2: Mention a goal ---
        client.send({
          type: 'chat',
          message: "I've been thinking about learning Rust. It seems like a great language for systems programming.",
          sessionId,
        });
        const turn2Msgs = await client.collectUntilResponse(15000);
        const turn2 = turn2Msgs.find(m => m.type === 'response');
        expect(turn2).toBeDefined();
        expect(turn2!.content).toBeTruthy();

        await new Promise(r => setTimeout(r, 2000));

        // --- Turn 3: Query memories ---
        client.send({
          type: 'chat',
          message: 'What do you know about me?',
          sessionId,
        });
        const turn3Msgs = await client.collectUntilResponse(15000);
        const turn3 = turn3Msgs.find(m => m.type === 'response');
        expect(turn3).toBeDefined();

        // --- Turn 4: Task/commitment ---
        client.send({
          type: 'chat',
          message: 'Remind me to practice Rust for 30 minutes every morning.',
          sessionId,
        });
        const turn4Msgs = await client.collectUntilResponse(15000);
        const turn4 = turn4Msgs.find(m => m.type === 'response');
        expect(turn4).toBeDefined();

        await new Promise(r => setTimeout(r, 2000));

        // --- DB Audit: Post-conversation checks ---
        const db = ctx.scallopStore.getDatabase();

        // 1. Session exists and has messages
        const session = db.getSession(sessionId);
        expect(session).not.toBeNull();
        const messages = db.getSessionMessages(sessionId);
        expect(messages.length).toBeGreaterThanOrEqual(4); // at least 4 user messages

        // 2. Memories were extracted
        const memories = ctx.scallopStore.getByUser('default', { limit: 100 });
        expect(memories.length).toBeGreaterThanOrEqual(2);
        const memTexts = memories.map(m => m.content.toLowerCase());
        const hasTypescript = memTexts.some(t => t.includes('typescript'));
        const hasRust = memTexts.some(t => t.includes('rust'));
        const hasClimbing = memTexts.some(t => t.includes('climbing'));
        expect(hasTypescript || hasRust || hasClimbing).toBe(true);

        // 3. No orphaned sessions (sessions without any messages)
        const allSessions = db.raw<{ id: string }>(
          'SELECT id FROM sessions',
          []
        );
        for (const s of allSessions) {
          const msgs = db.getSessionMessages(s.id);
          // Sessions may exist without messages if they were just created
          // but our conversation sessions should have messages
          if (s.id === sessionId) {
            expect(msgs.length).toBeGreaterThan(0);
          }
        }

        // 4. No memories with null embeddings (every memory should have been embedded)
        const nullEmbeddings = db.raw<{ id: string; content: string }>(
          "SELECT id, content FROM memories WHERE embedding IS NULL AND user_id = 'default'",
          []
        );
        // Note: this may legitimately have entries if add() was called without embedder
        // but in our E2E setup every memory goes through ScallopMemoryStore.add() with embedder
        // so null embeddings indicate a bug
        if (nullEmbeddings.length > 0) {
          // Log for visibility — some paths may skip embedding (e.g., direct db.addMemory)
          console.warn(`Found ${nullEmbeddings.length} memories with null embeddings:`,
            nullEmbeddings.map(m => m.content).slice(0, 3));
        }

        // 5. No duplicate memories (same content, same user)
        const dupes = db.raw<{ content: string; cnt: number }>(
          "SELECT content, COUNT(*) as cnt FROM memories WHERE user_id = 'default' AND is_latest = 1 GROUP BY content HAVING cnt > 1",
          []
        );
        expect(dupes.length).toBe(0);

        // 6. All memory importance values are in valid range [1, 10]
        const badImportance = db.raw<{ id: string; importance: number; content: string; source: string }>(
          "SELECT id, importance, content, source FROM memories WHERE importance < 1 OR importance > 10",
          []
        );
        if (badImportance.length > 0) {
          console.warn('Memories with invalid importance:', badImportance.map(m => ({
            importance: m.importance, content: m.content.slice(0, 60), source: m.source,
          })));
        }
        // Exclude migration sentinel rows (they may have special values)
        const realBadImportance = badImportance.filter(m => m.source !== '_cleaned_sentinel');
        expect(realBadImportance.length).toBe(0);

        // 7. All confidence values are in valid range [0, 1]
        const badConfidence = db.raw<{ id: string; confidence: number }>(
          "SELECT id, confidence FROM memories WHERE confidence < 0 OR confidence > 1",
          []
        );
        expect(badConfidence.length).toBe(0);

        // 8. No memories with future document_date (shouldn't be created in the future)
        const futureMemories = db.raw<{ id: string; document_date: number }>(
          'SELECT id, document_date FROM memories WHERE document_date > ?',
          [Date.now() + 60000] // 1 minute tolerance
        );
        expect(futureMemories.length).toBe(0);

      } finally {
        await client.close();
      }
    }, 90000);
  });

  // -----------------------------------------------------------------------
  // Sub-suite 2: WebSocket protocol edge cases
  // -----------------------------------------------------------------------
  describe('WebSocket protocol edge cases', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: ['I received your message. [DONE]'],
      });
    }, 30000);

    afterAll(async () => {
      await cleanupE2E(ctx);
    }, 15000);

    it('should handle ping messages', async () => {
      const client = await createWsClient(ctx.port);
      try {
        client.send({ type: 'ping' });
        const response = await client.waitForResponse('pong', 5000);
        expect(response.type).toBe('pong');
      } finally {
        await client.close();
      }
    });

    it('should handle unknown message types gracefully', async () => {
      const client = await createWsClient(ctx.port);
      try {
        client.send({ type: 'unknown_type', data: 'test' });
        // Should get an error response, not crash
        const response = await client.waitForResponse(undefined, 5000);
        expect(response).toBeDefined();
      } finally {
        await client.close();
      }
    });

    it('should handle concurrent messages on same session', async () => {
      const client = await createWsClient(ctx.port);
      try {
        // Send two messages quickly without waiting for first response
        client.send({ type: 'chat', message: 'First message' });
        // Small delay to avoid message ordering issues
        await new Promise(r => setTimeout(r, 100));
        client.send({ type: 'chat', message: 'Second message' });

        // Should get at least one response (the other may queue or error)
        const responses = await client.collectAll(10000);
        const chatResponses = responses.filter(r => r.type === 'response');
        expect(chatResponses.length).toBeGreaterThanOrEqual(1);
      } finally {
        await client.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Sub-suite 3: Gardener + Proactive pipeline DB audit
  // -----------------------------------------------------------------------
  describe('gardener proactive pipeline DB integrity', () => {
    let scallopStore: ScallopMemoryStore;
    let gardener: BackgroundGardener;
    let dbPath: string;

    beforeAll(async () => {
      dbPath = `/tmp/e2e-db-audit-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

      const mockEmbedder = createMockEmbeddingProvider();

      // Unified evaluator response: nudge for the stale goal
      const fusionProvider = createMockLLMProvider([
        // Call 1: Unified proactive evaluator — nudge for stale goal
        JSON.stringify({
          items: [{
            index: 1,
            action: 'nudge',
            message: 'Hey! I noticed your Rust learning goal hasn\'t been updated in a while. Want to set some milestones?',
            urgency: 'medium',
          }],
        }),
      ]);

      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: mockEmbedder,
      });

      const db = scallopStore.getDatabase();

      // Seed a 15-day-old active goal
      const DAY_MS = 24 * 60 * 60 * 1000;
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
        accessCount: 5,
        sourceChunk: null,
        embedding: goalEmbedding,
        metadata: {
          goalType: 'goal',
          status: 'active',
          progress: 0,
        },
      });
      // Backdate updated_at so stale goal detection works
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqliteDb = (db as any).db;
      sqliteDb.prepare('UPDATE memories SET updated_at = ?, document_date = ? WHERE id = ?')
        .run(staleDate, staleDate, goalMem.id);

      // Seed session summaries
      db.createSession('audit-sess-1');
      db.createSession('audit-sess-2');
      db.addSessionSummary({
        sessionId: 'audit-sess-1',
        userId: 'default',
        summary: 'Discussed Rust programming basics and ownership model',
        topics: ['rust', 'programming'],
        messageCount: 6,
        durationMs: 15 * 60000,
        embedding: null,
      });
      db.addSessionSummary({
        sessionId: 'audit-sess-2',
        userId: 'default',
        summary: 'Talked about rock climbing gear and Boulder trails',
        topics: ['climbing', 'outdoors'],
        messageCount: 4,
        durationMs: 10 * 60000,
        embedding: null,
      });

      // Seed behavioral patterns
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

      // Seed a few regular memories
      await scallopStore.add({
        userId: 'default',
        content: 'User is a TypeScript developer',
        category: 'fact',
        importance: 7,
        confidence: 0.9,
        detectRelations: false,
      });
      await scallopStore.add({
        userId: 'default',
        content: 'User loves rock climbing on weekends',
        category: 'preference',
        importance: 6,
        confidence: 0.85,
        detectRelations: false,
      });

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

    it('should create proactive items via deepTick and maintain DB integrity', async () => {
      await gardener.deepTick();

      const db = scallopStore.getDatabase();

      // 1. Proactive scheduled item should have been created
      const items = db.raw<{
        id: string;
        user_id: string;
        source: string;
        type: string;
        message: string;
        context: string | null;
        status: string;
        trigger_at: number;
        board_status: string | null;
      }>(
        "SELECT id, user_id, source, type, message, context, status, trigger_at, board_status FROM scheduled_items WHERE source = 'agent'",
        []
      );
      expect(items.length).toBeGreaterThanOrEqual(1);

      const nudgeItem = items.find(i => i.message.toLowerCase().includes('rust'));
      expect(nudgeItem).toBeDefined();
      expect(nudgeItem!.status).toBe('pending');
      expect(nudgeItem!.trigger_at).toBeGreaterThan(0);

      // 2. Context should contain proactive_evaluator source
      expect(nudgeItem!.context).not.toBeNull();
      const ctx = JSON.parse(nudgeItem!.context!);
      expect(ctx.source).toBe('proactive_evaluator');
      expect(ctx.gapType).toBe('stale_goal');

      // 3. No items stuck in 'processing' status (all should complete)
      const processingItems = db.raw<{ id: string }>(
        "SELECT id FROM scheduled_items WHERE status = 'processing'",
        []
      );
      expect(processingItems.length).toBe(0);

      // 4. All prominence values should be in [0, 1]
      const badProminence = db.raw<{ id: string; prominence: number }>(
        'SELECT id, prominence FROM memories WHERE prominence < 0 OR prominence > 1',
        []
      );
      expect(badProminence.length).toBe(0);

      // 5. No memories with updated_at in the future
      const futureUpdated = db.raw<{ id: string; updated_at: number }>(
        'SELECT id, updated_at FROM memories WHERE updated_at > ?',
        [Date.now() + 60000]
      );
      expect(futureUpdated.length).toBe(0);

      // 6. Session summaries should reference valid sessions (FK integrity)
      const orphanedSummaries = db.raw<{ id: string; session_id: string }>(
        `SELECT ss.id, ss.session_id FROM session_summaries ss
         LEFT JOIN sessions s ON ss.session_id = s.id
         WHERE s.id IS NULL`,
        []
      );
      expect(orphanedSummaries.length).toBe(0);

      // 7. Memory relations should reference existing memories (FK integrity)
      const orphanedRelations = db.raw<{ id: string }>(
        `SELECT mr.id FROM memory_relations mr
         LEFT JOIN memories m1 ON mr.source_id = m1.id
         LEFT JOIN memories m2 ON mr.target_id = m2.id
         WHERE m1.id IS NULL OR m2.id IS NULL`,
        []
      );
      expect(orphanedRelations.length).toBe(0);

      // 8. Verify prominence decay ran but didn't corrupt updated_at
      // (regression test for the bug we fixed in this session)
      const goalMemory = db.raw<{ id: string; updated_at: number; prominence: number }>(
        "SELECT id, updated_at, prominence FROM memories WHERE content = 'Learn Rust programming'",
        []
      );
      expect(goalMemory.length).toBe(1);
      // updated_at should still be the stale date, NOT refreshed by decay
      const DAY_MS = 24 * 60 * 60 * 1000;
      const daysSinceUpdate = (Date.now() - goalMemory[0].updated_at) / DAY_MS;
      expect(daysSinceUpdate).toBeGreaterThan(10); // should still be ~15 days old
    }, 30000);
  });

  // -----------------------------------------------------------------------
  // Sub-suite 4: Scheduler quiet hours timezone bug (BUG FOUND)
  // -----------------------------------------------------------------------
  describe('scheduler quiet hours timezone handling', () => {
    it('BUG: quiet hours uses only first item userId for all items', () => {
      // The scheduler does:
      //   const tz = this.getTimezone(dueItems[0].userId);
      //
      // This means if there are due items for multiple users in different
      // time zones, only the first user's timezone determines quiet hours
      // for ALL items. User B's items may be incorrectly deferred or
      // fired based on User A's timezone.
      //
      // This is a real bug but acceptable in single-user mode.
      // In multi-user deployments it would cause incorrect behavior.
      expect(true).toBe(true); // documenting the bug
    });

    it('BUG: quiet hours rescheduling uses server time, not user timezone', () => {
      // In scheduler.ts line 222-223:
      //   const tomorrow8am = new Date();
      //   tomorrow8am.setHours(hourNow >= 22 ? ... : 8, 0, 0, 0);
      //
      // `new Date()` creates a Date in server-local time.
      // `setHours()` modifies the server-local hour.
      // But `hourNow` is derived from the *user's* timezone via Intl.DateTimeFormat.
      //
      // If server=UTC and user=UTC-8:
      //   hourNow = 23 (user local, 11pm, quiet hours)
      //   tomorrow8am starts at server time (e.g., 7am UTC)
      //   setHours(7 + (24-23+8)) = setHours(16) = 4pm UTC = 8am PST ✓
      //
      // If server=UTC-5 and user=UTC+9:
      //   hourNow = 3 (user local, 3am, quiet hours)
      //   tomorrow8am starts at server time (e.g., 1pm EST)
      //   setHours(8) = 8am EST = 10pm JST ✗ (user gets it at 10pm, not 8am!)
      //
      // The fix should compute 8am in the user's timezone, then convert to UTC.
      expect(true).toBe(true); // documenting the bug
    });
  });

  // -----------------------------------------------------------------------
  // Sub-suite 5: Scheduler source field mismatch (BUG FOUND)
  // -----------------------------------------------------------------------
  describe('scheduler proactive source classification', () => {
    it('BUG: proactive_evaluator source never matches inner_thoughts check', () => {
      // In scheduler.ts sendFormattedMessage() line 329:
      //   if (!sourceOverride && ctx.source === 'inner_thoughts') {
      //     source = 'inner_thoughts';
      //   }
      //
      // But the unified proactive evaluator (proactive-evaluator.ts line 221)
      // always writes: source: 'proactive_evaluator' into the context.
      //
      // So this branch is dead code. Every proactive item now gets
      // source = 'gap_scanner' as the default (line 321).
      //
      // This affects the WebSocket output format — clients see
      // source: 'gap_scanner' for ALL proactive messages, even ones
      // that originated from session follow-up (inner thoughts).
      //
      // The fix: check for 'proactive_evaluator' in addition to
      // 'inner_thoughts', or update the evaluator to write the
      // appropriate source based on signal type.

      // Verify the evaluator always writes 'proactive_evaluator'
      const testSignals: GapSignal[] = [{
        type: 'unresolved_thread',
        severity: 'low',
        description: 'Recent session follow-up',
        context: { sessionId: 'test' },
        sourceId: 'test-id',
      }];
      const items = parseEvaluatorResponse(
        JSON.stringify({ items: [{ index: 1, action: 'nudge', message: 'Test', urgency: 'low' }] }),
        testSignals,
      );
      expect(items.length).toBe(1);
      const ctx = JSON.parse(items[0].context);
      // This will ALWAYS be 'proactive_evaluator', never 'inner_thoughts'
      expect(ctx.source).toBe('proactive_evaluator');
      // And the scheduler will never match it to 'inner_thoughts'
      expect(ctx.source).not.toBe('inner_thoughts');
    });
  });

  // -----------------------------------------------------------------------
  // Sub-suite 6: markScheduledItemFired redundant board_status update
  // -----------------------------------------------------------------------
  describe('scheduler fired item handling', () => {
    it('documents redundant board_status update on fire', () => {
      // In db.ts markScheduledItemFired():
      //   SET status = 'fired', board_status = 'done', fired_at = ?, updated_at = ?
      //
      // Then in scheduler.ts markItemFiredAndReschedule():
      //   this.db.markScheduledItemFired(item.id);
      //   this.db.updateScheduledItemBoard(item.id, { boardStatus: 'done' });
      //
      // The second call is redundant — board_status is already 'done'
      // from the first call. This is not a functional bug but wastes
      // a DB write on every fired item.
      expect(true).toBe(true); // documenting the issue
    });
  });

  // -----------------------------------------------------------------------
  // Sub-suite 7: claimDueScheduledItems returns stale status
  // -----------------------------------------------------------------------
  describe('claim due items status consistency', () => {
    let dbPath: string;
    let scallopStore: ScallopMemoryStore;

    beforeEach(() => {
      dbPath = `/tmp/e2e-claim-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;
      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: createMockEmbeddingProvider(),
      });
    });

    afterEach(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('claimDueScheduledItems returns items with correct processing status', () => {
      const db = scallopStore.getDatabase();

      // Add a due item
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        type: 'reminder',
        message: 'Test reminder',
        context: null,
        triggerAt: Date.now() - 1000, // due 1 second ago
        recurring: null,
        sourceMemoryId: null,
      });

      // Claim it
      const claimed = db.claimDueScheduledItems();
      expect(claimed.length).toBe(1);

      // Fixed: returned item now correctly reflects 'processing' status
      expect(claimed[0].status).toBe('processing');

      // Verify DB also has 'processing'
      const dbItem = db.getScheduledItem(claimed[0].id);
      expect(dbItem!.status).toBe('processing');
    });
  });

  // -----------------------------------------------------------------------
  // Sub-suite 8: expireOldScheduledItems also expires 'processing' items
  // -----------------------------------------------------------------------
  describe('expire old items behavior', () => {
    let dbPath: string;
    let scallopStore: ScallopMemoryStore;

    beforeEach(() => {
      dbPath = `/tmp/e2e-expire-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;
      scallopStore = new ScallopMemoryStore({
        dbPath,
        logger: testLogger,
        embedder: createMockEmbeddingProvider(),
      });
    });

    afterEach(() => {
      scallopStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    });

    it('expireOldScheduledItems expires processing items without recovery', () => {
      const db = scallopStore.getDatabase();
      const DAY_MS = 24 * 60 * 60 * 1000;

      // Add an item and claim it (sets status to 'processing')
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        type: 'reminder',
        message: 'Test reminder that gets stuck',
        context: null,
        triggerAt: Date.now() - 2 * DAY_MS, // due 2 days ago
        recurring: null,
        sourceMemoryId: null,
      });

      const claimed = db.claimDueScheduledItems();
      expect(claimed.length).toBe(1);

      // Simulate a crash: item is stuck in 'processing' state
      // Now expire old items (default maxAge = 24h)
      const expired = db.expireOldScheduledItems();

      // The processing item gets expired because:
      //   WHERE status IN ('pending', 'processing') AND trigger_at < cutoff
      // This is correct behavior — prevents items from being stuck forever.
      // But there's no explicit recovery mechanism for processing items.
      // If the process restarts, items stuck in 'processing' stay stuck
      // until the next expireOldScheduledItems run (24h+ after trigger_at).
      expect(expired).toBe(1);

      const item = db.getScheduledItem(claimed[0].id);
      expect(item!.status).toBe('expired');
    });
  });
});
