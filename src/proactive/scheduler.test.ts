import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScallopDatabase } from '../memory/db.js';
import { SessionManager } from '../agent/session.js';
import { UnifiedScheduler } from './scheduler.js';
import { getTodayStartMs } from './proactive-utils.js';
import { OutboundQueue } from './outbound-queue.js';
import {
  buildEvidenceClaimLedger,
  buildEvidenceExecutionContext,
  digestEvidenceProvenance,
} from '../security/evidence-grounding.js';

const logger = pino({ level: 'silent' });

function authoritativeReceipt(toolName: string, output: string, taskRequest: string, digest: string) {
  return {
    toolName,
    success: true,
    completedAt: Date.now() - 2_000,
    outputDigest: digest.repeat(64),
    outputBytes: Math.max(1, Buffer.byteLength(output)),
    ...buildEvidenceClaimLedger(output),
    authority: 'authoritative' as const,
    sourceDigest: digestEvidenceProvenance('test-source', toolName),
    toolRequestDigest: digestEvidenceProvenance('test-request', toolName),
    ...buildEvidenceExecutionContext(taskRequest, 'default'),
  };
}

function middayTimezone(): string {
  const offset = 12 - new Date().getUTCHours();
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
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

  it('recovers a stale processing nudge after restart without reclaiming it early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-nudge-recovery-'));
    const dbPath = join(dir, 'memories.sqlite');
    let claimedDb: ScallopDatabase | null = null;
    let reopenedDb: ScallopDatabase | null = null;
    let earlyScheduler: UnifiedScheduler | null = null;
    let recoveryScheduler: UnifiedScheduler | null = null;
    const send = vi.fn().mockResolvedValue(true);

    try {
      claimedDb = new ScallopDatabase(dbPath);
      const reminder = claimedDb.addScheduledItem({
        userId: 'default', sessionId: null, source: 'user', messageProvenance: 'user_literal',
        kind: 'nudge', type: 'reminder', message: 'Bring the Atlas follow-up notes.',
        context: null, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
      });
      expect(claimedDb.claimDueScheduledItems(Date.now(), 'nudge')).toEqual([
        expect.objectContaining({ id: reminder.id, status: 'processing', boardStatus: 'in_progress' }),
      ]);

      earlyScheduler = new UnifiedScheduler({
        db: claimedDb,
        logger,
        onSendMessage: send,
        getTimezone: () => 'UTC',
        nudgeClaimTimeoutMs: 60_000,
      });
      await earlyScheduler.evaluate();

      expect(send).not.toHaveBeenCalled();
      expect(claimedDb.getScheduledItem(reminder.id)).toMatchObject({
        status: 'processing',
        boardStatus: 'in_progress',
      });

      earlyScheduler.stop();
      earlyScheduler = null;
      claimedDb.close();
      claimedDb = null;

      const raw = new Database(dbPath);
      raw.prepare('UPDATE scheduled_items SET updated_at = ? WHERE id = ?')
        .run(Date.now() - 2 * 60_000, reminder.id);
      raw.close();

      reopenedDb = new ScallopDatabase(dbPath);
      recoveryScheduler = new UnifiedScheduler({
        db: reopenedDb,
        logger,
        onSendMessage: send,
        getTimezone: () => 'UTC',
        nudgeClaimTimeoutMs: 60_000,
      });
      await recoveryScheduler.evaluate();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith('default', 'Bring the Atlas follow-up notes.');
      expect(reopenedDb.getScheduledItem(reminder.id)).toMatchObject({
        status: 'fired',
        boardStatus: 'done',
        lastError: 'Recovered stale scheduler nudge claim',
      });
    } finally {
      earlyScheduler?.stop();
      recoveryScheduler?.stop();
      claimedDb?.close();
      reopenedDb?.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('revalidates the Atlas source item and suppresses its stale wrapper after completion', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
      const atlas = db.addScheduledItem({
        userId: 'default', sessionId: null, source: 'user', kind: 'task',
        type: 'reminder', message: 'Publish Atlas launch update', context: null,
        triggerAt: Date.now() + 7 * 24 * 60 * 60 * 1000, recurring: null,
        sourceMemoryId: null, boardStatus: 'in_progress', status: 'processing',
      });
      const wrapper = db.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
        type: 'follow_up', message: 'Do you still want to publish the Atlas launch update?',
        context: JSON.stringify({ gapType: 'stale_board_item', sourceId: atlas.id }),
        sourceItemId: atlas.id, triggerAt: Date.now() + 5 * 60_000, recurring: null,
        sourceMemoryId: null,
      });
      vi.setSystemTime(new Date('2026-07-11T12:01:00Z'));
      db.updateScheduledItemBoard(atlas.id, { boardStatus: 'done', status: 'fired' });
      vi.setSystemTime(new Date('2026-07-11T12:06:00Z'));
      const send = vi.fn().mockResolvedValue(true);
      scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send, getTimezone: () => 'UTC' });

      await scheduler.evaluate();

      expect(send).not.toHaveBeenCalled();
      expect(db.getScheduledItem(wrapper.id)?.status).toBe('expired');
      expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'source_item_resolved' }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('revalidates the linked source after a pending render before transport', async () => {
    const atlas = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() + 7 * 24 * 60 * 60 * 1000, recurring: null,
      sourceMemoryId: null, boardStatus: 'waiting',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Ask the user whether the Atlas launch task should stay open',
      context: JSON.stringify({ gapType: 'stale_board_item', sourceId: atlas.id }),
      sourceItemId: atlas.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });

    let rendererEntered!: () => void;
    const entered = new Promise<void>(resolve => { rendererEntered = resolve; });
    let finishRender!: (value: unknown) => void;
    const pendingRender = new Promise(resolve => { finishRender = resolve; });
    const router = {
      executeWithFallback: vi.fn().mockImplementation(() => {
        rendererEntered();
        return pendingRender;
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    const evaluation = scheduler.evaluate();
    await entered;
    db.updateScheduledItemBoard(atlas.id, { boardStatus: 'done', status: 'fired' });
    finishRender({
      response: { content: [{ type: 'text', text: 'Should we keep the Atlas launch task open?' }] },
    });
    await evaluation;

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('expired');
    expect(db.getRecentProactiveDecisions(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'deliver', outcome: 'suppressed', reason: 'source_item_resolved',
        detail: expect.objectContaining({ phase: 'post_render' }),
      }),
    ]));
  });

  it.each([
    ['Archive', 'archived', 'dismissed'],
    ['Done', 'done', 'fired'],
    ['Snooze', 'scheduled', 'pending'],
  ] as const)('routes a direct %s reply through the Atlas wrapper to its source task', (reply, boardStatus, status) => {
    const atlas = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() + 7 * 24 * 60 * 60 * 1000, recurring: null,
      sourceMemoryId: null, boardStatus: 'in_progress', status: 'processing',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Do you still want to keep the Atlas launch task open?',
      context: JSON.stringify({ gapType: 'stale_board_item', sourceId: atlas.id }),
      sourceItemId: atlas.id, triggerAt: Date.now() - 1, recurring: null,
      sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['101'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', reply, {
      directReply: true,
      repliedToText: wrapper.message,
      repliedToMessageId: '101',
    });

    expect(feedback).toEqual(expect.objectContaining({
      matched: true,
      sourceAction: expect.objectContaining({
        action: reply.toLowerCase(), title: 'Publish Atlas launch update', applied: true,
      }),
    }));
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
    expect(db.getScheduledItem(atlas.id)).toEqual(expect.objectContaining({ boardStatus, status }));
    if (reply === 'Snooze') {
      expect(db.getScheduledItem(atlas.id)!.triggerAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    }
  });

  it('uses the exact first delivery ID when two recent wrappers have similar text', () => {
    const firstSource = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the first Project Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const secondSource = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the second Project Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const firstWrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the Project Atlas launch update stay open?', context: null,
      sourceItemId: firstSource.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const secondWrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the Project Atlas launch update stay open?', context: null,
      sourceItemId: secondSource.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(firstWrapper.id);
    db.markScheduledItemFired(secondWrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['201'], scheduledItemId: firstWrapper.id,
      ownerUserId: 'default',
    });
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['202'], scheduledItemId: secondWrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true,
      repliedToText: firstWrapper.message,
      repliedToMessageId: '201',
    });

    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: firstSource.message, applied: true,
    });
    expect(db.getScheduledItem(firstSource.id)).toEqual(expect.objectContaining({
      boardStatus: 'archived', status: 'dismissed',
    }));
    expect(db.getScheduledItem(secondSource.id)).toEqual(expect.objectContaining({
      boardStatus: 'waiting', status: 'pending',
    }));
    expect(db.getScheduledItem(firstWrapper.id)?.status).toBe('acted');
    expect(db.getScheduledItem(secondWrapper.id)?.status).toBe('fired');
  });

  it('treats an exact action with no persisted delivery mapping as engagement only', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the Project Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the Project Atlas launch update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true,
      repliedToText: wrapper.message,
      repliedToMessageId: 'unmapped-203',
    });

    expect(feedback).toEqual({ matched: true });
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
    expect(db.getScheduledItem(source.id)).toEqual(expect.objectContaining({
      boardStatus: 'waiting', status: 'pending',
    }));
  });

  it('rejects an exact delivery mapping owned by another user', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the Project Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the Project Atlas launch update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['204'], scheduledItemId: wrapper.id,
      ownerUserId: 'another-user',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '204',
    });

    expect(feedback).toEqual({ matched: true });
    expect(db.getScheduledItem(source.id)).toEqual(expect.objectContaining({
      boardStatus: 'waiting', status: 'pending',
    }));
  });

  it('rejects a combined delivery ID as ambiguous source-action authority', () => {
    const sources = [1, 2].map(index => db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user' as const, kind: 'task' as const,
      type: 'reminder' as const, message: `Publish Project Atlas update ${index}`, context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting' as const, status: 'pending' as const,
    }));
    const wrappers = sources.map(source => db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent' as const, kind: 'nudge' as const,
      type: 'follow_up' as const, message: 'Should the Project Atlas update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    }));
    for (const wrapper of wrappers) {
      db.markScheduledItemFired(wrapper.id);
      db.recordProactiveDeliveryReceipt({
        channel: 'telegram', channelMessageIds: ['205'], scheduledItemId: wrapper.id,
        ownerUserId: 'default', ambiguous: true,
      });
    }
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: wrappers[0].message, repliedToMessageId: '205',
    });

    expect(feedback).toEqual({ matched: true });
    for (const source of sources) {
      expect(db.getScheduledItem(source.id)).toEqual(expect.objectContaining({
        boardStatus: 'waiting', status: 'pending',
      }));
    }
  });

  it('honors an exact persisted reply after the fuzzy engagement window', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the delayed Project Atlas update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the delayed Project Atlas update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    const rawDb = (db as unknown as { db: Database.Database }).db;
    rawDb.prepare('UPDATE scheduled_items SET fired_at = ? WHERE id = ?')
      .run(Date.now() - 7 * 24 * 60 * 60 * 1000, wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['206'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '206',
    });

    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: source.message, applied: true,
    });
  });

  it('allows an exact Archive after an earlier acknowledgement marked the wrapper acted', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the acknowledged Project Atlas update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the acknowledged Project Atlas update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['207'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    scheduler.checkEngagement('telegram:42', 'Thanks!', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '207',
    });
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '207',
    });
    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: source.message, applied: true,
    });
  });

  it('accepts an exact receipt before the scheduler flips a delivered wrapper from processing to fired', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the fast-reply Project Atlas update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the fast-reply Project Atlas update stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.updateScheduledItemBoard(wrapper.id, { status: 'processing', boardStatus: 'in_progress' });
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['208'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '208',
    });

    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: source.message, applied: true,
    });
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
    expect(db.markScheduledItemFired(wrapper.id)).toBe(false);
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
  });

  it('persists every channel receipt chunk returned by the delivery handler', async () => {
    const reminder = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', messageProvenance: 'user_literal',
      kind: 'nudge', type: 'reminder', message: 'Review the Project Atlas launch notes.',
      context: null, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const send = vi.fn().mockResolvedValue({
      sent: true,
      channel: 'telegram',
      messageIds: ['301', '302'],
    });
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: send });

    await scheduler.evaluate();

    expect(db.getScheduledItem(reminder.id)?.status).toBe('fired');
    for (const messageId of ['301', '302']) {
      expect(db.getProactiveDeliveryReceipts('telegram', messageId)).toEqual([
        expect.objectContaining({
          scheduledItemId: reminder.id,
          ownerUserId: 'default',
          ambiguous: false,
        }),
      ]);
    }
  });

  it('expires a source-invalidated wrapper while combine is pending and never transports its stale text', async () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Publish the queued Project Atlas update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Ask whether the queued Project Atlas update should stay open', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const combineEntered = deferred<void>();
    const combineResult = deferred<any>();
    const rawTransport = vi.fn().mockResolvedValue(true);
    const outboundQueue = new OutboundQueue({
      sendMessage: rawTransport,
      logger,
      router: {
        executeWithFallback: vi.fn().mockImplementation(() => {
          combineEntered.resolve();
          return combineResult.promise;
        }),
      } as any,
    });
    outboundQueue.enqueue('default', 'Safe Project Atlas planning note');
    const renderRouter = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [{ type: 'text', text: 'Should the queued Project Atlas update stay open?' }],
        },
      }),
    };
    scheduler = new UnifiedScheduler({
      db,
      logger,
      router: renderRouter as any,
      onSendMessage: outboundQueue.createHandler(),
      getTimezone: () => middayTimezone(),
      minAgentProactiveGapMs: 0,
    });

    try {
      const evaluation = scheduler.evaluate();
      await combineEntered.promise;
      db.updateScheduledItemBoard(source.id, { status: 'dismissed', boardStatus: 'archived' });
      combineResult.resolve({
        response: {
          content: [{ type: 'text', text: 'Unsafe combined Project Atlas text with a stale follow-up' }],
        },
      });
      await evaluation;
      await vi.waitFor(() => expect(rawTransport).toHaveBeenCalledTimes(1));

      expect(rawTransport).toHaveBeenCalledWith('default', 'Safe Project Atlas planning note');
      expect(rawTransport).not.toHaveBeenCalledWith(
        'default',
        expect.stringContaining('stale follow-up'),
      );
      expect(db.getScheduledItem(wrapper.id)?.status).toBe('expired');
      expect(db.getRecentProactiveDecisions(10)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: 'deliver', outcome: 'suppressed', reason: 'source_item_resolved',
          detail: expect.objectContaining({ itemId: wrapper.id, phase: 'pre_transport' }),
        }),
      ]));
    } finally {
      outboundQueue.stop();
    }
  });

  it('routes Archive through the exact rendered Atlas message, not the internal draft', async () => {
    const atlas = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() + 7 * 24 * 60 * 60 * 1000, recurring: null,
      sourceMemoryId: null, boardStatus: 'waiting',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Ask the user whether the Atlas launch task should stay open',
      context: JSON.stringify({ gapType: 'stale_board_item', sourceId: atlas.id }),
      sourceItemId: atlas.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const delivered = 'Should we keep the Atlas launch task open, or archive it?';
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: delivered }] },
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();
    expect(send).toHaveBeenCalledWith('default', delivered);
    expect(db.getScheduledItem(wrapper.id)?.message).toBe(delivered);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['102'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });

    scheduler.stop();
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: send, canonicalSingleUserIds: ['telegram:42'],
    });
    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true, repliedToText: delivered, repliedToMessageId: '102',
    });
    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: 'Publish Atlas launch update', applied: true,
    });
    expect(db.getScheduledItem(atlas.id)).toEqual(expect.objectContaining({
      boardStatus: 'archived', status: 'dismissed',
    }));
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
  });

  it('uses legacy context provenance for Archive but never crosses source ownership', () => {
    const legacySource = db.addScheduledItem({
      userId: 'other-user', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'waiting', status: 'pending',
    });
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Should the Atlas launch task stay open?',
      context: JSON.stringify({ gapType: 'stale_board_item', sourceId: legacySource.id }),
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    scheduler = new UnifiedScheduler({ db, logger, onSendMessage: vi.fn().mockResolvedValue(true) });

    scheduler.checkEngagement('default', 'Archive', {
      directReply: true,
      repliedToText: wrapper.message,
    });

    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
    expect(db.getScheduledItem(legacySource.id)).toEqual(expect.objectContaining({
      boardStatus: 'waiting', status: 'pending',
    }));
  });

  it('treats Archive on a legacy expired source as idempotent without rewriting history', () => {
    const legacySource = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() + 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'in_progress', status: 'processing',
    });
    const rawDb = (db as unknown as { db: Database.Database }).db;
    rawDb.exec('DROP TRIGGER IF EXISTS trg_scheduled_items_state_guard_update');
    rawDb.prepare("UPDATE scheduled_items SET status = 'expired', board_status = 'in_progress' WHERE id = ?")
      .run(legacySource.id);
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Should the Atlas launch task stay open?',
      context: JSON.stringify({ gapType: 'stale_board_item', sourceId: legacySource.id }),
      triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['103'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Archive', {
      directReply: true,
      repliedToText: wrapper.message,
      repliedToMessageId: '103',
    });

    expect(feedback.sourceAction).toEqual({
      action: 'archive', title: 'Publish Atlas launch update', applied: true,
    });
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
    expect(db.getScheduledItem(legacySource.id)).toEqual(expect.objectContaining({
      boardStatus: 'in_progress', status: 'expired',
    }));
  });

  it('confirms an idempotent Done reply without rewriting an already-done source', () => {
    const source = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task',
      type: 'reminder', message: 'Publish Atlas launch update', context: null,
      triggerAt: Date.now() - 60_000, recurring: null, sourceMemoryId: null,
      boardStatus: 'done', status: 'fired',
    });
    const before = db.getScheduledItem(source.id)!;
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Should the Atlas launch task stay open?', context: null,
      sourceItemId: source.id, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    db.markScheduledItemFired(wrapper.id);
    db.recordProactiveDeliveryReceipt({
      channel: 'telegram', channelMessageIds: ['104'], scheduledItemId: wrapper.id,
      ownerUserId: 'default',
    });
    scheduler = new UnifiedScheduler({
      db, logger, onSendMessage: vi.fn().mockResolvedValue(true),
      canonicalSingleUserIds: ['telegram:42'],
    });

    const feedback = scheduler.checkEngagement('telegram:42', 'Done', {
      directReply: true, repliedToText: wrapper.message, repliedToMessageId: '104',
    });

    expect(feedback.sourceAction).toEqual({
      action: 'done', title: 'Publish Atlas launch update', applied: true,
    });
    expect(db.getScheduledItem(source.id)).toEqual(before);
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('acted');
  });

  it('records a sessionless default wrapper in the explicitly configured Telegram owner session', async () => {
    db.createSession('telegram-owner-session', { userId: 'telegram:42', channelId: 'telegram' });
    const sessionManager = new SessionManager(db);
    const wrapper = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge',
      type: 'follow_up', message: 'Check whether the Atlas launch task should stay open.',
      context: null, triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
    });
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Should we keep the Atlas launch task open?' }] },
      }),
    };
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db, logger, sessionManager, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), canonicalSingleUserIds: ['42', 'telegram:42'],
      minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(db.getScheduledItem(wrapper.id)?.status).toBe('fired');
    expect(db.getSessionMessages('telegram-owner-session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Should we keep the Atlas launch task open?' }),
    ]));
  });

  it('never reads from or records delivery into a cross-owner source session', async () => {
    db.createSession('foreign-source-session', {
      userId: 'telegram:owner-beta', channelId: 'telegram',
    });
    db.addSessionMessage(
      'foreign-source-session',
      'user',
      'The Project Atlas follow-up is resolved and should be cancelled.',
    );
    const beforeForeign = db.getSessionMessages('foreign-source-session');
    const wrapper = db.addScheduledItem({
      userId: 'telegram:owner-alpha',
      sessionId: 'foreign-source-session',
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Would you like to review the synthetic launch notes?',
      context: null,
      triggerAt: Date.now() - 1,
      recurring: null,
      sourceMemoryId: null,
    });
    const send = vi.fn().mockResolvedValue(true);
    scheduler = new UnifiedScheduler({
      db,
      logger,
      onSendMessage: send,
      router: {
        executeWithFallback: vi.fn().mockResolvedValue({
          response: { content: [{ type: 'text', text: 'Would you like to review the synthetic launch notes?' }] },
        }),
      } as any,
      getTimezone: () => middayTimezone(),
      minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(send).toHaveBeenCalledTimes(1);
    expect(db.getScheduledItem(wrapper.id)?.status).toBe('fired');
    expect(db.getSessionMessages('foreign-source-session')).toEqual(beforeForeign);
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
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Did the prototype review happen?' }] },
      }),
    };
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send, getTimezone: () => middayTimezone(),
    });

    await scheduler.evaluate();

    expect(send).not.toHaveBeenCalled();
    expect(db.getScheduledItem(item.id)?.status).toBe('pending');
    expect(db.getRecentProactiveDecisions(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'daily_delivery_budget' }),
    ]));
  });

  it.each([
    { gate: 'min-gap', minGapMs: 6 * 60 * 60 * 1000, prefilledSends: 0 },
    { gate: 'daily budget', minGapMs: 0, prefilledSends: 2 },
  ])('reserves $gate capacity across two simultaneous scheduler connections', async ({ minGapMs, prefilledSends }) => {
    const dir = mkdtempSync(join(tmpdir(), 'proactive-reservation-race-'));
    const dbPath = join(dir, 'memories.sqlite');
    const firstDb = new ScallopDatabase(dbPath);
    const secondDb = new ScallopDatabase(dbPath);
    let firstScheduler: UnifiedScheduler | null = null;
    let secondScheduler: UnifiedScheduler | null = null;
    let releaseTransport!: (sent: boolean) => void;
    const transport = new Promise<boolean>(resolve => { releaseTransport = resolve; });
    const send = vi.fn().mockReturnValue(transport);

    try {
      const now = Date.now();
      for (let index = 0; index < prefilledSends; index++) {
        firstDb.recordProactiveSend('default', `Earlier delivery ${index}`, 'agent', now - index * 60_000);
      }
      const firstItem = firstDb.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'Prepare an Atlas deployment follow-up', context: null,
        triggerAt: now - 1, recurring: null, sourceMemoryId: null,
      });
      const secondItem = firstDb.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'goal_checkin',
        message: 'Prepare a quarterly planning follow-up', context: null,
        triggerAt: now - 1, recurring: null, sourceMemoryId: null,
      });
      firstDb.updateScheduledItemBoard(firstItem.id, { status: 'processing', boardStatus: 'in_progress' });
      firstDb.updateScheduledItemBoard(secondItem.id, { status: 'processing', boardStatus: 'in_progress' });
      const router = (text: string) => ({
        executeWithFallback: vi.fn().mockResolvedValue({
          response: { content: [{ type: 'text', text }] },
        }),
      });
      firstScheduler = new UnifiedScheduler({
        db: firstDb, logger, router: router('Is the Atlas deployment ready for review?') as any,
        onSendMessage: send, getTimezone: () => 'UTC', minAgentProactiveGapMs: minGapMs,
      });
      secondScheduler = new UnifiedScheduler({
        db: secondDb, logger, router: router('Is quarterly planning ready to continue?') as any,
        onSendMessage: send, getTimezone: () => 'UTC', minAgentProactiveGapMs: minGapMs,
      });
      const sendFormatted = (instance: UnifiedScheduler, item: NonNullable<ReturnType<ScallopDatabase['getScheduledItem']>>) => (
        instance as unknown as {
          sendFormattedMessage: (scheduled: typeof item, message: string) => Promise<string>;
        }
      ).sendFormattedMessage(item, item.message);

      const firstAttempt = sendFormatted(firstScheduler, firstDb.getScheduledItem(firstItem.id)!);
      const secondAttempt = sendFormatted(secondScheduler, secondDb.getScheduledItem(secondItem.id)!);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      releaseTransport(true);
      const outcomes = await Promise.all([firstAttempt, secondAttempt]);

      expect(outcomes.sort()).toEqual(['deferred', 'sent']);
      expect(send).toHaveBeenCalledTimes(1);
      expect(secondDb.getRecentProactiveSends(getTodayStartMs('UTC'))
        .filter(entry => entry.source === 'agent')).toHaveLength(prefilledSends + 1);
    } finally {
      firstScheduler?.stop();
      secondScheduler?.stop();
      firstDb.close();
      secondDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases a delivery reservation after transport failure', async () => {
    const now = Date.now();
    const failedItem = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Prepare the first Atlas follow-up', context: null,
      triggerAt: now - 1, recurring: null, sourceMemoryId: null,
    });
    const retryItem = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'goal_checkin',
      message: 'Prepare the replacement planning follow-up', context: null,
      triggerAt: now - 1, recurring: null, sourceMemoryId: null,
    });
    db.updateScheduledItemBoard(failedItem.id, { status: 'processing', boardStatus: 'in_progress' });
    db.updateScheduledItemBoard(retryItem.id, { status: 'processing', boardStatus: 'in_progress' });
    const router = (text: string) => ({
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text }] },
      }),
    });
    const failedScheduler = new UnifiedScheduler({
      db, logger, router: router('Is the first Atlas follow-up ready?') as any,
      onSendMessage: vi.fn().mockResolvedValue(false), getTimezone: () => 'UTC',
      minAgentProactiveGapMs: 6 * 60 * 60 * 1000,
    });
    const successfulSend = vi.fn().mockResolvedValue(true);
    const retryScheduler = new UnifiedScheduler({
      db, logger, router: router('Is the replacement planning follow-up ready?') as any,
      onSendMessage: successfulSend, getTimezone: () => 'UTC',
      minAgentProactiveGapMs: 6 * 60 * 60 * 1000,
    });
    const call = (instance: UnifiedScheduler, itemId: string) => {
      const item = db.getScheduledItem(itemId)!;
      return (instance as unknown as {
        sendFormattedMessage: (scheduled: typeof item, message: string) => Promise<string>;
      }).sendFormattedMessage(item, item.message);
    };

    try {
      expect(await call(failedScheduler, failedItem.id)).toBe('delivery_failed');
      expect(await call(retryScheduler, retryItem.id)).toBe('sent');
      expect(successfulSend).toHaveBeenCalledTimes(1);
    } finally {
      failedScheduler.stop();
      retryScheduler.stop();
    }
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
    expect(db.getScheduledItem(item.id)?.message).toBe('Anything from today worth carrying forward?');
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

  it('adds and losslessly backfills source_item_id on an existing legacy schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduled-source-item-'));
    const dbPath = join(dir, 'legacy.sqlite');
    let migrated: ScallopDatabase | undefined;
    try {
      const seed = new ScallopDatabase(dbPath);
      const source = seed.addScheduledItem({
        userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
        message: 'Publish Atlas', context: null, triggerAt: Date.now() + 60_000,
        recurring: null, sourceMemoryId: null, boardStatus: 'waiting',
      });
      const wrapper = seed.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'Should the Atlas task stay open?',
        context: JSON.stringify({ gapType: 'stale_board_item', sourceId: source.id }),
        triggerAt: Date.now() + 120_000, recurring: null, sourceMemoryId: null,
      });
      const unrelated = seed.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'How did the unrelated conversation go?',
        context: JSON.stringify({ gapType: 'unresolved_thread', sourceId: 'session-summary-id' }),
        triggerAt: Date.now() + 180_000, recurring: null, sourceMemoryId: null,
      });
      const malformed = seed.addScheduledItem({
        userId: 'default', sessionId: null, source: 'agent', kind: 'nudge', type: 'follow_up',
        message: 'A distinct legacy plain-context nudge', context: 'legacy context is not JSON',
        triggerAt: Date.now() + 240_000, recurring: null, sourceMemoryId: null,
      });
      seed.close();

      const legacy = new Database(dbPath);
      legacy.exec('DROP INDEX IF EXISTS idx_scheduled_source_item');
      legacy.exec('ALTER TABLE scheduled_items DROP COLUMN source_item_id');
      legacy.close();

      migrated = new ScallopDatabase(dbPath);
      expect(migrated.getScheduledItem(wrapper.id)?.sourceItemId).toBe(source.id);
      expect(migrated.getScheduledItem(unrelated.id)?.sourceItemId).toBeNull();
      expect(migrated.getScheduledItem(malformed.id)?.sourceItemId).toBeNull();
      const reopened = new Database(dbPath, { readonly: true });
      expect(reopened.prepare("SELECT name FROM pragma_table_info('scheduled_items') WHERE name = 'source_item_id'").get())
        .toEqual({ name: 'source_item_id' });
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_source_item'").get())
        .toEqual({ name: 'idx_scheduled_source_item' });
      reopened.close();
    } finally {
      migrated?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reuses a similar wrapper from a different source item', () => {
    const firstSource = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Atlas task one', context: null, triggerAt: Date.now() + 60_000,
      recurring: null, sourceMemoryId: null,
    });
    const secondSource = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'user', kind: 'task', type: 'reminder',
      message: 'Atlas task two', context: null, triggerAt: Date.now() + 60_000,
      recurring: null, sourceMemoryId: null,
    });
    const input = {
      userId: 'default', sessionId: null, source: 'agent' as const, kind: 'nudge' as const,
      type: 'follow_up' as const, message: 'Should the Atlas task stay open?', context: null,
      triggerAt: Date.now() + 120_000, recurring: null, sourceMemoryId: null,
    };
    const first = db.addScheduledItem({ ...input, sourceItemId: firstSource.id });
    const second = db.addScheduledItem({ ...input, sourceItemId: secondSource.id });
    const duplicateFirst = db.addScheduledItem({ ...input, sourceItemId: firstSource.id });

    expect(second.id).not.toBe(first.id);
    expect(second.sourceItemId).toBe(secondSource.id);
    expect(duplicateFirst.id).toBe(first.id);
    expect(duplicateFirst.sourceItemId).toBe(firstSource.id);
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

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).not.toContain(item.message);
    expect(db.getScheduledItem(item.id)).toMatchObject({
      status: 'blocked', boardStatus: 'waiting',
      result: { outcome: 'blocked', taskComplete: false },
    });
  });

  it('repairs a reminder misclassified as a worker task instead of reporting worker failure', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Time to put the bin out.' }] },
      }),
    };
    const item = db.addScheduledItem({
      userId: 'default', sessionId: null, source: 'agent', kind: 'task',
      type: 'event_prep', message: 'Time to put the bin out.',
      context: 'Put the bin out at 7pm', triggerAt: Date.now() - 1,
      recurring: null, sourceMemoryId: null, taskConfig: null,
    });
    scheduler = new UnifiedScheduler({
      db, logger, router: router as any, onSendMessage: send,
      getTimezone: () => middayTimezone(), minAgentProactiveGapMs: 0,
    });

    await scheduler.evaluate();

    expect(send).toHaveBeenCalledWith('default', 'Time to put the bin out.');
    expect(db.getScheduledItem(item.id)).toMatchObject({
      kind: 'nudge', type: 'reminder', status: 'fired', boardStatus: 'done',
      result: { outcome: 'succeeded', taskComplete: true },
    });
    expect(db.getRecentProactiveDecisions(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'malformed_task_recovered_as_nudge' }),
    ]));
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
      taskComplete: true,
      outcome: 'succeeded',
      completionSource: 'worker',
      evidenceReceipts: [authoritativeReceipt(
        'analytics',
        'Sign-ups increased by 12% this week.',
        'Collect the analytics report\nCollect the analytics report',
        'a',
      )],
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
      taskComplete: true,
      outcome: 'succeeded',
      completionSource: 'worker',
      evidenceReceipts: [authoritativeReceipt(
        'analytics',
        'Sign-ups increased by 12%.',
        'Collect the weekly analytics from real data\nCollect the weekly analytics',
        'b',
      )],
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
      taskComplete: true,
      outcome: 'succeeded',
      completionSource: 'worker',
      evidenceReceipts: [authoritativeReceipt(
        'releases',
        'Release 1.4 is live.',
        'Collect the release status\nCollect the release status',
        'c',
      )],
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
          })
          .mockResolvedValueOnce({
            response: { content: [{ type: 'text', text: 'The second grounded update is ready.' }] },
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
