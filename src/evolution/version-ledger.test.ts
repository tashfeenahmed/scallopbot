import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScallopDatabase } from '../memory/db.js';
import { DEFAULT_EVOLUTION_CONFIG } from './config.js';
import { SkillStore } from './skill-store.js';
import { runRollbackWatchdog } from './watchdog.js';

describe('transactional evolution version ledger', () => {
  let dir: string;
  let db: ScallopDatabase | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evolution-ledger-'));
  });

  afterEach(async () => {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('transactionally supersedes older versions so one target has one active row', () => {
    const dbPath = join(dir, 'versions.db');
    db = new ScallopDatabase(dbPath);
    const first = db.recordEvolutionVersion({ target: 'learned', kind: 'create_skill', at: 100 });
    const second = db.recordEvolutionVersion({ target: 'learned', kind: 'patch_skill', at: 200 });

    expect(second).toBeGreaterThan(first);
    expect(db.getActiveEvolutionVersions().filter(item => item.target === 'learned'))
      .toEqual([expect.objectContaining({ id: second, at: 200 })]);

    const raw = new Database(dbPath);
    expect(() => raw.prepare(`
      INSERT INTO evolution_versions (target, kind, at, status)
      VALUES ('learned', 'patch_skill', 300, 'active')
    `).run()).toThrow();
    raw.close();
  });

  it('keeps the prior version active when replacement ledger insertion fails', () => {
    const dbPath = join(dir, 'version-replacement-failure.db');
    db = new ScallopDatabase(dbPath);
    const first = db.recordEvolutionVersion({ target: 'learned', kind: 'create_skill', at: 100 });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER fail_replacement_version
      BEFORE INSERT ON evolution_versions
      WHEN NEW.at = 200
      BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END;
    `);
    raw.close();

    expect(() => db!.recordEvolutionVersion({
      target: 'learned', kind: 'patch_skill', at: 200,
    })).toThrow('injected replacement failure');
    expect(db.getActiveEvolutionVersion('learned')?.id).toBe(first);
  });

  it('normalizes duplicate active rows in an existing public database before adding uniqueness', () => {
    const dbPath = join(dir, 'legacy-duplicates.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE evolution_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        baseline_fitness REAL,
        snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        detail TEXT
      );
      INSERT INTO evolution_versions (target, kind, at, status)
      VALUES ('legacy', 'create_skill', 100, 'active');
      INSERT INTO evolution_versions (target, kind, at, status)
      VALUES ('legacy', 'patch_skill', 200, 'active');
    `);
    legacy.close();

    db = new ScallopDatabase(dbPath);
    expect(db.getActiveEvolutionVersions().filter(item => item.target === 'legacy'))
      .toEqual([expect.objectContaining({ kind: 'patch_skill', at: 200 })]);
  });

  it('rolls back only the newest prompt version and cannot cascade to superseded ledgers', async () => {
    db = new ScallopDatabase(join(dir, 'prompt-watchdog.db'));
    db.promotePromptEvolution({
      fragmentId: 'learned_guidance', content: 'First safe guidance.', at: 100, snapshot: null,
    });
    const second = db.promotePromptEvolution({
      fragmentId: 'learned_guidance', content: 'Second safe guidance.', at: 200,
      snapshot: JSON.stringify({ content: 'First safe guidance.' }),
    });
    expect(db.getActiveEvolutionVersions().filter(item => item.target === 'prompt:learned_guidance'))
      .toEqual([expect.objectContaining({ id: second.evolutionVersionId })]);
    db.recordEvolutionSignal({ userId: 'u', at: 300, type: 'low_quality', criticScore: 0.1 });

    const deps = {
      db,
      store: new SkillStore({ localDir: join(dir, 'skills') }),
      reloadFromDisk: async () => {},
      config: { ...DEFAULT_EVOLUTION_CONFIG, enabled: true, rollbackWindow: 1 },
      now: 400,
    };
    const firstRun = await runRollbackWatchdog(deps);
    expect(firstRun.rolledBack).toEqual(['prompt:learned_guidance']);
    expect(db.getActivePromptOverride('learned_guidance')?.content).toBe('First safe guidance.');
    expect(db.getActiveEvolutionVersion('prompt:learned_guidance')).toBeNull();

    const secondRun = await runRollbackWatchdog({ ...deps, now: 500 });
    expect(secondRun).toEqual({ checked: 0, rolledBack: [] });
    expect(db.getActivePromptOverride('learned_guidance')?.content).toBe('First safe guidance.');
  });

  it('rolls back neither prompt nor ledger when prompt rollback transaction fails', () => {
    const dbPath = join(dir, 'prompt-rollback-failure.db');
    db = new ScallopDatabase(dbPath);
    const promoted = db.promotePromptEvolution({
      fragmentId: 'learned_guidance', content: 'Current guidance.', at: 100, snapshot: null,
    });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TRIGGER fail_prompt_rollback_ledger
      BEFORE UPDATE OF status ON evolution_versions
      WHEN NEW.status = 'rolled_back'
      BEGIN SELECT RAISE(ABORT, 'injected rollback ledger failure'); END;
    `);
    raw.close();

    expect(() => db!.rollbackPromptEvolutionVersion(
      promoted.evolutionVersionId,
      'learned_guidance',
      null,
      200,
    )).toThrow('injected rollback ledger failure');
    expect(db.getActivePromptOverride('learned_guidance')?.content).toBe('Current guidance.');
    expect(db.getActiveEvolutionVersion('prompt:learned_guidance')?.id)
      .toBe(promoted.evolutionVersionId);
  });
});
