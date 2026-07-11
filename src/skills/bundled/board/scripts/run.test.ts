import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ScallopDatabase } from '../../../../memory/db.js';

const projectRoot = path.resolve(__dirname, '../../../../..');
const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

function runSkill(dbPath: string, args: Record<string, unknown>, stateUserId: string): SkillResult {
  const child = spawnSync(tsxBin, [path.join(__dirname, 'run.ts')], {
    cwd: path.dirname(dbPath),
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      SKILL_ARGS: JSON.stringify(args),
      SKILL_USER_ID: stateUserId,
      SKILL_STATE_USER_ID: stateUserId,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  return JSON.parse(child.stdout.trim().split('\n').pop()!) as SkillResult;
}

describe('board skill owner-scoped item lookup', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-skill-owner-test-'));
    dbPath = path.join(tmpDir, 'memories.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects foreign IDs and ambiguous owned prefixes without mutating either row', () => {
    const db = new ScallopDatabase(dbPath);
    const add = (userId: string, message: string) => db.addScheduledItem({
      userId,
      sessionId: null,
      source: 'user',
      kind: 'nudge',
      type: 'reminder',
      message,
      context: null,
      triggerAt: 0,
      recurring: null,
      sourceMemoryId: null,
      boardStatus: 'backlog',
    }).id;
    const firstOriginal = add('owner-a', 'First owner item');
    const secondOriginal = add('owner-a', 'Second owner item');
    const foreignOriginal = add('owner-b', 'Private foreign item');
    db.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('owned-shared-a', firstOriginal);
    raw.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('owned-shared-b', secondOriginal);
    raw.prepare('UPDATE scheduled_items SET id = ? WHERE id = ?').run('foreign-exact', foreignOriginal);
    raw.close();

    const foreign = runSkill(dbPath, { action: 'archive', item_id: 'foreign-exact' }, 'owner-a');
    expect(foreign).toMatchObject({ success: false, error: 'Item not found: foreign-exact' });

    const ambiguous = runSkill(dbPath, { action: 'archive', item_id: 'owned-shared-' }, 'owner-a');
    expect(ambiguous).toMatchObject({ success: false, error: 'Item ID is ambiguous: owned-shared-' });

    const exact = runSkill(dbPath, { action: 'archive', item_id: 'owned-shared-a' }, 'owner-a');
    expect(exact.success).toBe(true);

    const verify = new Database(dbPath, { readonly: true });
    const rows = verify.prepare(`
      SELECT id, user_id, status, board_status FROM scheduled_items ORDER BY id
    `).all() as Array<{ id: string; user_id: string; status: string; board_status: string }>;
    verify.close();

    expect(rows.find(row => row.id === 'foreign-exact')).toMatchObject({
      user_id: 'owner-b', status: 'pending', board_status: 'backlog',
    });
    expect(rows.find(row => row.id === 'owned-shared-b')).toMatchObject({
      user_id: 'owner-a', status: 'pending', board_status: 'backlog',
    });
    expect(rows.find(row => row.id === 'owned-shared-a')).toMatchObject({
      user_id: 'owner-a', status: 'dismissed', board_status: 'archived',
    });
  });
});
