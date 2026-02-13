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
  });

  describe('getLastProactiveAt', () => {
    it('returns null when no fired items exist', () => {
      const result = getLastProactiveAt(db, 'user-1');
      expect(result).toBeNull();
    });

    it('returns most recent firedAt from agent-sourced items', () => {
      // Add two fired agent items
      const item1 = db.addScheduledItem({
        userId: 'user-1',
        sessionId: null,
        source: 'agent',
        type: 'follow_up',
        message: 'Older item',
        context: null,
        triggerAt: Date.now() - 10000,
        recurring: null,
        sourceMemoryId: null,
      });
      db.markScheduledItemFired(item1.id);

      const item2 = db.addScheduledItem({
        userId: 'user-1',
        sessionId: null,
        source: 'agent',
        type: 'follow_up',
        message: 'Newer item',
        context: null,
        triggerAt: Date.now() - 5000,
        recurring: null,
        sourceMemoryId: null,
      });
      db.markScheduledItemFired(item2.id);

      const result = getLastProactiveAt(db, 'user-1');
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
    });

    it('ignores non-agent items', () => {
      const item = db.addScheduledItem({
        userId: 'user-1',
        sessionId: null,
        source: 'user',
        type: 'reminder',
        message: 'User reminder',
        context: null,
        triggerAt: Date.now() - 5000,
        recurring: null,
        sourceMemoryId: null,
      });
      db.markScheduledItemFired(item.id);

      const result = getLastProactiveAt(db, 'user-1');
      expect(result).toBeNull();
    });
  });
});
