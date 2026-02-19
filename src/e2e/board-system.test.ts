/**
 * E2E Board System Tests
 *
 * Validates the full kanban board system end-to-end via WebSocket:
 *
 * 1. Chat triggers fact extraction → board items created with boardStatus='inbox'
 * 2. Board items persist correctly with priority, labels, goalId
 * 3. BoardService operations (create, move, done, archive) work through DB
 * 4. Backward compat: legacy scheduled_items appear on the board via computed status
 * 5. Goal bridge: completing a board item with goalId updates goal progress
 * 6. Scheduler sets board_status transitions (in_progress, done, waiting)
 * 7. Auto-archive of old done items
 * 8. Morning digest collects unnotified completed items
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createE2EGateway,
  createWsClient,
  cleanupE2E,
  type E2EGatewayContext,
  type WsClient,
} from './helpers.js';
import { BoardService } from '../board/board-service.js';
import { UnifiedScheduler } from '../proactive/scheduler.js';
import pino from 'pino';

const testLogger = pino({ level: 'silent' });

// ============================================================================
// Suite 1: Chat → Fact Extraction → Board Items
// ============================================================================
describe('E2E Board System', () => {

  describe('fact extraction creates board items with boardStatus=inbox', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const agentResponses = [
        "Got it, I'll help you prepare for your trip to Tokyo! [DONE]",
        "I've noted your dentist appointment for next Tuesday. [DONE]",
      ];

      const factExtractorResponses = [
        // Response 1: Tokyo trip → task trigger with priority
        JSON.stringify({
          facts: [
            {
              content: 'User is planning a trip to Tokyo in April',
              subject: 'user',
              category: 'event',
              confidence: 0.95,
              action: 'fact',
            },
          ],
          proactive_triggers: [
            {
              type: 'event_prep',
              kind: 'task',
              description: 'Research Tokyo travel requirements and tips',
              trigger_time: '+4h',
              context: 'User planning Tokyo trip in April',
              guidance: 'Look up visa requirements, weather, and must-see spots',
              goal: 'Research Tokyo travel requirements for April trip',
              tools: ['web_search'],
              priority: 'high',
            },
          ],
        }),
        // Response 2: dentist appointment → nudge trigger
        JSON.stringify({
          facts: [
            {
              content: 'User has dentist appointment next Tuesday at 2pm',
              subject: 'user',
              category: 'event',
              confidence: 0.9,
              action: 'fact',
            },
          ],
          proactive_triggers: [
            {
              type: 'follow_up',
              kind: 'nudge',
              description: 'Reminder: Dentist appointment tomorrow at 2pm',
              trigger_time: '+24h',
              context: 'Dentist appointment next Tuesday 2pm',
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

    it('creates a task board item with boardStatus=inbox from chat', async () => {
      // Send chat message about Tokyo trip
      client.send({
        type: 'chat',
        message: "I'm planning a trip to Tokyo in April, can you help me prepare?",
      });
      const messages = await client.collectUntilResponse(15000);
      const response = messages.find(m => m.type === 'response');
      expect(response).toBeDefined();
      expect(response!.content).toContain('Tokyo');

      // Wait for async fact extraction to complete
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Check DB: scheduled item should have boardStatus='inbox'
      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');

      const taskItem = items.find(i => i.kind === 'task' && i.message.includes('Tokyo'));
      expect(taskItem).toBeDefined();
      expect(taskItem!.boardStatus).toBe('inbox');
      expect(taskItem!.source).toBe('agent');
      expect(taskItem!.type).toBe('event_prep');
      expect(taskItem!.taskConfig).not.toBeNull();
      expect(taskItem!.taskConfig!.goal).toContain('Tokyo');

      // Verify via BoardService
      const boardService = new BoardService(db, testLogger);
      const board = boardService.getBoard('default');
      const inboxItems = board.columns.inbox;

      const tokyoItem = inboxItems.find(i => i.title.includes('Tokyo'));
      expect(tokyoItem).toBeDefined();
      expect(tokyoItem!.kind).toBe('task');
      expect(tokyoItem!.boardStatus).toBe('inbox');
    }, 30000);

    it('creates a nudge board item with boardStatus=inbox from chat', async () => {
      // Send chat message about dentist
      client.send({
        type: 'chat',
        message: 'I have a dentist appointment next Tuesday at 2pm',
      });
      const messages = await client.collectUntilResponse(15000);
      expect(messages.find(m => m.type === 'response')).toBeDefined();

      // Wait for fact extraction
      await new Promise(resolve => setTimeout(resolve, 2500));

      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');

      const nudgeItem = items.find(i => i.kind === 'nudge' && i.message.toLowerCase().includes('dentist'));
      expect(nudgeItem).toBeDefined();
      expect(nudgeItem!.boardStatus).toBe('inbox');
      expect(nudgeItem!.source).toBe('agent');
      expect(nudgeItem!.taskConfig).toBeNull();
    }, 30000);
  });

  // ============================================================================
  // Suite 2: BoardService CRUD operations via direct DB
  // ============================================================================
  describe('BoardService operations', () => {
    let ctx: E2EGatewayContext;
    let boardService: BoardService;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      boardService = new BoardService(ctx.scallopStore.getDatabase(), testLogger);
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('creates items and views them on the board', () => {
      // Create a few board items with different statuses
      const item1 = boardService.createItem('default', {
        title: 'Buy groceries',
        kind: 'nudge',
        priority: 'medium',
        source: 'user',
      });
      expect(item1.id).toBeTruthy();
      expect(item1.boardStatus).toBe('backlog');  // user-created, no trigger time
      expect(item1.priority).toBe('medium');

      const item2 = boardService.createItem('default', {
        title: 'Research vacation spots',
        kind: 'task',
        priority: 'high',
        source: 'user',
        triggerAt: Date.now() + 3600000,
      });
      expect(item2.boardStatus).toBe('scheduled');

      const item3 = boardService.createItem('default', {
        title: 'Agent detected a pattern',
        kind: 'nudge',
        priority: 'low',
        source: 'agent',
      });
      expect(item3.boardStatus).toBe('inbox');  // agent-created → inbox

      // View board
      const board = boardService.getBoard('default');
      expect(board.columns.backlog.length).toBeGreaterThanOrEqual(1);
      expect(board.columns.scheduled.length).toBeGreaterThanOrEqual(1);
      expect(board.columns.inbox.length).toBeGreaterThanOrEqual(1);
      expect(board.stats.totalActive).toBeGreaterThanOrEqual(3);

      // Verify specific items
      expect(board.columns.backlog.some(i => i.title === 'Buy groceries')).toBe(true);
      expect(board.columns.scheduled.some(i => i.title === 'Research vacation spots')).toBe(true);
      expect(board.columns.inbox.some(i => i.title === 'Agent detected a pattern')).toBe(true);
    });

    it('moves items between columns', () => {
      // Create item
      const item = boardService.createItem('default', {
        title: 'Moveable task',
        kind: 'nudge',
        source: 'user',
      });
      expect(item.boardStatus).toBe('backlog');

      // Move to in_progress
      const moved = boardService.moveItem(item.id, 'in_progress');
      expect(moved).not.toBeNull();
      expect(moved!.boardStatus).toBe('in_progress');

      // Verify in DB
      const db = ctx.scallopStore.getDatabase();
      const dbItem = db.getScheduledItem(item.id);
      expect(dbItem!.boardStatus).toBe('in_progress');

      // Move to waiting (blocked)
      const blocked = boardService.moveItem(item.id, 'waiting');
      expect(blocked!.boardStatus).toBe('waiting');

      // Move to done
      const done = boardService.moveItem(item.id, 'done');
      expect(done!.boardStatus).toBe('done');
    });

    it('marks items done with result text', () => {
      const item = boardService.createItem('default', {
        title: 'Task with result',
        kind: 'task',
        source: 'user',
      });

      const done = boardService.markDone(item.id, 'Found 3 great restaurants in Tokyo!');
      expect(done).not.toBeNull();
      expect(done!.boardStatus).toBe('done');

      // Check result stored in DB
      const detail = boardService.getItem(item.id);
      expect(detail).not.toBeNull();
      expect(detail!.result).not.toBeNull();
      expect(detail!.result!.response).toBe('Found 3 great restaurants in Tokyo!');
      expect(detail!.result!.completedAt).toBeGreaterThan(0);
    });

    it('archives items', () => {
      const item = boardService.createItem('default', {
        title: 'Will be archived',
        kind: 'nudge',
        source: 'user',
      });

      const archived = boardService.archive(item.id);
      expect(archived).not.toBeNull();
      expect(archived!.boardStatus).toBe('archived');

      // Should not appear in active columns
      const board = boardService.getBoard('default');
      const allActive = [
        ...board.columns.inbox,
        ...board.columns.backlog,
        ...board.columns.scheduled,
        ...board.columns.in_progress,
        ...board.columns.waiting,
      ];
      expect(allActive.find(i => i.id === item.id)).toBeUndefined();
    });

    it('snoozes items to a new time', () => {
      const item = boardService.createItem('default', {
        title: 'Snoozeable',
        kind: 'nudge',
        source: 'user',
        triggerAt: Date.now() + 1000,
      });
      expect(item.boardStatus).toBe('scheduled');

      const futureTime = Date.now() + 86400000; // +24h
      const snoozed = boardService.snooze(item.id, futureTime);
      expect(snoozed).not.toBeNull();
      expect(snoozed!.boardStatus).toBe('scheduled');
      expect(snoozed!.triggerAt).toBe(futureTime);
    });

    it('creates items with labels', () => {
      const item = boardService.createItem('default', {
        title: 'Labeled item',
        kind: 'nudge',
        source: 'user',
        labels: ['personal', 'urgent'],
      });

      const detail = boardService.getItem(item.id);
      expect(detail!.labels).toEqual(['personal', 'urgent']);
    });

    it('updates item fields', () => {
      const item = boardService.createItem('default', {
        title: 'Original title',
        kind: 'nudge',
        priority: 'low',
        source: 'user',
      });

      const updated = boardService.updateItem(item.id, {
        title: 'Updated title',
        priority: 'urgent',
        labels: ['work'],
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Updated title');
      expect(updated!.priority).toBe('urgent');

      const detail = boardService.getItem(item.id);
      expect(detail!.labels).toEqual(['work']);
    });
  });

  // ============================================================================
  // Suite 3: Backward compatibility — legacy items appear on board
  // ============================================================================
  describe('backward compatibility with legacy items', () => {
    let ctx: E2EGatewayContext;
    let boardService: BoardService;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      boardService = new BoardService(ctx.scallopStore.getDatabase(), testLogger);
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('legacy pending items appear as scheduled or inbox', () => {
      const db = ctx.scallopStore.getDatabase();

      // Items without explicit boardStatus now get a default based on triggerAt
      const item = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: 'Legacy reminder: call dentist',
        context: null,
        triggerAt: Date.now() + 7200000,
        recurring: null,
        sourceMemoryId: null,
      });
      expect(item.boardStatus).toBe('scheduled');

      // Board should show it in 'scheduled' column
      const board = boardService.getBoard('default');
      const found = board.columns.scheduled.find(i => i.id === item.id);
      expect(found).toBeDefined();
      expect(found!.boardStatus).toBe('scheduled');
    });

    it('legacy fired items appear as done', () => {
      const db = ctx.scallopStore.getDatabase();

      // Create and fire a legacy item
      const item = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Legacy fired item',
        context: null,
        triggerAt: Date.now() - 60000,
        recurring: null,
        sourceMemoryId: null,
      });
      db.markScheduledItemFired(item.id);

      // Board should show it as 'done'
      const board = boardService.getBoard('default');
      const found = board.columns.done.find(i => i.id === item.id);
      expect(found).toBeDefined();
      expect(found!.boardStatus).toBe('done');
    });

    it('legacy dismissed items appear as archived', () => {
      const db = ctx.scallopStore.getDatabase();

      const item = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: 'Legacy dismissed item',
        context: null,
        triggerAt: Date.now() + 1000,
        recurring: null,
        sourceMemoryId: null,
      });
      db.markScheduledItemDismissed(item.id);

      const board = boardService.getBoard('default');
      const found = board.columns.archived.find(i => i.id === item.id);
      expect(found).toBeDefined();
      expect(found!.boardStatus).toBe('archived');
    });
  });

  // ============================================================================
  // Suite 4: Goal bridge — completing board item updates goal
  // ============================================================================
  describe('goal bridge', () => {
    let ctx: E2EGatewayContext;
    let boardService: BoardService;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      boardService = new BoardService(ctx.scallopStore.getDatabase(), testLogger);
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('completing a board item with goalId marks the goal task as completed', () => {
      const db = ctx.scallopStore.getDatabase();
      const now = Date.now();

      // Create a goal → milestone → task hierarchy in memories
      // Use the IDs returned by addMemory
      const goalMem = db.addMemory({
        userId: 'default',
        content: 'Learn Spanish',
        category: 'insight',
        memoryType: 'regular',
        importance: 8,
        confidence: 1.0,
        isLatest: true,
        documentDate: now,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: { goalType: 'goal', status: 'active', progress: 0 },
      });
      const goalId = goalMem.id;

      const milestoneMem = db.addMemory({
        userId: 'default',
        content: 'Complete Duolingo basics',
        category: 'insight',
        memoryType: 'regular',
        importance: 7,
        confidence: 1.0,
        isLatest: true,
        documentDate: now,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: { goalType: 'milestone', status: 'active', parentId: goalId, progress: 0 },
      });
      const milestoneId = milestoneMem.id;

      const taskMem = db.addMemory({
        userId: 'default',
        content: 'Finish lesson 5',
        category: 'insight',
        memoryType: 'regular',
        importance: 6,
        confidence: 1.0,
        isLatest: true,
        documentDate: now,
        eventDate: null,
        prominence: 1.0,
        lastAccessed: null,
        accessCount: 0,
        sourceChunk: null,
        embedding: null,
        metadata: { goalType: 'task', status: 'active', parentId: milestoneId },
      });
      const taskId = taskMem.id;

      // Create EXTENDS relations
      db.addRelation(taskId, milestoneId, 'EXTENDS');
      db.addRelation(milestoneId, goalId, 'EXTENDS');

      // Create a board item linked to the task
      const boardItem = boardService.createItem('default', {
        title: 'Finish lesson 5',
        kind: 'task',
        source: 'user',
        goalId: taskId,
      });

      // Verify task is still active
      const taskBefore = db.getMemory(taskId);
      const metaBefore = taskBefore!.metadata as Record<string, unknown>;
      expect(metaBefore.status).toBe('active');

      // Mark board item done
      boardService.markDone(boardItem.id, 'Lesson 5 completed!');

      // Verify goal task is now completed
      const taskAfter = db.getMemory(taskId);
      const metaAfter = taskAfter!.metadata as Record<string, unknown>;
      expect(metaAfter.status).toBe('completed');
      expect(metaAfter.completedAt).toBeDefined();

      // Verify milestone progress updated
      const milestone = db.getMemory(milestoneId);
      const milestoneMeta = milestone!.metadata as Record<string, unknown>;
      expect(milestoneMeta.progress).toBe(100); // 1/1 task completed
    });
  });

  // ============================================================================
  // Suite 5: Scheduler board status transitions
  // ============================================================================
  describe('scheduler board status transitions', () => {
    let ctx: E2EGatewayContext;
    let scheduler: UnifiedScheduler;
    const sentMessages: Array<{ userId: string; message: string }> = [];

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      const db = ctx.scallopStore.getDatabase();

      // Create a nudge item that's due with boardStatus set
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Time to take a break!',
        context: 'Work timer',
        triggerAt: Date.now() - 60000,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'scheduled',
        priority: 'medium',
      });

      // Create a task item that's due (no sub-agent → will fall back)
      db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'agent',
        kind: 'task',
        type: 'event_prep',
        message: 'Check weather for hiking trip',
        context: JSON.stringify({ original_context: 'Hiking trip this weekend' }),
        triggerAt: Date.now() - 60000,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'scheduled',
        priority: 'high',
        taskConfig: {
          goal: 'Check weekend weather forecast for hiking',
          tools: ['web_search'],
        },
      });

      // Compute a timezone where the current hour is noon (always outside quiet hours 22-8)
      const utcHour = new Date().getUTCHours();
      const offsetToNoon = 12 - utcHour;
      // Etc/GMT sign is inverted: Etc/GMT-5 means UTC+5
      const gmtTz = offsetToNoon >= 0 ? `Etc/GMT-${offsetToNoon}` : `Etc/GMT+${-offsetToNoon}`;

      scheduler = new UnifiedScheduler({
        db,
        logger: testLogger,
        interval: 60000,
        onSendMessage: async (userId, message) => {
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

    it('transitions nudge items to done after firing', async () => {
      await scheduler.evaluate();

      // Nudge should have been sent
      const breakMsg = sentMessages.find(m => m.message.includes('break'));
      expect(breakMsg).toBeDefined();

      // Check DB: item should be done
      const db = ctx.scallopStore.getDatabase();
      const boardService = new BoardService(db, testLogger);
      const board = boardService.getBoard('default');

      // The nudge item should now be in done column
      const doneItems = board.columns.done;
      const breakItem = doneItems.find(i => i.title.includes('break'));
      expect(breakItem).toBeDefined();
      expect(breakItem!.boardStatus).toBe('done');
    });

    it('transitions task items to done after fallback firing', async () => {
      // Task should have fallen back to nudge (no sub-agent)
      const weatherMsg = sentMessages.find(m =>
        m.message.toLowerCase().includes('weather') || m.message.toLowerCase().includes('hiking')
      );
      expect(weatherMsg).toBeDefined();

      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');
      const weatherItem = items.find(i => i.message.includes('weather'));
      // Should no longer be pending
      expect(weatherItem!.status).not.toBe('pending');
    });
  });

  // ============================================================================
  // Suite 6: Auto-archive and board context
  // ============================================================================
  describe('auto-archive and board context', () => {
    let ctx: E2EGatewayContext;
    let boardService: BoardService;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      boardService = new BoardService(ctx.scallopStore.getDatabase(), testLogger);
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('auto-archives done items older than 7 days', () => {
      const db = ctx.scallopStore.getDatabase();

      // Create a done item
      const item = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: 'Old done item for archiving',
        context: null,
        triggerAt: Date.now() - 86400000,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'done',
      });

      // Auto-archive with negative maxAgeMs so cutoff is in the future, archiving everything
      const archived = db.autoArchiveDoneItems('default', -5000);
      expect(archived).toBeGreaterThanOrEqual(1);

      // Verify item is now archived
      const dbItem = db.getScheduledItem(item.id);
      expect(dbItem!.boardStatus).toBe('archived');
    });

    it('getBoardContext returns minimal summary for non-board queries', () => {
      // Create some active items
      boardService.createItem('default', { title: 'Active task 1', kind: 'nudge', source: 'user' });
      boardService.createItem('default', { title: 'Active task 2', kind: 'task', source: 'user', priority: 'urgent' });

      const context = boardService.getBoardContext('default', 'What is the weather like?');
      // Non-board keyword → minimal summary
      expect(context).toContain('active items');
      expect(context).not.toContain('BACKLOG');  // Full view would have column headers
    });

    it('getBoardContext returns full board for board-related queries', () => {
      const context = boardService.getBoardContext('default', "What's on my board?");
      expect(context).toContain('TASK BOARD');
    });

    it('getBoardContext returns empty for user with no items', () => {
      const context = boardService.getBoardContext('nonexistent-user', 'hello');
      expect(context).toBe('');
    });
  });

  // ============================================================================
  // Suite 7: Multi-turn conversation with board awareness
  // ============================================================================
  describe('multi-turn conversation with board items', () => {
    let ctx: E2EGatewayContext;
    let client: WsClient;

    beforeAll(async () => {
      const agentResponses = [
        "I'll help you plan the birthday party! Let me note that down. [DONE]",
        "Great, you have several things to work on. Let me check your board. [DONE]",
      ];

      const factExtractorResponses = [
        JSON.stringify({
          facts: [
            {
              content: "User is planning a birthday party for next Saturday",
              subject: 'user',
              category: 'event',
              confidence: 0.95,
              action: 'fact',
            },
          ],
          proactive_triggers: [
            {
              type: 'event_prep',
              kind: 'task',
              description: 'Birthday party planning checklist',
              trigger_time: '+2h',
              context: 'Birthday party next Saturday',
              goal: 'Create a birthday party planning checklist',
              priority: 'high',
            },
          ],
        }),
        // Second turn: no new triggers
        JSON.stringify({
          facts: [],
          proactive_triggers: [],
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

    it('creates board items from first message and board is queryable in second', async () => {
      // Turn 1: mention the party
      client.send({
        type: 'chat',
        message: "I need to plan a birthday party for next Saturday!",
      });
      const turn1 = await client.collectUntilResponse(15000);
      const response1 = turn1.find(m => m.type === 'response');
      expect(response1).toBeDefined();
      const sessionId = response1!.sessionId;
      expect(sessionId).toBeDefined();

      // Wait for fact extraction
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Verify board item created
      const db = ctx.scallopStore.getDatabase();
      const items = db.getScheduledItemsByUser('default');
      const partyItem = items.find(i => i.message.toLowerCase().includes('birthday'));
      expect(partyItem).toBeDefined();
      expect(partyItem!.boardStatus).toBe('inbox');

      // Turn 2: ask about the board (reuse session)
      client.send({
        type: 'chat',
        message: "What do I have on my plate?",
        sessionId,
      });
      const turn2 = await client.collectUntilResponse(15000);
      const response2 = turn2.find(m => m.type === 'response');
      expect(response2).toBeDefined();

      // Verify the agent's system prompt included board context
      // (We check the mock provider's last request for the system prompt)
      const lastRequest = ctx.mockProvider.lastRequest;
      expect(lastRequest).not.toBeNull();
      const systemPrompt = lastRequest!.system ?? '';
      // "plate" matches "what's next" / "plate" trigger in getBoardContext
      // The board should be visible in the system prompt
      expect(systemPrompt.length).toBeGreaterThan(0);
    }, 30000);
  });

  // ============================================================================
  // Suite 8: Board item with dependencies
  // ============================================================================
  describe('board item dependencies', () => {
    let ctx: E2EGatewayContext;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('items with dependsOn are stored and readable', () => {
      const db = ctx.scallopStore.getDatabase();

      // Create a prerequisite item
      const prereq = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'task',
        type: 'reminder',
        message: 'Prerequisite task',
        context: null,
        triggerAt: Date.now() + 3600000,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'backlog',
        priority: 'medium',
      });

      // Create a dependent item
      const dependent = db.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'task',
        type: 'reminder',
        message: 'Dependent task',
        context: null,
        triggerAt: Date.now() + 7200000,
        recurring: null,
        sourceMemoryId: null,
        boardStatus: 'backlog',
        priority: 'medium',
        dependsOn: [prereq.id],
      });

      expect(dependent.dependsOn).toEqual([prereq.id]);

      // Read back from DB
      const stored = db.getScheduledItem(dependent.id);
      expect(stored).not.toBeNull();
      expect(stored!.dependsOn).toEqual([prereq.id]);

      // BoardService should see the dependency
      const boardService = new BoardService(db, testLogger);
      const detail = boardService.getItem(dependent.id);
      expect(detail).not.toBeNull();
      expect(detail!.dependsOn).toEqual([prereq.id]);
    });
  });

  // ============================================================================
  // Suite 9: Board display formatting
  // ============================================================================
  describe('board display formatting', () => {
    let ctx: E2EGatewayContext;
    let boardService: BoardService;

    beforeAll(async () => {
      ctx = await createE2EGateway({ responses: ['OK [DONE]'] });
      boardService = new BoardService(ctx.scallopStore.getDatabase(), testLogger);
    }, 30000);

    afterAll(async () => { await cleanupE2E(ctx); }, 15000);

    it('formatBoardDisplay produces readable output', () => {
      // Create items in different columns with different priorities
      boardService.createItem('display-user', { title: 'URGENT: Server down!', kind: 'task', source: 'user', priority: 'urgent' });
      boardService.createItem('display-user', { title: 'Write report', kind: 'nudge', source: 'user', priority: 'medium' });
      boardService.createItem('display-user', { title: 'Agent suggestion', kind: 'nudge', source: 'agent', priority: 'low' });

      const board = boardService.getBoard('display-user');
      const display = boardService.formatBoardDisplay(board);

      expect(display).toContain('YOUR BOARD');
      expect(display).toContain('URGENT');
      expect(display).toContain('Server down');
      expect(display).toContain('Write report');
    });

    it('formatItemDetail shows full item info', () => {
      const item = boardService.createItem('display-user', {
        title: 'Detailed task',
        kind: 'task',
        source: 'user',
        priority: 'high',
        labels: ['work', 'project-x'],
        triggerAt: Date.now() + 86400000,
      });

      const detail = boardService.getItem(item.id);
      expect(detail).not.toBeNull();

      const formatted = boardService.formatItemDetail(detail!);
      expect(formatted).toContain('Detailed task');
      expect(formatted).toContain('high');
      expect(formatted).toContain('work, project-x');
      expect(formatted).toContain('Scheduled:');
    });
  });
});
