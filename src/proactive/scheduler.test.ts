import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScallopDatabase } from '../memory/db.js';
import { UnifiedScheduler } from './scheduler.js';

const logger = pino({ level: 'silent' });

function middayTimezone(): string {
  const offset = 12 - new Date().getUTCHours();
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function addPreference(db: ScallopDatabase, content: string): void {
  db.addMemory({
    userId: 'default', content, category: 'preference', memoryType: 'semantic',
    importance: 8, confidence: 1, isLatest: true, source: 'user',
    documentDate: Date.now(), eventDate: null, prominence: 0.9,
    lastAccessed: null, accessCount: 0, sourceChunk: content,
    embedding: null, metadata: null,
  });
}

describe('UnifiedScheduler proactive delivery safety', () => {
  let db: ScallopDatabase;
  let scheduler: UnifiedScheduler | undefined;

  beforeEach(() => {
    db = new ScallopDatabase(':memory:');
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    db.close();
  });

  it('never fuzzy-deletes intentional user reminders during consolidation', () => {
    const base = Date.now() + 60_000;
    const first = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', messageProvenance: 'user_literal',
      kind: 'nudge', type: 'reminder', message: 'Take medication with breakfast.',
      context: null, triggerAt: base, recurring: null, sourceMemoryId: null,
    });
    const second = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', messageProvenance: 'user_literal',
      kind: 'nudge', type: 'reminder', message: 'Take medication with breakfast.',
      context: null, triggerAt: base + 12 * 60 * 60 * 1000, recurring: null, sourceMemoryId: null,
    });

    expect(db.consolidateDuplicateScheduledItems()).toBe(0);
    expect(db.getScheduledItem(first.id)).not.toBeNull();
    expect(db.getScheduledItem(second.id)).not.toBeNull();
  });

  it('cancels a frozen inferred nudge when its source conversation continued', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
      db.createSession('source-session', { userId: 'default' });
      db.addSessionMessage('source-session', 'user', 'The review is tomorrow.');
      const item = db.addScheduledItem({
        userId: 'default', sessionId: 'source-session', source: 'agent', kind: 'nudge',
        type: 'follow_up', message: 'Did the review go ahead?', context: null,
        triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      vi.setSystemTime(new Date('2026-07-11T12:01:00Z'));
      db.addSessionMessage('source-session', 'user', 'It was cancelled, so no follow-up is needed.');
      const send = vi.fn().mockResolvedValue(true);
      scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, getTimezone: () => 'UTC' });

      await scheduler.evaluate();

      expect(send).not.toHaveBeenCalled();
      expect(db.getScheduledItem(item.id)?.status).toBe('expired');
      expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'source_conversation_changed' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an inferred nudge when newer source chat is unrelated and gives it to the renderer', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
      db.createSession('source-session', { userId: 'default' });
      db.addSessionMessage('source-session', 'user', 'The product review is tomorrow.');
      const item = db.addScheduledItem({
        userId: 'default', sessionId: 'source-session', source: 'agent', kind: 'nudge',
        type: 'follow_up', message: 'Did the product review go ahead?',
        context: 'The product review was planned for today.',
        triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      vi.setSystemTime(new Date('2026-07-11T12:10:00Z'));
      db.addSessionMessage('source-session', 'user', 'I finished making lunch and put the dishes away.');
      vi.setSystemTime(new Date('2026-07-11T12:16:00Z'));
      const router = {
        executeWithFallback: vi.fn().mockResolvedValue({
          response: { content: [{ type: 'text', text: 'Was the product review able to go ahead today?' }] },
        }),
      };
      const send = vi.fn().mockResolvedValue(true);
      scheduler = new UnifiedScheduler({
        db, logger, router: router as any, onSendMessage: send,
        getTimezone: () => 'UTC', minAgentProactiveGapMs: 0,
      });

      await scheduler.evaluate();

      expect(send).toHaveBeenCalledWith('default', 'Was the product review able to go ahead today?');
      expect(db.getScheduledItem(item.id)?.status).toBe('fired');
      expect(router.executeWithFallback.mock.calls[0][0].messages[0].content)
        .toContain('I finished making lunch and put the dishes away.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires an intentional renderer SKIP instead of retrying it', async () => {
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Did the product review go ahead?', context: null,
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'SKIP' }] },
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send, getTimezone: () => middayTimezone(),
    });

    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)).toEqual(expect.objectContaining({
      status: 'expired', attemptCount: 0,
    }));
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'renderer_skip' }),
    ]));
  });

  it('defers inferred outreach while the user is actively chatting', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
      const item = db.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
        type: 'follow_up', message: 'Did the review go ahead?', context: null,
        triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      db.createSession('active-session', { userId: 'default' });
      db.addSessionMessage('active-session', 'user', 'Can you help with this now?');
      const send = vi.fn().mockResolvedValue(true);
      scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, getTimezone: () => 'UTC' });

      await scheduler.evaluate();

      expect(send).not.toHaveBeenCalled();
      expect(db.getScheduledItem(item.id)).toEqual(expect.objectContaining({
        status: 'pending',
        triggerAt: Date.now() + 30 * 60 * 1000,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists explicit negative feedback instead of counting it as engagement', () => {
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Did the prototype review happen?', context: null,
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(item.id);
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: vi.fn().mockResolvedValue(true) });

    scheduler.checkEngagement('default', 'Why are you asking? I already told you that was done.');

    expect(db.getScheduledItem(item.id)?.status).toBe('dismissed');
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'feedback', outcome: 'dismissed', reason: 'negative' }),
    ]));
  });

  it('enforces the inferred daily ceiling from actual sends, not created rows', async () => {
    const now = Date.now();
    for (let index = 0; index < 3; index++) {
      db.recordProactiveSend('default', `Delivered inferred message ${index}`, 'agent', now - index * 60_000);
    }
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Did the prototype review happen?', context: null,
      triggerAt: now - 1, recurring: null, sourceMemoryId: null,
    });
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, getTimezone: () => middayTimezone() });

    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('pending');
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'daily_delivery_budget' }),
    ]));
  });

  it('re-checks global and topic opt-outs before delivering pending inferred items', async () => {
    addPreference(db, "Don't remind me about medication.");
    const blocked = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Your medication refill is due.', context: 'medication refill',
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const allowed = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Did the prototype review happen?', context: 'prototype review',
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Was the prototype review able to go ahead?' }] },
      }),
    };
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(db.getScheduledItem(blocked.id)?.status).toBe('expired');
    expect(db.getScheduledItem(allowed.id)?.status).toBe('fired');
    expect(send).toHaveBeenCalledOnce();

    addPreference(db, "Don't proactively check in.");
    const globallyBlocked = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Did the launch go ahead?', context: 'launch',
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    await scheduler.evaluate();
    expect(db.getScheduledItem(globallyBlocked.id)?.status).toBe('expired');
    expect(send).toHaveBeenCalledOnce();
  });

  it('matches short opt-out topics on token boundaries at delivery time', async () => {
    addPreference(db, "Don't remind me about IT.");
    const blocked = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'The IT access request is still blocked.', context: 'IT access request',
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const allowed = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Waiting for the passport renewal.', context: 'passport renewal',
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'The passport renewal is ready when you want to review it.' }] },
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(db.getScheduledItem(blocked.id)?.status).toBe('expired');
    expect(db.getScheduledItem(allowed.id)?.status).toBe('fired');
    expect(send).toHaveBeenCalledOnce();
  });

  it('delivers proven literal user text exactly without model rewriting', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [
            { type: 'thinking', thinking: 'I should ask a friendly question.' },
            { type: 'text', text: 'Hey Sam, what are your priorities and deadlines today? How are things going?' },
          ],
        },
      }),
    };
    const item = db.addScheduledItem({
      userId: 'api:test-user',
      sessionId: null,
      source: 'user',
      messageProvenance: 'user_literal',
      kind: 'nudge',
      type: 'reminder',
      message: 'Alex, please remember to bring your passport.',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      router: router as any,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    expect(send).toHaveBeenCalledWith(
      'api:test-user',
      'Alex, please remember to bring your passport.',
    );
    expect(router.executeWithFallback).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
    expect(db.getRecentProactiveDecisions(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'deliver', outcome: 'sent', reason: 'sent' }),
    ]));
  });

  it('realizes a known generated schedule label instead of leaking it verbatim', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{
            type: 'text',
            text: 'Is there one thing from today worth following up tomorrow?',
          }],
        },
      }),
    };
    const leakedDraft = 'Evening check-in with Alex - recap what happened today, any follow-ups needed';
    const item = db.addScheduledItem({
      userId: 'api:test-user',
      sessionId: null,
      // User initiated the schedule, but a model authored this description.
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: leakedDraft,
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    expect(db.getScheduledItem(item.id)?.messageProvenance).toBe('generated');

    scheduler = new UnifiedScheduler({
      db,
      logger,
      router: router as any,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    expect(router.executeWithFallback).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'api:test-user',
      'Anything from today worth carrying forward?',
    );
    expect(send).not.toHaveBeenCalledWith('api:test-user', leakedDraft);
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
  });

  it('does not require a router for proven literal user text', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      messageProvenance: 'user_literal',
      kind: 'nudge',
      type: 'reminder',
      message: 'Please remember to lock the back door.',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send });
    await scheduler.evaluate();

    expect(send).toHaveBeenCalledWith(
      'default',
      'Please remember to lock the back door.',
    );
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'sent', reason: 'sent' }),
    ]));
  });

  it('keeps an unsafe generated user-source reminder pending without a renderer', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: 'Daily check-in with Alex - ask about priorities and deadlines',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send });
    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('pending');
    expect(db.getScheduledItem(item.id)?.triggerAt).toBeGreaterThan(Date.now());
  });

  it('revokes literal provenance when a board title is replaced without renewed proof', () => {
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      messageProvenance: 'user_literal',
      kind: 'nudge',
      type: 'reminder',
      message: 'Please remember to lock the back door.',
      context: null,
      triggerAt: Date.now() + 60_000,
      recurring: null,
      sourceMemoryId: null,
    });

    db.updateScheduledItemBoard(item.id, {
      message: 'Evening check-in with Alex - recap what happened today, any follow-ups needed',
    });

    expect(db.getScheduledItem(item.id)).toEqual(expect.objectContaining({
      message: 'Evening check-in with Alex - recap what happened today, any follow-ups needed',
      messageProvenance: 'generated',
    }));
  });

  it('migrates a pre-column recurring user-source row as generated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-provenance-'));
    const dbPath = join(dir, 'legacy.sqlite');
    let migrated: ScallopDatabase | undefined;

    try {
      const seed = new ScallopDatabase(dbPath);
      const legacy = seed.addScheduledItem({
        userId: 'default',
        sessionId: null,
        source: 'user',
        kind: 'nudge',
        type: 'reminder',
        message: 'Evening check-in with Alex - recap what happened today, any follow-ups needed',
        context: null,
        triggerAt: Date.now() + 60_000,
        recurring: { type: 'daily', hour: 20, minute: 0 },
        sourceMemoryId: null,
      });
      seed.close();

      // Model an installed public database created before message_provenance.
      const legacySqlite = new Database(dbPath);
      legacySqlite.exec('ALTER TABLE scheduled_items DROP COLUMN message_provenance');
      expect(
        legacySqlite.prepare("SELECT name FROM pragma_table_info('scheduled_items') WHERE name = 'message_provenance'").get(),
      ).toBeUndefined();
      legacySqlite.close();

      migrated = new ScallopDatabase(dbPath);
      expect(migrated.getScheduledItem(legacy.id)).toEqual(expect.objectContaining({
        source: 'user',
        messageProvenance: 'generated',
        recurring: { type: 'daily', hour: 20, minute: 0 },
        status: 'pending',
      }));

      const reopenedSqlite = new Database(dbPath, { readonly: true });
      expect(
        reopenedSqlite.prepare('SELECT message_provenance FROM scheduled_items WHERE id = ?')
          .get(legacy.id),
      ).toEqual({ message_provenance: 'generated' });
      reopenedSqlite.close();
    } finally {
      migrated?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails startup closed when a legacy provenance column is incompatible', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-provenance-invalid-'));
    const dbPath = join(dir, 'legacy.sqlite');

    try {
      new ScallopDatabase(dbPath).close();
      const legacySqlite = new Database(dbPath);
      legacySqlite.exec('ALTER TABLE scheduled_items DROP COLUMN message_provenance');
      legacySqlite.exec("ALTER TABLE scheduled_items ADD COLUMN message_provenance TEXT DEFAULT 'generated'");
      legacySqlite.close();

      expect(() => new ScallopDatabase(dbPath)).toThrow(
        /migrateAddScheduledMessageProvenance failed.*incompatible schema/,
      );

      // The failed constructor releases its SQLite connection.
      const reopened = new Database(dbPath, { readonly: true });
      expect(
        reopened.prepare("SELECT \"notnull\" AS not_null FROM pragma_table_info('scheduled_items') WHERE name = 'message_provenance'")
          .get(),
      ).toEqual({ not_null: 0 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a partially applied required worker migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-worker-migration-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const originalExec = Database.prototype.exec;
    let execSpy: ReturnType<typeof vi.spyOn> | undefined;
    let recovered: ScallopDatabase | undefined;
    let recoveredSqlite: InstanceType<typeof Database> | undefined;

    try {
      new ScallopDatabase(dbPath).close();
      const legacySqlite = new Database(dbPath);
      legacySqlite.exec('DROP INDEX IF EXISTS idx_scheduled_preferred_worker');
      legacySqlite.exec('ALTER TABLE scheduled_items DROP COLUMN worker_id');
      legacySqlite.exec('ALTER TABLE scheduled_items DROP COLUMN preferred_worker_id');
      legacySqlite.close();

      execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (sql: string) {
        if (sql.includes('ADD COLUMN preferred_worker_id')) {
          throw new Error('simulated required migration failure');
        }
        return originalExec.call(this, sql);
      });

      expect(() => new ScallopDatabase(dbPath)).toThrow(
        /migrateAddBoardExecutionColumns failed.*simulated required migration failure/,
      );
      execSpy.mockRestore();
      execSpy = undefined;

      const afterFailure = new Database(dbPath, { readonly: true });
      const columnsAfterFailure = new Set(
        (afterFailure.prepare('PRAGMA table_info(scheduled_items)').all() as Array<{ name: string }>)
          .map(column => column.name),
      );
      expect(columnsAfterFailure.has('worker_id')).toBe(false);
      expect(columnsAfterFailure.has('preferred_worker_id')).toBe(false);
      afterFailure.close();

      // A later clean startup can retry the complete migration successfully.
      recovered = new ScallopDatabase(dbPath);
      recoveredSqlite = new Database(dbPath, { readonly: true });
      const columnsAfterRecovery = new Set(
        (recoveredSqlite.prepare('PRAGMA table_info(scheduled_items)').all() as Array<{ name: string }>)
          .map(column => column.name),
      );
      expect(columnsAfterRecovery.has('worker_id')).toBe(true);
      expect(columnsAfterRecovery.has('preferred_worker_id')).toBe(true);
      recoveredSqlite.close();
      recoveredSqlite = undefined;
      recovered.close();
      recovered = undefined;
    } finally {
      execSpy?.mockRestore();
      recoveredSqlite?.close();
      recovered?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves generated provenance when a recurring reminder creates its successor', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{ type: 'text', text: 'Is there one thing from today worth following up tomorrow?' }],
        },
      }),
    };
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: 'Evening check-in with Alex - recap what happened today, any follow-ups needed',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: { type: 'daily', hour: 20, minute: 0 },
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      router: router as any,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    const successor = db.getScheduledItemsByUser('default')
      .find(candidate => candidate.id !== item.id && candidate.status === 'pending');
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
    expect(successor).toEqual(expect.objectContaining({
      source: 'user',
      messageProvenance: 'generated',
      message: item.message,
      recurring: item.recurring,
    }));
  });

  it('re-realizes generated recurrences against prior wording instead of repeating forever', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn()
        .mockResolvedValueOnce({ response: { content: [{ type: 'text', text: 'Is there one follow-up from today worth carrying into tomorrow?' }] } })
        .mockResolvedValueOnce({ response: { content: [{ type: 'text', text: 'Which unfinished item, if any, should stay on tomorrow’s list?' }] } }),
    };
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'nudge', type: 'reminder',
      message: 'Evening check-in with Alex - recap today and identify follow-ups',
      context: null, triggerAt: Date.now() - 1, recurring: { type: 'daily', hour: 20, minute: 0 },
      sourceMemoryId: null,
    });
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send, getTimezone: () => middayTimezone(),
    });

    await scheduler.evaluate();
    const successor = db.getScheduledItemsByUser('default')
      .find(candidate => candidate.id !== item.id && candidate.status === 'pending')!;
    db.updateScheduledItem(successor.id, { triggerAt: Date.now() - 1 });
    await scheduler.evaluate();

    expect(send.mock.calls.map(call => call[1])).toEqual([
      'Anything from today worth carrying forward?',
      'What from today do you want to pick up tomorrow?',
    ]);
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('retries an unsafe agent draft instead of marking it delivered', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'It would be helpful to check whether they completed the task.',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('pending');
    expect(db.getScheduledItem(item.id)?.triggerAt).toBeGreaterThan(Date.now());
  });

  it('expires an unrenderable nudge after its bounded retry budget', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'It would be helpful to check whether they completed the task.', context: null,
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null, maxAttempts: 3,
    });
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, getTimezone: () => middayTimezone() });

    for (let attempt = 0; attempt < 3; attempt++) {
      db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
      await scheduler.evaluate();
    }

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)).toEqual(expect.objectContaining({
      status: 'expired', attemptCount: 3,
    }));
  });

  it('never sends a raw task title when the task executor is unavailable', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'agent',
      kind: 'task',
      type: 'event_prep',
      message: 'Gather the private analytics report and decide what to tell the user',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
      taskConfig: { goal: 'Gather the analytics report', tools: ['analytics'] },
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
    expect(db.getScheduledItem(item.id)?.result?.response).toContain('no sub-agent executor');
  });

  it('delivers a stored task result without rerunning an unavailable executor', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'agent',
      kind: 'task',
      type: 'event_prep',
      message: 'Collect the analytics report',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
      taskConfig: { goal: 'Collect the analytics report', tools: ['analytics'] },
    });
    db.updateScheduledItemResult(item.id, {
      response: 'The report is ready: sign-ups increased by 12% this week.',
      completedAt: Date.now() - 2_000,
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });
    await scheduler.evaluate();

    expect(send).toHaveBeenCalledWith('default', 'The report is ready: sign-ups increased by 12% this week.');
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
  });

  it('does not count a task result or its aliases against the inferred daily nudge cap', async () => {
    const now = Date.now();
    db.recordProactiveSend('default', 'Earlier inferred update one.', 'agent', now - 120_000);
    db.recordProactiveSend('default', 'Earlier inferred update two.', 'agent', now - 60_000);
    const task = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'task', type: 'event_prep',
      message: 'Collect the weekly analytics', context: null, triggerAt: now - 1,
      recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Collect the weekly analytics from real data', tools: ['analytics'] },
    });
    db.updateScheduledItemResult(task.id, {
      response: 'The weekly analytics are ready: sign-ups increased by 12%.',
      completedAt: now - 1_000,
    });
    const nudge = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Did the product review go ahead?', context: 'Product review planned for today.',
      triggerAt: now - 1, recurring: null, sourceMemoryId: null,
    });
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Was the product review able to go ahead today?' }] },
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(send).toHaveBeenCalledTimes(2);
    expect(db.getScheduledItem(task.id)?.status).toBe('fired');
    expect(db.getScheduledItem(nudge.id)?.status).toBe('fired');
    const sends = db.getRecentProactiveSends(0);
    expect(sends.filter(entry => entry.source === 'agent')).toHaveLength(3);
    expect(sends).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'task_result' }),
    ]));
  });

  it('delivers a completed task result without waiting behind the inferred nudge gap', async () => {
    const now = Date.now();
    db.recordProactiveSend('default', 'An inferred update sent a minute ago.', 'agent', now - 60_000);
    const task = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'task', type: 'event_prep',
      message: 'Collect the release status', context: null, triggerAt: now - 1,
      recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Collect the release status', tools: ['releases'] },
    });
    db.updateScheduledItemResult(task.id, {
      response: 'Release 1.4 is live and the health checks passed.',
      completedAt: now - 1_000,
    });
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
    });

    await scheduler.evaluate();

    expect(send).toHaveBeenCalledWith('default', 'Release 1.4 is live and the health checks passed.');
    expect(db.getScheduledItem(task.id)?.status).toBe('fired');
  });

  it('retries a failed delivery instead of recording or firing it', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      messageProvenance: 'user_literal',
      kind: 'nudge',
      type: 'reminder',
      message: 'Quick reminder to submit the report.',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send });
    await scheduler.evaluate();

    const stored = db.getScheduledItem(item.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.triggerAt).toBeGreaterThan(Date.now());
    expect(db.getRecentProactiveSends(0)).toHaveLength(0);
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'failed', reason: 'delivery_failed' }),
    ]));
  });

  it('keeps retrying explicit reminder delivery beyond the generated nudge budget', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', messageProvenance: 'user_literal',
      kind: 'nudge', type: 'reminder', message: 'Submit the report now.', context: null,
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null, maxAttempts: 3,
    });
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, taskRetryDelayMs: 1_000 });

    for (let attempt = 0; attempt < 4; attempt++) {
      db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
      await scheduler.evaluate();
    }
    expect(db.getScheduledItem(item.id)).toEqual(expect.objectContaining({
      status: 'pending', attemptCount: 4, maxAttempts: 3,
    }));

    db.updateScheduledItem(item.id, { triggerAt: Date.now() - 1 });
    await scheduler.evaluate();

    expect(send).toHaveBeenCalledTimes(5);
    expect(db.getScheduledItem(item.id)?.status).toBe('fired');
  });

  it('keeps a min-gap deferred item pending instead of immediately marking it fired', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Hey, how is the project going?',
      context: null,
      triggerAt: Date.now() - 1_000,
      recurring: null,
      sourceMemoryId: null,
    });

    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      getTimezone: () => middayTimezone(),
      minAgentProactiveGapMs: 60 * 60 * 1000,
    });
    (scheduler as any).recentSends.set('default', [
      { message: 'A recent proactive message', time: Date.now(), source: 'agent' },
    ]);

    await scheduler.evaluate();

    const stored = db.getScheduledItem(item.id);
    expect(send).not.toHaveBeenCalled();
    expect(stored?.status).toBe('pending');
    expect(stored?.triggerAt).toBeGreaterThan(Date.now());
  });

  it('defers only for the remaining min-gap instead of restarting the full gap', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-11T08:00:00Z'));
      const send = vi.fn().mockResolvedValue(true);
      const router = {
        executeWithFallback: vi.fn()
          .mockResolvedValueOnce({
            response: { content: [{ type: 'text', text: 'The first grounded update is ready.' }] },
          }),
      };
      scheduler = new UnifiedScheduler({
        db, logger, router: router as any, onSendMessage: send, getTimezone: () => 'UTC',
        minAgentProactiveGapMs: 6 * 60 * 60 * 1000,
      });
      db.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'The first grounded update is ready.', context: null,
        triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      await scheduler.evaluate();

      vi.setSystemTime(new Date('2026-07-11T13:00:00Z'));
      const second = db.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'The second grounded update is ready.', context: null,
        triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      await scheduler.evaluate();

      expect(db.getScheduledItem(second.id)).toEqual(expect.objectContaining({
        status: 'pending', triggerAt: Date.parse('2026-07-11T14:00:00Z'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('evaluates quiet hours per user in a mixed-user batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    try {
      const send = vi.fn().mockResolvedValue(true);
      const quietItem = db.addScheduledItem({
        userId: 'quiet-user',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Hey, how is your morning going?',
        context: null,
        triggerAt: Date.now() - 1_000,
        recurring: null,
        sourceMemoryId: null,
      });
      const awakeItem = db.addScheduledItem({
        userId: 'awake-user',
        sessionId: null,
        source: 'agent',
        kind: 'nudge',
        type: 'follow_up',
        message: 'Hey, how is your day going?',
        context: null,
        triggerAt: Date.now() - 1_000,
        recurring: null,
        sourceMemoryId: null,
      });

      scheduler = new UnifiedScheduler({
        db,
        logger,
        router: {
          executeWithFallback: vi.fn().mockResolvedValue({
            response: { content: [{ type: 'text', text: 'Your afternoon plan is ready. What needs attention first?' }] },
          }),
        } as any,
        onSendMessage: send,
        minAgentProactiveGapMs: 0,
        getTimezone: userId => userId === 'quiet-user' ? 'Pacific/Honolulu' : 'UTC',
      });
      await scheduler.evaluate();

      expect(send).toHaveBeenCalledWith(
        'awake-user',
        'Your afternoon plan is ready. What needs attention first?',
      );
      expect(send).not.toHaveBeenCalledWith('quiet-user', expect.any(String));
      expect(db.getScheduledItem(quietItem.id)?.status).toBe('pending');
      expect(db.getScheduledItem(awakeItem.id)?.status).toBe('fired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a natural completed-work digest and marks results only after delivery', async () => {
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'task', type: 'event_prep',
      message: 'INTERNAL TASK: verify release deployment', context: null,
      triggerAt: Date.now() - 10_000, recurring: null, sourceMemoryId: null,
      taskConfig: { goal: 'Verify release deployment' },
    });
    db.markScheduledItemFired(item.id);
    db.updateScheduledItemResult(item.id, {
      response: 'Release 1.4 is live and all health checks passed.',
      completedAt: Date.now() - 5_000,
    });
    const send = vi.fn().mockResolvedValue(false);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Release 1.4 is live, and all health checks passed.' }] },
      }),
    };
    scheduler = new UnifiedScheduler({ db, logger, router: router as any, onSendMessage: send });

    await expect(scheduler.sendMorningDigest('default')).resolves.toBe(0);
    expect(db.getScheduledItem(item.id)?.result?.notifiedAt).toBeUndefined();

    send.mockResolvedValue(true);
    await expect(scheduler.sendMorningDigest('default')).resolves.toBe(1);
    expect(send).toHaveBeenLastCalledWith(
      'default',
      'Release 1.4 is live, and all health checks passed.',
    );
    expect(db.getScheduledItem(item.id)?.result?.notifiedAt).toBeTypeOf('number');
    expect(send.mock.calls.flat().join(' ')).not.toContain('INTERNAL TASK');
  });
});
