import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ScallopDatabase, type ScheduledItem } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TSX_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

describe('scheduled-item lifecycle invariants', () => {
  let dbPath: string;
  let db: ScallopDatabase | null;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `scheduled-state-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new ScallopDatabase(dbPath);
  });

  afterEach(() => {
    db?.close();
    db = null;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }
  });

  function add(overrides: Partial<Parameters<ScallopDatabase['addScheduledItem']>[0]> = {}): ScheduledItem {
    return db!.addScheduledItem({
      userId: 'default',
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message: `item-${Math.random().toString(36).slice(2)}`,
      context: null,
      triggerAt: Date.now() + 60_000,
      recurring: null,
      sourceMemoryId: null,
      ...overrides,
    });
  }

  it('age cleanup expires only scheduled pending nudges', () => {
    const now = Date.now();

    const leasedTask = add({
      kind: 'task',
      type: 'event_prep',
      message: 'leased board task',
      triggerAt: now - 2 * DAY_MS,
      boardStatus: 'scheduled',
      priority: 'urgent',
    });
    const lease = db!.claimNextBoardTask('default', 'worker-1', 60_000, now);
    expect(lease?.id).toBe(leasedTask.id);

    const processingNudge = add({
      message: 'in-flight reminder',
      triggerAt: now - 2 * DAY_MS,
    });
    expect(db!.claimDueScheduledItems(now, 'nudge').map(item => item.id))
      .toEqual([processingNudge.id]);

    const expiredNudge = add({
      message: 'old pending reminder',
      triggerAt: now - 2 * DAY_MS,
    });
    const zeroTimeBoardWork = add({
      kind: 'task',
      type: 'event_prep',
      message: 'unscheduled board work',
      triggerAt: 0,
      boardStatus: 'backlog',
    });
    const overdueBoardWork = add({
      kind: 'task',
      type: 'event_prep',
      message: 'overdue board work',
      triggerAt: now - 2 * DAY_MS,
      boardStatus: 'scheduled',
    });
    const recurringNudge = add({
      message: 'recurring reminder',
      triggerAt: now - 2 * DAY_MS,
      recurring: { type: 'daily', hour: 9, minute: 0 },
    });

    expect(db!.expireOldScheduledItems(DAY_MS)).toBe(1);
    expect(db!.getScheduledItem(expiredNudge.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
    });
    expect(db!.getScheduledItem(processingNudge.id)).toMatchObject({
      status: 'processing',
      boardStatus: 'in_progress',
    });
    expect(db!.getScheduledItem(leasedTask.id)).toMatchObject({
      status: 'processing',
      boardStatus: 'in_progress',
    });
    expect(db!.getScheduledItem(zeroTimeBoardWork.id)?.status).toBe('pending');
    expect(db!.getScheduledItem(overdueBoardWork.id)?.status).toBe('pending');
    expect(db!.getScheduledItem(recurringNudge.id)?.status).toBe('pending');
  });

  it('never delivers trigger_at=0 nudges while keeping zero-time board tasks leaseable', () => {
    const unscheduledNudge = add({
      message: 'backlog note, not a reminder',
      triggerAt: 0,
      boardStatus: 'inbox',
    });
    const boardTask = add({
      kind: 'task',
      type: 'event_prep',
      message: 'ready board task',
      triggerAt: 0,
      boardStatus: 'backlog',
    });

    expect(db!.getDueScheduledItems()).toEqual([]);
    expect(db!.claimDueScheduledItems(Date.now(), 'nudge')).toEqual([]);
    expect(db!.getScheduledItem(unscheduledNudge.id)).toMatchObject({
      status: 'pending',
      boardStatus: 'inbox',
    });

    const lease = db!.claimNextBoardTask('default', 'worker-zero', 60_000);
    expect(lease).toMatchObject({
      id: boardTask.id,
      status: 'processing',
      boardStatus: 'in_progress',
    });
  });

  it('synchronizes cancellation paths and rejects contradictory direct SQL', () => {
    const byMemory = add({ sourceMemoryId: 'memory-to-forget' });
    expect(db!.cancelScheduledItemsBySourceMemory('memory-to-forget')).toBe(1);
    expect(db!.getScheduledItem(byMemory.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
    });

    const bySimilarity = add({ message: 'Follow up about the Atlas client plan' });
    expect(db!.cancelSimilarScheduledItems('default', 'Atlas client plan follow up')).toBe(1);
    expect(db!.getScheduledItem(bySimilarity.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
    });

    const genericUpdate = add({ message: 'generic state update' });
    expect(db!.updateScheduledItem(genericUpdate.id, { status: 'expired' })).toBe(true);
    expect(db!.getScheduledItem(genericUpdate.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
    });

    const guarded = add({ message: 'guarded row' });
    const raw = new Database(dbPath);
    expect(() => raw.prepare(`
      UPDATE scheduled_items SET status = 'expired' WHERE id = ?
    `).run(guarded.id)).toThrow(/status\/board_status invariant violation/);
    raw.close();
    expect(db!.getScheduledItem(guarded.id)).toMatchObject({
      status: 'pending',
      boardStatus: 'scheduled',
    });
  });

  it('archives duplicate candidates without deleting their history', () => {
    const triggerAt = Date.now() + DAY_MS;
    const first = add({
      source: 'agent',
      message: 'Follow up about the client acquisition plan',
      triggerAt,
    });
    const second = add({
      source: 'agent',
      message: 'Follow up about the client acquisition plan',
      // Outside addScheduledItem's narrow creation-time dedup window, but
      // inside the periodic consolidation window.
      triggerAt: triggerAt + 3 * 60 * 60 * 1000,
    });

    expect(db!.consolidateDuplicateScheduledItems()).toBe(1);
    const preserved = [db!.getScheduledItem(first.id), db!.getScheduledItem(second.id)];
    expect(preserved).not.toContain(null);
    expect(preserved.filter(item => item?.status === 'pending')).toHaveLength(1);
    expect(preserved.filter(item => item?.status === 'expired')).toEqual([
      expect.objectContaining({
        boardStatus: 'archived',
        lastError: 'Archived as a duplicate scheduled item',
      }),
    ]);
  });

  it('never consolidates wrappers from different source items or execution shapes', () => {
    const base = Date.now() + DAY_MS;
    const sourceA = add({
      kind: 'task',
      type: 'event_prep',
      message: 'Atlas acquisition source A',
      triggerAt: 0,
      boardStatus: 'backlog',
    });
    const sourceB = add({
      kind: 'task',
      type: 'event_prep',
      message: 'Atlas acquisition source B',
      triggerAt: 0,
      boardStatus: 'backlog',
    });
    const wrapperA = add({
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Should we follow up on the Atlas acquisition plan?',
      sourceItemId: sourceA.id,
      triggerAt: base,
    });
    const wrapperB = add({
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Should we follow up on the Atlas acquisition plan?',
      sourceItemId: sourceB.id,
      triggerAt: base + 3 * 60 * 60 * 1000,
    });
    const taskShape = add({
      source: 'agent',
      kind: 'task',
      type: 'event_prep',
      message: 'Should we follow up on the Atlas acquisition plan?',
      sourceItemId: sourceA.id,
      triggerAt: base + 6 * 60 * 60 * 1000,
    });
    const duplicateA = add({
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Should we follow up on the Atlas acquisition plan?',
      sourceItemId: sourceA.id,
      triggerAt: base + 9 * 60 * 60 * 1000,
    });

    // Only the two same-source, same-kind, same-type wrappers are duplicates.
    expect(db!.consolidateDuplicateScheduledItems()).toBe(1);
    expect(db!.getScheduledItem(wrapperB.id)?.status).toBe('pending');
    expect(db!.getScheduledItem(taskShape.id)?.status).toBe('pending');
    const sameIdentity = [wrapperA.id, duplicateA.id].map(id => db!.getScheduledItem(id));
    expect(sameIdentity.filter(item => item?.status === 'pending')).toHaveLength(1);
    expect(sameIdentity.filter(item => item?.status === 'expired')).toHaveLength(1);
  });

  it('applies a linked Snooze and wrapper acknowledgement exactly once across connections', () => {
    const now = Date.parse('2026-07-11T12:00:00Z');
    const source = add({
      kind: 'task',
      type: 'event_prep',
      message: 'Project Atlas acquisition plan',
      triggerAt: 0,
      boardStatus: 'waiting',
    });
    const wrapper = add({
      source: 'agent',
      kind: 'nudge',
      type: 'follow_up',
      message: 'Should the Project Atlas plan stay open?',
      sourceItemId: source.id,
      triggerAt: now - 1,
    });
    db!.markScheduledItemFired(wrapper.id);
    const secondConnection = new ScallopDatabase(dbPath);

    try {
      const first = db!.applyLinkedSourceReplyAndAcknowledge({
        wrapperId: wrapper.id,
        sourceItemId: source.id,
        ownerUserId: 'default',
        feedbackUserId: 'default',
        action: 'snooze',
        delayMs: DAY_MS,
        score: 1.5,
        now,
      });
      const triggerAfterFirst = db!.getScheduledItem(source.id)!.triggerAt;
      const retry = secondConnection.applyLinkedSourceReplyAndAcknowledge({
        wrapperId: wrapper.id,
        sourceItemId: source.id,
        ownerUserId: 'default',
        feedbackUserId: 'default',
        action: 'snooze',
        delayMs: DAY_MS,
        score: 1.5,
        now: now + 60 * 60 * 1000,
      });

      expect(first).toEqual({
        acknowledged: true,
        replayed: false,
        sourceAction: { action: 'snooze', title: 'Project Atlas acquisition plan', applied: true },
      });
      expect(retry).toEqual({
        acknowledged: true,
        replayed: true,
        sourceAction: { action: 'snooze', title: 'Project Atlas acquisition plan', applied: true },
      });
      expect(triggerAfterFirst).toBe(now + DAY_MS);
      expect(secondConnection.getScheduledItem(source.id)?.triggerAt).toBe(triggerAfterFirst);
      expect(secondConnection.getScheduledItem(wrapper.id)).toMatchObject({
        status: 'acted',
        boardStatus: 'done',
      });
      const decisions = secondConnection.getRecentProactiveDecisions(20)
        .filter(decision => decision.detail?.itemId === wrapper.id);
      expect(decisions).toHaveLength(2);
      expect(decisions.map(decision => decision.outcome).sort()).toEqual(['acted', 'source_updated']);
    } finally {
      secondConnection.close();
    }
  });

  it('acknowledges a source reply without mutating a live worker lease', () => {
    const source = add({
      kind: 'task',
      type: 'event_prep',
      message: 'Project Atlas leased research',
      triggerAt: 0,
      boardStatus: 'backlog',
    });
    const lease = db!.claimNextBoardTask('default', 'atlas-worker', 60_000)!;
    expect(lease.id).toBe(source.id);
    const wrapper = add({
      source: 'agent', kind: 'nudge', type: 'follow_up',
      message: 'Should the leased Atlas research be snoozed?',
      sourceItemId: source.id, triggerAt: Date.now() - 1,
    });
    db!.markScheduledItemFired(wrapper.id);

    const result = db!.applyLinkedSourceReplyAndAcknowledge({
      wrapperId: wrapper.id,
      sourceItemId: source.id,
      ownerUserId: 'default',
      feedbackUserId: 'default',
      action: 'snooze',
      delayMs: DAY_MS,
      score: 1,
    });

    expect(result).toEqual({ acknowledged: true, replayed: false, sourceAction: null });
    expect(db!.getScheduledItem(source.id)).toMatchObject({
      status: 'processing',
      boardStatus: 'in_progress',
      leaseToken: lease.leaseToken,
    });
    expect(db!.getScheduledItem(wrapper.id)?.status).toBe('acted');
  });

  it('allows reminder and goal subprocess writers through the persisted invariant', () => {
    db!.close();
    db = null;

    const runSkill = (script: string, args: Record<string, unknown>) => {
      const output = execFileSync(TSX_BIN, [path.join(PROJECT_ROOT, script)], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          MEMORY_DB_PATH: dbPath,
          SKILL_ARGS: JSON.stringify(args),
          SKILL_STATE_USER_ID: 'default',
          SKILL_USER_TIMEZONE: 'UTC',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      return JSON.parse(output.trim().split('\n').pop()!) as { success: boolean; error?: string };
    };

    expect(runSkill('src/skills/bundled/reminder/scripts/run.ts', {
      action: 'set',
      message: 'Bring the deployment notes',
      time: '5 minutes',
    })).toMatchObject({ success: true });
    expect(runSkill('src/skills/bundled/goals/scripts/run.ts', {
      action: 'create',
      type: 'goal',
      title: 'Ship the public release',
      status: 'active',
      checkin: 'daily',
    })).toMatchObject({ success: true });

    db = new ScallopDatabase(dbPath);
    const created = db.getScheduledItemsByUser('default');
    expect(created).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'Bring the deployment notes',
        kind: 'nudge',
        status: 'pending',
        boardStatus: 'scheduled',
        messageProvenance: 'generated',
      }),
      expect.objectContaining({
        message: expect.stringContaining('Ship the public release'),
        kind: 'nudge',
        status: 'pending',
        boardStatus: 'scheduled',
        messageProvenance: 'generated',
      }),
    ]));
  });

  it('audits and losslessly reconciles legacy contradictions without reviving work', () => {
    const expiredGhost = add({ message: 'expired ghost', status: 'expired' });
    const completedGhost = add({ message: 'completed ghost', status: 'fired' });
    db!.updateScheduledItemResult(completedGhost.id, {
      response: 'Historical completion result',
      completedAt: completedGhost.updatedAt,
    });
    const terminalBoardGhost = add({
      message: 'pending row with terminal board state',
      triggerAt: Date.now() - 2 * DAY_MS,
    });
    const processing = add({ message: 'processing row', status: 'processing' });
    const processingDone = add({ message: 'processing row marked done', status: 'processing' });
    const processingArchived = add({ message: 'processing row marked archived', status: 'processing' });

    db!.close();
    db = null;

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TRIGGER trg_scheduled_items_state_guard_insert;
      DROP TRIGGER trg_scheduled_items_state_guard_update;
    `);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'in_progress' WHERE id = ?`)
      .run(expiredGhost.id);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'waiting' WHERE id = ?`)
      .run(completedGhost.id);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'done' WHERE id = ?`)
      .run(terminalBoardGhost.id);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'waiting' WHERE id = ?`)
      .run(processing.id);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'done' WHERE id = ?`)
      .run(processingDone.id);
    legacy.prepare(`UPDATE scheduled_items SET board_status = 'archived' WHERE id = ?`)
      .run(processingArchived.id);
    const beforeCount = (legacy.prepare('SELECT COUNT(*) AS count FROM scheduled_items').get() as { count: number }).count;
    legacy.close();

    db = new ScallopDatabase(dbPath);

    expect(db.getScheduledItem(expiredGhost.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
      updatedAt: expiredGhost.updatedAt,
    });
    expect(db.getScheduledItem(completedGhost.id)).toMatchObject({
      status: 'fired',
      boardStatus: 'archived',
    });
    expect(db.getScheduledItem(terminalBoardGhost.id)).toMatchObject({
      status: 'expired',
      boardStatus: 'archived',
    });
    expect(db.getScheduledItem(processing.id)).toMatchObject({
      status: 'processing',
      boardStatus: 'in_progress',
    });
    expect(db.getScheduledItem(processingDone.id)).toMatchObject({
      status: 'fired',
      boardStatus: 'archived',
      updatedAt: processingDone.updatedAt,
    });
    expect(db.getScheduledItem(processingArchived.id)).toMatchObject({
      status: 'dismissed',
      boardStatus: 'archived',
      updatedAt: processingArchived.updatedAt,
    });
    expect(db.getDueScheduledItems()).toEqual([]);
    expect(db.getUnnotifiedCompletedItems('default')).toEqual([]);

    let raw = new Database(dbPath);
    expect((raw.prepare('SELECT COUNT(*) AS count FROM scheduled_items').get() as { count: number }).count)
      .toBe(beforeCount);
    const auditRows = raw.prepare(`
      SELECT item_id, previous_status, previous_board_status, reason, item_snapshot
      FROM scheduled_item_state_reconciliation_audit
      ORDER BY item_id
    `).all() as Array<{
      item_id: string;
      previous_status: string;
      previous_board_status: string;
      reason: string;
      item_snapshot: string;
    }>;
    expect(auditRows).toHaveLength(6);
    const expiredAudit = auditRows.find(row => row.item_id === expiredGhost.id)!;
    expect(expiredAudit).toMatchObject({
      previous_status: 'expired',
      previous_board_status: 'in_progress',
      reason: 'repaired_terminal_board_projection',
    });
    expect(JSON.parse(expiredAudit.item_snapshot)).toMatchObject({
      id: expiredGhost.id,
      status: 'expired',
      board_status: 'in_progress',
      message: 'expired ghost',
    });
    expect(auditRows.find(row => row.item_id === processingDone.id)).toMatchObject({
      previous_status: 'processing',
      previous_board_status: 'done',
      reason: 'quarantined_processing_done_conflict',
    });
    expect(auditRows.find(row => row.item_id === processingArchived.id)).toMatchObject({
      previous_status: 'processing',
      previous_board_status: 'archived',
      reason: 'quarantined_processing_archived_conflict',
    });
    raw.close();

    // Reopening is idempotent: canonical rows are untouched and no duplicate
    // audit entries are manufactured.
    db.close();
    db = new ScallopDatabase(dbPath);
    raw = new Database(dbPath);
    expect((raw.prepare(`
      SELECT COUNT(*) AS count FROM scheduled_item_state_reconciliation_audit
    `).get() as { count: number }).count).toBe(6);
    raw.close();
  });

  it('upgrades a genuine pre-migration Atlas-style database losslessly', () => {
    db!.close();
    db = null;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }

    const legacyUpdatedAt = Date.parse('2026-02-22T04:09:00Z');
    const legacy = new Database(dbPath);
    // This is the public schema shape from before source_item_id, state audit,
    // and invariant triggers. It deliberately contains the real failure shape.
    legacy.exec(`
      CREATE TABLE scheduled_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        trigger_at INTEGER NOT NULL,
        recurring TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        fired_at INTEGER,
        source_memory_id TEXT,
        board_status TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, type, message, context,
        trigger_at, recurring, status, fired_at, source_memory_id,
        board_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-atlas-task',
      'default',
      null,
      'agent',
      'event_prep',
      "Project Atlas: Plan this week's client acquisition strategy",
      JSON.stringify({ legacy: true, privateDataMustRemain: 'preserved' }),
      0,
      null,
      'expired',
      null,
      'legacy-memory-id',
      'in_progress',
      legacyUpdatedAt,
      legacyUpdatedAt,
    );
    legacy.close();

    expect(() => { db = new ScallopDatabase(dbPath); }).not.toThrow();
    const repaired = db!.getScheduledItem('legacy-atlas-task');
    expect(repaired).toMatchObject({
      id: 'legacy-atlas-task',
      message: "Project Atlas: Plan this week's client acquisition strategy",
      context: JSON.stringify({ legacy: true, privateDataMustRemain: 'preserved' }),
      sourceMemoryId: 'legacy-memory-id',
      sourceItemId: null,
      triggerAt: 0,
      status: 'expired',
      boardStatus: 'archived',
      updatedAt: legacyUpdatedAt,
    });
    expect(db!.getDueScheduledItems()).toEqual([]);

    let inspect = new Database(dbPath);
    expect((inspect.prepare('SELECT COUNT(*) AS count FROM scheduled_items').get() as { count: number }).count)
      .toBe(1);
    expect((inspect.prepare(`
      SELECT COUNT(*) AS count
      FROM pragma_table_info('scheduled_items')
      WHERE name = 'source_item_id'
    `).get() as { count: number }).count).toBe(1);
    expect((inspect.prepare(`
      SELECT COUNT(*) AS count
      FROM pragma_index_list('scheduled_items')
      WHERE name = 'idx_scheduled_source_item'
    `).get() as { count: number }).count).toBe(1);
    const audit = inspect.prepare(`
      SELECT previous_status, previous_board_status, reconciled_status,
             reconciled_board_status, item_snapshot
      FROM scheduled_item_state_reconciliation_audit
      WHERE item_id = 'legacy-atlas-task'
    `).get() as {
      previous_status: string;
      previous_board_status: string;
      reconciled_status: string;
      reconciled_board_status: string;
      item_snapshot: string;
    };
    expect(audit).toMatchObject({
      previous_status: 'expired',
      previous_board_status: 'in_progress',
      reconciled_status: 'expired',
      reconciled_board_status: 'archived',
    });
    expect(JSON.parse(audit.item_snapshot)).toMatchObject({
      id: 'legacy-atlas-task',
      context: JSON.stringify({ legacy: true, privateDataMustRemain: 'preserved' }),
      board_status: 'in_progress',
      updated_at: legacyUpdatedAt,
    });
    inspect.close();

    db!.close();
    db = new ScallopDatabase(dbPath);
    inspect = new Database(dbPath);
    expect((inspect.prepare(`
      SELECT COUNT(*) AS count
      FROM scheduled_item_state_reconciliation_audit
      WHERE item_id = 'legacy-atlas-task'
    `).get() as { count: number }).count).toBe(1);
    inspect.close();
  });

  it('archives historical deliveries when upgrading a database with no board columns', () => {
    db!.close();
    db = null;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }

    const createdAt = Date.parse('2025-01-15T12:00:00Z');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE scheduled_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        trigger_at INTEGER NOT NULL,
        recurring TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        fired_at INTEGER,
        source_memory_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, type, message, context,
        trigger_at, recurring, status, fired_at, source_memory_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?)
    `).run(
      'historical-delivery',
      'default',
      'agent',
      'follow_up',
      'Synthetic historical follow-up',
      createdAt,
      'fired',
      createdAt,
      createdAt,
      createdAt,
    );
    legacy.close();

    db = new ScallopDatabase(dbPath);
    expect(db.getScheduledItem('historical-delivery')).toMatchObject({
      status: 'fired',
      boardStatus: 'archived',
      message: 'Synthetic historical follow-up',
      createdAt,
      updatedAt: createdAt,
    });
    expect(db.getUnnotifiedCompletedItems('default')).toEqual([]);
  });
});
