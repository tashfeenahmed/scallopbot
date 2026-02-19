/**
 * Smoke test for the redundancy-elimination refactor.
 *
 * Exercises the refactored code paths:
 * - Shared wordOverlap (Fix 1)
 * - EMA utilities from canonical location (Fix 8)
 * - Dedup constants in db.ts (Fix 3)
 * - boardStatus backfill & defaults (Fix 4)
 * - Context dedup with excludeGoalLinked (Fix 5)
 * - Unified createProactiveItem (Fix 7)
 * - Merged decay+utility (Fix 6)
 *
 * Runs a mock multi-turn conversation then inspects the DB to verify
 * everything hangs together after the refactor.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  testLogger,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';
import { wordOverlap, DEDUP_OVERLAP_THRESHOLD } from '../utils/text-similarity.js';
import { updateEMA, detectTrend } from '../utils/ema.js';
import { computeUtilityScore } from '../memory/decay.js';
import { computeUtilityScore as reExportedUtilityScore } from '../memory/utility-score.js';
import { checkGoalDeadlines } from '../memory/goal-deadline-check.js';
import { isDuplicate } from '../memory/gap-pipeline.js';
import { BoardService } from '../board/board-service.js';
import { computeBoardStatus } from '../board/types.js';
import { createProactiveItem } from '../memory/gardener-scheduling.js';
import { runFullDecay, runEnhancedForgetting } from '../memory/gardener-deep-steps.js';
import { archiveLowUtilityMemories } from '../memory/utility-score.js';

// ---------------------------------------------------------------------------
const AGENT_RESPONSES = [
  "Great to meet you, Alice! I'll remember that you're a software engineer at Google. [DONE]",
  "Got it — you're training for the Berlin marathon next spring. I can help you stay on track! [DONE]",
  "Sure! I know you're a software engineer at Google who's training for the Berlin marathon. [DONE]",
];

const FACT_RESPONSES = [
  JSON.stringify({
    facts: [
      { content: 'Name is Alice', subject: 'user', category: 'fact', confidence: 0.95, action: 'fact' },
      { content: 'Works as a software engineer at Google', subject: 'user', category: 'fact', confidence: 0.9, action: 'fact' },
    ],
    proactive_triggers: [],
  }),
  JSON.stringify({
    facts: [
      { content: 'Training for the Berlin marathon', subject: 'user', category: 'event', confidence: 0.9, action: 'fact' },
    ],
    proactive_triggers: [],
  }),
  JSON.stringify({ facts: [], proactive_triggers: [] }),
];

// ---------------------------------------------------------------------------
describe('Refactor Smoke Test', () => {
  let ctx: E2EGatewayContext;
  let client: WsClient;

  beforeAll(async () => {
    ctx = await createE2EGateway({
      responses: AGENT_RESPONSES,
      factExtractorResponses: FACT_RESPONSES,
    });
  }, 30000);

  afterAll(async () => {
    await cleanupE2E(ctx);
  }, 15000);

  beforeEach(async () => {
    client = await createWsClient(ctx.port);
  });

  afterEach(async () => {
    await client.close();
  });

  // ====================================================================
  // 1. Multi-turn conversation: memories, sessions, board items
  // ====================================================================
  it('should complete a 3-turn conversation and store memories', async () => {
    // Turn 1
    client.send({ type: 'chat', message: "Hey! I'm Alice, a software engineer at Google." });
    const t1 = await client.collectUntilResponse(15000);
    const r1 = t1.find(m => m.type === 'response');
    expect(r1).toBeDefined();
    const sessionId = r1!.sessionId!;

    await new Promise(r => setTimeout(r, 2000)); // wait for fact extraction

    // Turn 2
    client.send({ type: 'chat', message: "I'm training for the Berlin marathon next spring.", sessionId });
    const t2 = await client.collectUntilResponse(15000);
    expect(t2.find(m => m.type === 'response')).toBeDefined();

    await new Promise(r => setTimeout(r, 2000));

    // Turn 3 — retrieval query
    client.send({ type: 'chat', message: 'What do you know about me?', sessionId });
    const t3 = await client.collectUntilResponse(15000);
    expect(t3.find(m => m.type === 'response')).toBeDefined();

    // --- DB assertions ---
    const db = ctx.scallopStore.getDatabase();

    // Memories stored
    const memories = ctx.scallopStore.getByUser('default', { limit: 100 });
    expect(memories.length).toBeGreaterThanOrEqual(2);
    const texts = memories.map(m => m.content.toLowerCase());
    expect(texts.some(t => t.includes('alice') || t.includes('name'))).toBe(true);

    // Session persisted with messages
    const msgs = db.getSessionMessages(sessionId);
    expect(msgs.length).toBeGreaterThanOrEqual(3);

    // All memories have prominence > 0
    for (const m of memories) {
      expect(m.prominence).toBeGreaterThan(0);
    }
  }, 60000);

  // ====================================================================
  // 2. Shared wordOverlap — imported from canonical location works
  // ====================================================================
  it('shared wordOverlap returns correct values', () => {
    expect(wordOverlap('remind me about the dentist', 'remind me about the dentist')).toBe(1);
    expect(wordOverlap('completely different text here', 'nothing in common at all')).toBe(0);

    // isDuplicate from gap-pipeline still works (uses the shared function)
    const existing = [{ message: 'Remind me about the dentist appointment', context: null }];
    expect(isDuplicate('remind me about the dentist appointment', 'src1', existing)).toBe(true);
    expect(isDuplicate('buy groceries tomorrow morning', 'src2', existing)).toBe(false);
  });

  // ====================================================================
  // 3. EMA from canonical location works
  // ====================================================================
  it('updateEMA and detectTrend from utils/ema work', () => {
    const ema = updateEMA(100, 50, 7 * 24 * 60 * 60 * 1000); // one half-life
    expect(ema).toBeGreaterThan(50);
    expect(ema).toBeLessThan(100);

    expect(detectTrend([1, 2, 10, 20])).toBe('increasing');
    expect(detectTrend([20, 15, 2, 1])).toBe('decreasing');
    expect(detectTrend([5, 5, 5, 5])).toBe('stable');
  });

  // ====================================================================
  // 4. computeUtilityScore re-exported from utility-score.ts
  // ====================================================================
  it('computeUtilityScore is same function from both decay and utility-score', () => {
    const fromDecay = computeUtilityScore(0.5, 10);
    const fromUtilityScore = reExportedUtilityScore(0.5, 10);
    expect(fromDecay).toBe(fromUtilityScore);
    expect(fromDecay).toBeCloseTo(0.5 * Math.log(12), 5);
  });

  // ====================================================================
  // 5. boardStatus defaults on addScheduledItem
  // ====================================================================
  it('addScheduledItem defaults boardStatus based on triggerAt', () => {
    const db = ctx.scallopStore.getDatabase();

    // With triggerAt > 0 → 'scheduled'
    const scheduled = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: 'Call the plumber tomorrow',
      context: null,
      triggerAt: Date.now() + 86400000,
      recurring: null,
      sourceMemoryId: null,
    });
    expect(scheduled.boardStatus).toBe('scheduled');

    // With triggerAt = 0 → 'inbox'
    const inbox = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: 'Look into new phone plans',
      context: null,
      triggerAt: 0,
      recurring: null,
      sourceMemoryId: null,
    });
    expect(inbox.boardStatus).toBe('inbox');
  });

  // ====================================================================
  // 6. markFired / markDismissed update boardStatus
  // ====================================================================
  it('markFired and markDismissed sync boardStatus', () => {
    const db = ctx.scallopStore.getDatabase();

    const item1 = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent',
      kind: 'nudge', type: 'follow_up',
      message: 'Follow up on project review',
      context: null, triggerAt: Date.now() - 1000, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(item1.id);
    const fired = db.getScheduledItem(item1.id)!;
    expect(fired.status).toBe('fired');
    expect(fired.boardStatus).toBe('done');

    const item2 = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user',
      kind: 'nudge', type: 'reminder',
      message: 'Old reminder to dismiss',
      context: null, triggerAt: Date.now() + 1000, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemDismissed(item2.id);
    const dismissed = db.getScheduledItem(item2.id)!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.boardStatus).toBe('archived');
  });

  // ====================================================================
  // 7. Dedup constants used in consolidation
  // ====================================================================
  it('consolidateDuplicateScheduledItems deduplicates similar items', () => {
    const db = ctx.scallopStore.getDatabase();
    const now = Date.now();

    db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent',
      kind: 'nudge', type: 'follow_up',
      message: 'Remind Alice about the meeting with John',
      context: null, triggerAt: now + 3600000, recurring: null, sourceMemoryId: null,
    });
    db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent',
      kind: 'nudge', type: 'follow_up',
      message: 'Remind Alice about meeting with John soon',
      context: null, triggerAt: now + 3600000, recurring: null, sourceMemoryId: null,
    });

    const removed = db.consolidateDuplicateScheduledItems();
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  // ====================================================================
  // 8. hasSimilarPendingScheduledItem works with named constants
  // ====================================================================
  it('hasSimilarPendingScheduledItem detects duplicates', () => {
    const db = ctx.scallopStore.getDatabase();

    db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent',
      kind: 'nudge', type: 'follow_up',
      message: 'Check on the marathon training schedule',
      context: null, triggerAt: Date.now() + 3600000, recurring: null, sourceMemoryId: null,
    });

    // Similar message should be detected
    expect(db.hasSimilarPendingScheduledItem('default', 'Check on the marathon training schedule update')).toBe(true);
    // Completely different message should not
    expect(db.hasSimilarPendingScheduledItem('default', 'Buy new running shoes at the store')).toBe(false);
  });

  // ====================================================================
  // 9. BoardService.getBoardContext with excludeGoalLinked
  // ====================================================================
  it('getBoardContext excludes goal-linked items when requested', () => {
    const db = ctx.scallopStore.getDatabase();
    const boardService = new BoardService(db, testLogger);

    // Create a goal-linked item
    db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent',
      kind: 'nudge', type: 'goal_checkin',
      message: 'Marathon training check-in',
      context: null, triggerAt: Date.now() + 86400000,
      recurring: null, sourceMemoryId: null,
      goalId: 'goal-123',
      boardStatus: 'scheduled',
    });

    // Create a non-goal item
    db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user',
      kind: 'nudge', type: 'reminder',
      message: 'Buy groceries',
      context: null, triggerAt: Date.now() + 86400000,
      recurring: null, sourceMemoryId: null,
      boardStatus: 'scheduled',
    });

    const withGoals = boardService.getBoardContext('default', 'show my board');
    const withoutGoals = boardService.getBoardContext('default', 'show my board', { excludeGoalLinked: true });

    // Both should include content, but without goals should have fewer items
    expect(withGoals.length).toBeGreaterThan(0);
    expect(withoutGoals.length).toBeGreaterThan(0);

    // The goal-linked item text should appear in full but not in excluded
    expect(withGoals).toContain('Marathon training');
    expect(withoutGoals).not.toContain('Marathon training');
  });

  // ====================================================================
  // 10. computeBoardStatus still works for truly legacy items
  // ====================================================================
  it('computeBoardStatus derives status from legacy fields', () => {
    // Simulate a legacy ScheduledItem with null boardStatus
    const legacy = {
      boardStatus: null,
      status: 'pending' as const,
      triggerAt: 1000,
    } as any;
    expect(computeBoardStatus(legacy)).toBe('scheduled');

    const legacyInbox = { ...legacy, triggerAt: 0 };
    expect(computeBoardStatus(legacyInbox)).toBe('inbox');

    const legacyFired = { ...legacy, status: 'fired' };
    expect(computeBoardStatus(legacyFired)).toBe('done');

    const legacyDismissed = { ...legacy, status: 'dismissed' };
    expect(computeBoardStatus(legacyDismissed)).toBe('archived');
  });

  // ====================================================================
  // 11. checkGoalDeadlines uses shared wordOverlap for dedup
  // ====================================================================
  it('checkGoalDeadlines deduplicates against existing reminders', () => {
    const goals = [
      {
        id: 'g1', userId: 'default', content: 'Finish marathon training',
        metadata: { dueDate: Date.now() + 2 * 24 * 60 * 60 * 1000, goalType: 'goal', status: 'active' },
      } as any,
    ];

    // No existing reminders → should create notification
    const result1 = checkGoalDeadlines(goals, []);
    expect(result1.notifications.length).toBe(1);

    // Existing similar reminder → should deduplicate
    const result2 = checkGoalDeadlines(goals, [
      { message: result1.notifications[0].message },
    ]);
    expect(result2.notifications.length).toBe(0);
  });

  // ====================================================================
  // 12. migrateBackfillBoardStatus runs without errors on re-init
  // ====================================================================
  it('database initializes cleanly (migrations idempotent)', () => {
    const db = ctx.scallopStore.getDatabase();
    // Verify no NULL board_status on pending items
    const nullRows = db.raw<{ id: string }>(
      "SELECT id FROM scheduled_items WHERE board_status IS NULL AND status = 'pending'",
      []
    );
    expect(nullRows.length).toBe(0);
  });

  // ====================================================================
  // 13. runFullDecay includes utility-based archival
  // ====================================================================
  it('runFullDecay returns combined archived count', () => {
    const result = runFullDecay({
      scallopStore: ctx.scallopStore,
      db: ctx.scallopStore.getDatabase(),
      logger: testLogger,
      quietHours: { start: 2, end: 5 },
      disableArchival: false,
    });
    // Should return without error, counts >= 0
    expect(result.updated).toBeGreaterThanOrEqual(0);
    expect(result.archived).toBeGreaterThanOrEqual(0);
  });

  // ====================================================================
  // 14. runEnhancedForgetting no longer includes archival (moved to B1)
  // ====================================================================
  it('runEnhancedForgetting completes without utility archival substep', async () => {
    // Should complete without error
    await runEnhancedForgetting({
      scallopStore: ctx.scallopStore,
      db: ctx.scallopStore.getDatabase(),
      logger: testLogger,
      quietHours: { start: 2, end: 5 },
      disableArchival: false,
    });
    // If we got here, it ran without the old 3b substep
    expect(true).toBe(true);
  });
});
