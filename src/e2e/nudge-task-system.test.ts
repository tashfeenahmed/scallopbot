/**
 * E2E Nudge/Task System Tests
 *
 * Validates the full nudge/task proactive system end-to-end:
 * 1. User mentions an upcoming flight → fact extractor creates a task-kind scheduled item
 * 2. User asks to be reminded → fact extractor creates a nudge-kind scheduled item
 * 3. Scheduler fires nudge items by sending pre-written message directly
 * 4. Scheduler fires task items by falling back to nudge (no sub-agent in test env)
 * 5. DB state verifies kind and taskConfig are correctly persisted
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';
import { UnifiedScheduler } from '../proactive/scheduler.js';
import pino from 'pino';

const testLogger = pino({ level: 'silent' });

// ============================================================================
// Suite 1: Fact Extraction creates scheduled items with correct kind/taskConfig
// ============================================================================
describe('E2E Nudge/Task System', () => {

  describe('fact extraction creates nudge and task items', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      // Agent response: acknowledge the user's messages
      const agentResponses = [
        "Got it! I'll help you prepare for your flight EK204 to Dubai on March 5th. I'll look up the details before your trip. [DONE]",
        "Sure, I'll remind you to drink water every 2 hours! [DONE]",
      ];

      // Fact extractor responses: extract facts + triggers with kind field
      const factExtractorResponses = [
        // Response 1: flight mention → extracts task-kind trigger (event_prep)
        JSON.stringify({
          facts: [
            {
              content: 'User has flight EK204 to Dubai on March 5th',
              subject: 'user',
              category: 'event',
            },
          ],
          proactive_triggers: [
            {
              type: 'event_prep',
              kind: 'task',
              description: 'Prepare flight info for EK204 to Dubai',
              trigger_time: '+1h',
              context: 'User mentioned flight EK204 to Dubai on March 5th',
              guidance: 'Look up flight EK204 status and provide terminal/gate info',
              goal: 'Search for Emirates flight EK204 status and gate information',
              tools: ['web_search'],
            },
          ],
        }),
        // Response 2: reminder → extracts nudge-kind trigger (follow_up)
        JSON.stringify({
          facts: [
            {
              content: 'User wants to be reminded to drink water regularly',
              subject: 'user',
              category: 'preference',
            },
          ],
          proactive_triggers: [
            {
              type: 'follow_up',
              kind: 'nudge',
              description: 'Time to drink some water! Stay hydrated.',
              trigger_time: '+2h',
              context: 'User asked for hydration reminders',
            },
          ],
        }),
      ];

      ctx = await createE2EGateway({
        responses: agentResponses,
        factExtractorResponses,
      });
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);
    beforeEach(async () => { client = await createWsClient(ctx.port); });
    afterEach(async () => { await client.close(); });

    it('creates a task-kind item when user mentions a flight', async () => {
      // Send message about flight
      client.send({ type: 'chat', message: "I have flight EK204 to Dubai on March 5th, can you help me prepare?" });
      await client.collectUntilResponse(15000);

      // Wait for fact extraction to complete (async background process)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check DB for scheduled items
      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');

      // Find the task-kind item
      const taskItem = items.find(i => i.kind === 'task');
      expect(taskItem).toBeDefined();
      expect(taskItem!.type).toBe('event_prep');
      expect(taskItem!.source).toBe('agent');
      expect(taskItem!.taskConfig).not.toBeNull();
      expect(taskItem!.taskConfig!.goal).toContain('EK204');
      expect(taskItem!.taskConfig!.tools).toEqual(['web_search']);
      expect(taskItem!.message).toContain('flight');
    });

    it('creates a nudge-kind item when user asks for a reminder', async () => {
      // Send reminder request
      client.send({ type: 'chat', message: "Remind me to drink water every 2 hours" });
      await client.collectUntilResponse(15000);

      // Wait for fact extraction
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check DB
      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');

      // Find the nudge-kind item
      const nudgeItem = items.find(i => i.kind === 'nudge' && i.message.includes('water'));
      expect(nudgeItem).toBeDefined();
      expect(nudgeItem!.type).toBe('follow_up');
      expect(nudgeItem!.source).toBe('agent');
      expect(nudgeItem!.taskConfig).toBeNull();
      expect(nudgeItem!.message).toContain('water');
    });
  });

  // ============================================================================
  // Suite 2: Scheduler fires nudge and task items correctly
  // ============================================================================
  describe('scheduler fires nudge and task items', () => {
    let ctx: E2EGatewayContext;
    let scheduler: UnifiedScheduler;
    const sentMessages: Array<{ userId: string; message: string }> = [];

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: ['OK [DONE]'],
      });

      const db = ctx.scallopStore.getDatabase();

      // Manually insert a nudge item that's already due
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Time to drink water! Stay hydrated.',
        context: 'User asked for hydration reminders',
        triggerAt: Date.now() - 60000, // 1 minute ago (due)
        recurring: null,
        sourceMemoryId: null,
      });

      // Manually insert a task item that's already due (no sub-agent available → falls back to nudge)
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'task',
        type: 'event_prep',
        message: 'Preparing flight info for EK204',
        context: JSON.stringify({ original_context: 'Flight EK204 to Dubai' }),
        triggerAt: Date.now() - 60000, // 1 minute ago (due)
        recurring: null,
        sourceMemoryId: null,
        taskConfig: {
          goal: 'Search for Emirates flight EK204 status',
          tools: ['web_search'],
        },
      });

      // Compute a timezone where the current hour is noon (always outside quiet hours 22-8)
      const utcHour = new Date().getUTCHours();
      const offsetToNoon = 12 - utcHour;
      const gmtTz = offsetToNoon >= 0 ? `Etc/GMT-${offsetToNoon}` : `Etc/GMT+${-offsetToNoon}`;

      // Create scheduler without sub-agent executor (graceful degradation test)
      scheduler = new UnifiedScheduler({
        db,
        logger: testLogger,
        interval: 60000, // long interval so we control evaluation manually
        onSendMessage: async (userId: string, message: string) => {
          sentMessages.push({ userId, message });
          return true;
        },
        getTimezone: () => gmtTz,
      });
    }, 30000);

    afterAll(async () => {
      scheduler.stop();
      await cleanupE2E(ctx);
    }, 15000);

    it('fires both nudge and task items on evaluate()', async () => {
      // Manually trigger evaluation
      await scheduler.evaluate();

      // Both items should have been sent (task falls back to nudge since no sub-agent)
      expect(sentMessages.length).toBeGreaterThanOrEqual(2);

      // Check that nudge message was sent
      const waterMsg = sentMessages.find(m => m.message.includes('water'));
      expect(waterMsg).toBeDefined();

      // Check that task fallback message was sent (the item.message since no sub-agent)
      const flightMsg = sentMessages.find(m => m.message.includes('flight') || m.message.includes('EK204'));
      expect(flightMsg).toBeDefined();

      // Verify items are now fired in DB
      const db = ctx.scallopStore.getDatabase();
      const pending = db.getPendingScheduledItemsByUser('default');
      const firedItems = pending.filter(i =>
        i.message.includes('water') || i.message.includes('flight')
      );
      // Should have been moved out of pending
      expect(firedItems).toHaveLength(0);
    });
  });

  // ============================================================================
  // Suite 3: Kind and taskConfig survive DB round-trip
  // ============================================================================
  describe('kind and taskConfig DB persistence', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({
        responses: ['OK [DONE]'],
      });
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('persists task kind with full taskConfig through DB round-trip', () => {
      const db = ctx.scallopStore.getDatabase();

      const item = db.addScheduledItem({
        userId: 'test-user',
        sessionId: null,
        source: 'agent',
        kind: 'task',
        type: 'event_prep',
        message: 'Check weather for trip',
        context: 'Trip to Paris next week',
        triggerAt: Date.now() + 3600000,
        recurring: null,
        sourceMemoryId: null,
        taskConfig: {
          goal: 'Look up weather forecast for Paris for next week',
          tools: ['web_search'],
          modelTier: 'fast',
        },
      });

      expect(item.kind).toBe('task');
      expect(item.taskConfig).toEqual({
        goal: 'Look up weather forecast for Paris for next week',
        tools: ['web_search'],
        modelTier: 'fast',
      });

      // Read back from DB
      const items = db.getScheduledItemsByUser('test-user');
      const stored = items.find(i => i.id === item.id);
      expect(stored).toBeDefined();
      expect(stored!.kind).toBe('task');
      expect(stored!.taskConfig).toEqual({
        goal: 'Look up weather forecast for Paris for next week',
        tools: ['web_search'],
        modelTier: 'fast',
      });
    });

    it('persists nudge kind with null taskConfig', () => {
      const db = ctx.scallopStore.getDatabase();

      const item = db.addScheduledItem({
        userId: 'test-user',
        sessionId: null,
        source: 'user',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Call mom',
        context: null,
        triggerAt: Date.now() + 7200000,
        recurring: null,
        sourceMemoryId: null,
      });

      expect(item.kind).toBe('nudge');
      expect(item.taskConfig).toBeNull();

      // Read back from DB
      const items = db.getScheduledItemsByUser('test-user');
      const stored = items.find(i => i.id === item.id);
      expect(stored).toBeDefined();
      expect(stored!.kind).toBe('nudge');
      expect(stored!.taskConfig).toBeNull();
    });

    it('defaults to nudge kind when kind is not specified', () => {
      const db = ctx.scallopStore.getDatabase();

      // addScheduledItem without kind should default to 'nudge'
      const item = db.addScheduledItem({
        userId: 'test-user',
        sessionId: null,
        source: 'user',
        type: 'follow_up',
        message: 'Buy groceries',
        context: null,
        triggerAt: Date.now() + 3600000,
        recurring: null,
        sourceMemoryId: null,
      });

      expect(item.kind).toBe('nudge');
      expect(item.taskConfig).toBeNull();
    });
  });
});
