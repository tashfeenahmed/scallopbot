import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ScallopDatabase, type ScheduledItemSource, type ScheduledItemStatus } from '../../../../memory/db.js';

const projectRoot = path.resolve(__dirname, '../../../../..');
const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');

interface SkillResult {
  success: boolean;
  output: string;
  exitCode: number;
}

function runSkill(
  dbPath: string,
  args: Record<string, unknown>,
  stateUserId = 'default',
): SkillResult {
  const result = execFileSync(tsxBin, [path.join(__dirname, 'run.ts')], {
    cwd: path.dirname(dbPath),
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      SKILL_ARGS: JSON.stringify(args),
      SKILL_USER_ID: 'telegram:owner-123',
      SKILL_STATE_USER_ID: stateUserId,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return JSON.parse(result.trim().split('\n').pop()!);
}

function addItem(
  db: ScallopDatabase,
  userId: string,
  source: ScheduledItemSource,
  message: string,
  status: ScheduledItemStatus = 'pending',
  triggerOffsetMs = 60 * 60 * 1000,
): string {
  return db.addScheduledItem({
    userId,
    sessionId: null,
    source,
    kind: 'nudge',
    type: source === 'agent' ? 'follow_up' : 'reminder',
    message,
    context: null,
    triggerAt: Date.now() + triggerOffsetMs,
    recurring: null,
    sourceMemoryId: null,
    status,
    boardStatus: status === 'pending' ? 'scheduled' : 'done',
  }).id;
}

describe('triggers skill ownership and retention', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-skill-test-'));
    dbPath = path.join(tmpDir, 'memories.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists only pending automatic triggers owned by the canonical state user', () => {
    const db = new ScallopDatabase(dbPath);
    addItem(db, 'default', 'agent', 'Owner automatic follow-up');
    const farFuture = 400 * 24 * 60 * 60 * 1000;
    addItem(db, 'default', 'agent', 'Future automatic follow-up', 'pending', farFuture);
    addItem(db, 'default', 'user', 'Owner explicit reminder');
    addItem(db, 'other-user', 'agent', 'Other user automatic follow-up');
    addItem(db, 'default', 'agent', 'Already delivered automatic follow-up', 'fired');
    db.close();

    const result = runSkill(dbPath, { action: 'list' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Owner automatic follow-up');
    expect(result.output).toContain('Automatic triggers due or approaching');
    expect(result.output).toContain('Future automatic triggers (scheduled; not current work priorities)');
    expect(result.output).toContain('Future automatic follow-up');
    expect(result.output).toContain(String(new Date(Date.now() + farFuture).getFullYear()));
    expect(result.output).not.toContain('Owner explicit reminder');
    expect(result.output).not.toContain('Other user automatic follow-up');
    expect(result.output).not.toContain('Already delivered automatic follow-up');
  });

  it('cancels only an owned automatic trigger and preserves its audit row', () => {
    const db = new ScallopDatabase(dbPath);
    const ownerTriggerId = addItem(db, 'default', 'agent', 'Owner automatic follow-up');
    const ownerReminderId = addItem(db, 'default', 'user', 'Owner explicit reminder');
    const otherTriggerId = addItem(db, 'other-user', 'agent', 'Other user automatic follow-up');
    db.close();

    expect(runSkill(dbPath, { action: 'cancel', trigger_id: otherTriggerId.slice(0, 8) }).output)
      .toContain('No pending trigger found');
    expect(runSkill(dbPath, { action: 'cancel', trigger_id: ownerReminderId.slice(0, 8) }).output)
      .toContain('No pending trigger found');
    expect(runSkill(dbPath, { action: 'cancel', trigger_id: ownerTriggerId.slice(0, 8) }).output)
      .toContain('Cancelled');

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare(`
      SELECT id, status, board_status FROM scheduled_items
      WHERE id IN (?, ?, ?)
    `).all(ownerTriggerId, ownerReminderId, otherTriggerId) as Array<{
      id: string;
      status: string;
      board_status: string;
    }>;
    raw.close();
    const byId = new Map(rows.map(row => [row.id, row]));

    expect(byId.get(ownerTriggerId)).toMatchObject({ status: 'dismissed', board_status: 'archived' });
    expect(byId.get(ownerReminderId)).toMatchObject({ status: 'pending', board_status: 'scheduled' });
    expect(byId.get(otherTriggerId)).toMatchObject({ status: 'pending', board_status: 'scheduled' });
  });

  it('cancel_all dismisses only owned automatic triggers without deleting rows', () => {
    const db = new ScallopDatabase(dbPath);
    const firstOwnerId = addItem(db, 'default', 'agent', 'Book the dentist follow-up');
    const secondOwnerId = addItem(
      db,
      'default',
      'agent',
      'Renew the passport follow-up',
      'pending',
      4 * 60 * 60 * 1000,
    );
    const ownerReminderId = addItem(db, 'default', 'user', 'Take medication at nine');
    const otherTriggerId = addItem(db, 'other-user', 'agent', 'Other account follow-up');
    db.close();

    const result = runSkill(dbPath, { action: 'cancel_all' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Cancelled 2 pending automatic trigger(s)');

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare(`
      SELECT id, status, board_status FROM scheduled_items
      WHERE id IN (?, ?, ?, ?)
    `).all(firstOwnerId, secondOwnerId, ownerReminderId, otherTriggerId) as Array<{
      id: string;
      status: string;
      board_status: string;
    }>;
    raw.close();
    const byId = new Map(rows.map(row => [row.id, row]));

    expect(rows).toHaveLength(4);
    expect(byId.get(firstOwnerId)).toMatchObject({ status: 'dismissed', board_status: 'archived' });
    expect(byId.get(secondOwnerId)).toMatchObject({ status: 'dismissed', board_status: 'archived' });
    expect(byId.get(ownerReminderId)).toMatchObject({ status: 'pending', board_status: 'scheduled' });
    expect(byId.get(otherTriggerId)).toMatchObject({ status: 'pending', board_status: 'scheduled' });
  });

  it('rejects an ambiguous abbreviated trigger ID without changing either row', () => {
    const db = new ScallopDatabase(dbPath);
    const firstId = addItem(db, 'default', 'agent', 'Renew the passport');
    const secondId = addItem(db, 'default', 'agent', 'Book the dentist');
    db.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('shared-trigger-a', firstId);
    raw.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('shared-trigger-b', secondId);
    raw.close();

    const result = runSkill(dbPath, { action: 'cancel', trigger_id: 'shared-trigger-' });
    expect(result.output).toContain('is ambiguous');

    const verify = new Database(dbPath, { readonly: true });
    const rows = verify.prepare(`
      SELECT status, board_status FROM scheduled_items WHERE id LIKE 'shared-trigger-%'
    `).all() as Array<{ status: string; board_status: string }>;
    verify.close();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.status === 'pending' && row.board_status === 'scheduled')).toBe(true);
  });
});
