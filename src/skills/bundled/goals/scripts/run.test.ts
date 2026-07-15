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

describe('goals skill owner isolation', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-skill-owner-test-'));
    dbPath = path.join(tmpDir, 'memories.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cannot read, complete, or attach children to another owner\'s goal', () => {
    const db = new ScallopDatabase(dbPath);
    const foreignGoal = db.addMemory({
      userId: 'owner-b',
      content: 'Private foreign goal',
      category: 'insight',
      memoryType: 'regular',
      importance: 8,
      confidence: 1,
      isLatest: true,
      source: 'user',
      documentDate: Date.now(),
      eventDate: null,
      prominence: 1,
      lastAccessed: null,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: { goalType: 'goal', status: 'active', progress: 0 },
    });
    db.close();

    expect(runSkill(dbPath, { action: 'show', id: foreignGoal.id }, 'owner-a'))
      .toMatchObject({ success: false, error: `Item ${foreignGoal.id} not found` });
    expect(runSkill(dbPath, { action: 'complete', id: foreignGoal.id }, 'owner-a'))
      .toMatchObject({ success: false, error: `Item ${foreignGoal.id} not found` });
    expect(runSkill(dbPath, {
      action: 'create', type: 'milestone', title: 'Unauthorized child', parent_id: foreignGoal.id,
    }, 'owner-a')).toMatchObject({
      success: false,
      error: `Parent ${foreignGoal.id} not found`,
    });

    const verify = new Database(dbPath, { readonly: true });
    const row = verify.prepare('SELECT user_id, content, metadata FROM memories WHERE id = ?')
      .get(foreignGoal.id) as { user_id: string; content: string; metadata: string };
    const childCount = verify.prepare(`
      SELECT COUNT(*) AS count FROM memories
      WHERE user_id = 'owner-a' AND json_extract(metadata, '$.parentId') = ?
    `).get(foreignGoal.id) as { count: number };
    verify.close();

    expect(row).toMatchObject({ user_id: 'owner-b', content: 'Private foreign goal' });
    expect(JSON.parse(row.metadata)).toMatchObject({ status: 'active', progress: 0 });
    expect(childCount.count).toBe(0);

    const ownerResult = runSkill(dbPath, { action: 'show', id: foreignGoal.id }, 'owner-b');
    expect(ownerResult.success).toBe(true);
    expect(ownerResult.output).toContain('Private foreign goal');
  });

  it('keeps an abandoned overdue active goal out of the current view without deleting it', () => {
    const db = new ScallopDatabase(dbPath);
    const old = Date.now() - 60 * 24 * 60 * 60 * 1_000;
    const goal = db.addMemory({
      userId: 'owner-a',
      content: 'Long abandoned campaign',
      category: 'insight',
      memoryType: 'regular',
      importance: 8,
      confidence: 1,
      isLatest: true,
      source: 'user',
      documentDate: old,
      eventDate: null,
      prominence: 1,
      lastAccessed: old,
      accessCount: 0,
      sourceChunk: null,
      embedding: null,
      metadata: {
        goalType: 'goal', status: 'active', progress: 0,
        dueDate: old + 7 * 24 * 60 * 60 * 1_000,
      },
    });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare('UPDATE memories SET created_at = ?, updated_at = ?, last_accessed = ? WHERE id = ?')
      .run(old, old, old, goal.id);
    raw.close();

    const current = runSkill(dbPath, { action: 'list' }, 'owner-a');
    expect(current.success).toBe(true);
    expect(current.output).not.toContain('Long abandoned campaign');
    expect(current.output).toBe('No current goals found.');

    const preserved = runSkill(dbPath, { action: 'list', scope: 'all' }, 'owner-a');
    expect(preserved.success).toBe(true);
    expect(preserved.output).toContain('Long abandoned campaign');

    const explicitlyActive = runSkill(dbPath, { action: 'list', status: 'active' }, 'owner-a');
    expect(explicitlyActive.output).toContain('Long abandoned campaign');

    const naturalRecall = runSkill(dbPath, {
      action: 'list', query: 'How did the abandoned campaign go?',
    }, 'owner-a');
    expect(naturalRecall.output).toContain('Long abandoned campaign');
    expect(goal.id).toBeTruthy();
  });
});
