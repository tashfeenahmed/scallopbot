import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import pino from 'pino';
import { ScallopMemoryStore } from './scallop-store.js';
import { scheduleProactiveItem, getLastProactiveAt } from './gardener-scheduling.js';
import type { ScallopDatabase } from './db.js';

const TEST_DB_PATH = '/tmp/gardener-scheduling-test.db';
const logger = pino({ level: 'silent' });

function cleanupTestDb() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch { /* ignore */ }
}

describe('gardener-scheduling', () => {
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

  describe('scheduleProactiveItem', () => {
    it('inserts item via db.addScheduledItem with timing output', () => {
      const result = scheduleProactiveItem({
        db,
        userId: 'user-1',
        message: 'Check on project progress',
        context: JSON.stringify({ source: 'inner_thoughts' }),
        type: 'follow_up',
        quietHours: { start: 2, end: 5 },
        activeHours: [9, 10, 11, 14, 15],
        lastProactiveAt: null,
        urgency: 'medium',
        now: new Date('2025-06-15T10:00:00Z').getTime(),
      });

      expect(result.timing).toBeDefined();
      expect(result.timing.deliverAt).toBeGreaterThan(0);
      expect(result.timing.strategy).toBeDefined();
      expect(result.itemId).toBeDefined();

      // Verify it was persisted
      const items = db.getScheduledItemsByUser('user-1');
      expect(items.length).toBe(1);
      expect(items[0].message).toBe('Check on project progress');
      expect(items[0].source).toBe('agent');
      expect(items[0].type).toBe('follow_up');
    });

    it('passes urgency levels correctly (low/medium/high)', () => {
      const baseInput = {
        db,
        userId: 'user-1',
        message: 'test',
        context: null,
        type: 'follow_up',
        quietHours: { start: 2, end: 5 },
        activeHours: [9, 10, 11],
        lastProactiveAt: null,
        now: new Date('2025-06-15T10:00:00Z').getTime(),
      };

      const lowResult = scheduleProactiveItem({ ...baseInput, urgency: 'low', message: 'low msg' });
      const highResult = scheduleProactiveItem({ ...baseInput, urgency: 'high', message: 'high msg' });

      // High urgency should deliver sooner than low urgency
      expect(highResult.timing.deliverAt).toBeLessThanOrEqual(lowResult.timing.deliverAt);
    });

    it('uses injectable now for deterministic time', () => {
      const fixedNow = new Date('2025-01-01T12:00:00Z').getTime();

      const result = scheduleProactiveItem({
        db,
        userId: 'user-1',
        message: 'Deterministic test',
        context: null,
        type: 'follow_up',
        quietHours: { start: 2, end: 5 },
        activeHours: [],
        lastProactiveAt: null,
        urgency: 'medium',
        now: fixedNow,
      });

      expect(result.timing.deliverAt).toBeGreaterThanOrEqual(fixedNow);
    });

    it('preserves the source conversation for a later reply', () => {
      scheduleProactiveItem({
        db,
        userId: 'telegram:123',
        sessionId: 'conversation-1',
        message: 'How did the prototype review go?',
        context: null,
        type: 'follow_up',
        quietHours: { start: 2, end: 5 },
        activeHours: [],
        lastProactiveAt: null,
        urgency: 'low',
      });

      expect(db.getScheduledItemsByUser('telegram:123')[0].sessionId).toBe('conversation-1');
    });

    it('promotes stale-board context provenance to sourceItemId', () => {
      const source = db.addScheduledItem({
        userId: 'user-1', sessionId: null, source: 'user', kind: 'task',
        type: 'reminder', message: 'Publish Atlas', context: null,
        triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
        boardStatus: 'waiting',
      });
      const result = scheduleProactiveItem({
        db,
        userId: 'user-1',
        message: 'Should the Atlas task stay open?',
        context: JSON.stringify({ gapType: 'stale_board_item', sourceId: source.id }),
        type: 'follow_up',
        quietHours: { start: 2, end: 5 },
        activeHours: [],
        lastProactiveAt: null,
        urgency: 'medium',
      });

      expect(db.getScheduledItem(result.itemId)?.sourceItemId).toBe(source.id);
    });
  });

  describe('getLastProactiveAt', () => {
    it('returns null when no fired items exist', () => {
      const result = getLastProactiveAt(db, 'user-1');
      expect(result).toBeNull();
    });

    it('returns the most recent actual inferred delivery', () => {
      const older = Date.now() - 10_000;
      const newer = Date.now() - 5_000;
      db.recordProactiveSend('user-1', 'Older item', 'agent', older);
      db.recordProactiveSend('user-1', 'Newer item', 'agent', newer);

      const result = getLastProactiveAt(db, 'user-1');
      expect(result).toBe(newer);
    });

    it('ignores a fired row when no message was actually delivered', () => {
      const item = db.addScheduledItem({
        userId: 'user-1', sessionId: null, source: 'agent', type: 'follow_up',
        message: 'Suppressed item', context: null, triggerAt: Date.now() - 5_000,
        recurring: null, sourceMemoryId: null,
      });
      db.markScheduledItemFired(item.id);

      expect(getLastProactiveAt(db, 'user-1')).toBeNull();
    });

    it('ignores non-agent items', () => {
      db.recordProactiveSend('user-1', 'User reminder', 'user', Date.now() - 5_000);
      db.recordProactiveSend('user-1', 'Task report', 'task_result', Date.now() - 2_000);

      const result = getLastProactiveAt(db, 'user-1');
      expect(result).toBeNull();
    });
  });
});
