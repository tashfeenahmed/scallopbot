import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScallopDatabase } from '../../../../memory/db.js';

const projectRoot = path.resolve(__dirname, '../../../../..');
const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');

function runSkill(dbPath: string, goalId: string, stateUserId: string): {
  success: boolean; output: string; error?: string;
} {
  const child = spawnSync(tsxBin, [path.join(__dirname, 'run.ts')], {
    cwd: path.dirname(dbPath),
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      SKILL_ARGS: JSON.stringify({ goal_id: goalId, verbose: true }),
      SKILL_USER_ID: stateUserId,
      SKILL_STATE_USER_ID: stateUserId,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  return JSON.parse(child.stdout.trim().split('\n').pop()!);
}

describe('progress skill owner isolation', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-skill-owner-test-'));
    dbPath = path.join(tmpDir, 'memories.db');
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('does not reveal a goal selected by another owner\'s exact ID', () => {
    const db = new ScallopDatabase(dbPath);
    const goal = db.addMemory({
      userId: 'owner-b',
      content: 'Private progress plan',
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
      metadata: { goalType: 'goal', status: 'active', progress: 30 },
    });
    db.close();

    expect(runSkill(dbPath, goal.id, 'owner-a')).toMatchObject({
      success: false,
      error: `Goal ${goal.id} not found`,
    });
    const ownerResult = runSkill(dbPath, goal.id, 'owner-b');
    expect(ownerResult.success).toBe(true);
    expect(ownerResult.output).toContain('Private progress plan');
  });
});
