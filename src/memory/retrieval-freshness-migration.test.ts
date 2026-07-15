import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ScallopDatabase } from './db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('retrieval freshness migration', () => {
  it('repairs legacy access-written freshness and never repeats the contamination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scallop-retrieval-freshness-'));
    dirs.push(dir);
    const dbPath = join(dir, 'memories.db');
    const documentDate = Date.now() - 180 * 24 * 60 * 60 * 1_000;
    let db = new ScallopDatabase(dbPath);
    const memory = db.addMemory({
      userId: 'default', content: 'An old meeting', category: 'event', memoryType: 'regular',
      importance: 5, confidence: 0.8, isLatest: true, source: 'user', documentDate,
      eventDate: documentDate, prominence: 1, lastAccessed: null, accessCount: 0,
      sourceChunk: null, embedding: null, metadata: null,
    });
    const goal = db.addMemory({
      userId: 'default', content: 'Prepare for an old meeting', category: 'insight',
      memoryType: 'static_profile', importance: 8, confidence: 1, isLatest: true,
      source: 'user', documentDate, eventDate: null, prominence: 1,
      lastAccessed: null, accessCount: 0, sourceChunk: null, embedding: null,
      metadata: { goalType: 'goal', status: 'backlog', progress: 0 },
    });
    db.close();

    const legacyAccess = Date.now();
    const raw = new Database(dbPath);
    raw.prepare(`
      UPDATE memories
      SET created_at = ?, last_accessed = ?, access_count = 42, updated_at = ?
      WHERE id = ?
    `).run(documentDate, legacyAccess, legacyAccess, memory.id);
    raw.prepare(`
      UPDATE memories
      SET created_at = ?, last_accessed = ?, access_count = 99, updated_at = ?
      WHERE id = ?
    `).run(documentDate, legacyAccess, legacyAccess, goal.id);
    raw.prepare('UPDATE goal_registry SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(documentDate, legacyAccess, goal.id);
    raw.close();

    db = new ScallopDatabase(dbPath);
    const repaired = db.getMemory(memory.id)!;
    expect(repaired.updatedAt).toBe(repaired.documentDate);
    expect(repaired.lastAccessed).toBe(legacyAccess);
    expect(repaired.accessCount).toBe(42);
    const repairedGoal = db.getGoalRegistryEntry(goal.id)!;
    expect(repairedGoal.updatedAt).toBe(documentDate);
    expect(db.getMemory(goal.id)!.accessCount).toBe(99);

    const audits = db.raw<Record<string, unknown>>(
      'SELECT * FROM retrieval_freshness_repair_audit ORDER BY memory_id',
    );
    expect(audits).toHaveLength(2);
    const goalAudit = audits.find(row => row.memory_id === goal.id)!;
    expect(goalAudit.previous_goal_updated_at).toBe(legacyAccess);
    expect(goalAudit.repaired_goal_updated_at).toBe(documentDate);

    db.recordAccess(memory.id);
    const after = db.getMemory(memory.id)!;
    expect(after.updatedAt).toBe(repaired.updatedAt);
    expect(after.accessCount).toBe(43);
    db.close();
  });
});
