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

  it('rewrites a generated source=user schedule description instead of leaking it verbatim', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{
            type: 'text',
            text: 'Hey Alex, how did today go? Is there anything you would like to follow up on?',
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

    expect(router.executeWithFallback).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      'api:test-user',
      'Hey Alex, how did today go? Is there anything you would like to follow up on?',
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

  it('preserves generated provenance when a recurring reminder creates its successor', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{ type: 'text', text: 'Hey Alex, how did today go? Any follow-ups for tomorrow?' }],
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

  it('retries a failed delivery instead of recording or firing it', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const item = db.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
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
        onSendMessage: send,
        minAgentProactiveGapMs: 0,
        getTimezone: userId => userId === 'quiet-user' ? 'Pacific/Honolulu' : 'UTC',
      });
      await scheduler.evaluate();

      expect(send).toHaveBeenCalledWith('awake-user', 'Hey, how is your day going?');
      expect(send).not.toHaveBeenCalledWith('quiet-user', expect.any(String));
      expect(db.getScheduledItem(quietItem.id)?.status).toBe('pending');
      expect(db.getScheduledItem(awakeItem.id)?.status).toBe('fired');
    } finally {
      vi.useRealTimers();
    }
  });
});
