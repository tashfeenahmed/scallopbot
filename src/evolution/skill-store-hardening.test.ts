import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillStore, type PromotionPhase } from './skill-store.js';

const execFileAsync = promisify(execFile);
const PRE_COMMIT_PHASES: PromotionPhase[] = [
  'prepared',
  'old_moved_before_journal',
  'old_moved',
  'new_live_before_journal',
  'new_live',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function onlyEntries(path: string): Promise<string[]> {
  if (!(await exists(path))) return [];
  return (await readdir(path)).sort();
}

interface SeedJournalOptions {
  state: 'prepared' | 'old_moved' | 'new_live' | 'committed';
  operation?: 'promote' | 'rollback';
  desiredPresent?: boolean;
  cleanupStaged?: boolean;
  hadLive?: boolean;
  live?: string;
  prepared?: string;
  previous?: string;
  staged?: string;
}

async function seedJournal(localDir: string, options: SeedJournalOptions): Promise<void> {
  const name = 'recoverable';
  const transactionId = 'crash_tx';
  const transaction = join(localDir, '.promotion_transactions', `${name}.${transactionId}`);
  await mkdir(transaction, { recursive: true, mode: 0o700 });
  if (options.live !== undefined) {
    await mkdir(join(localDir, name), { recursive: true });
    await writeFile(join(localDir, name, 'SKILL.md'), options.live);
  }
  if (options.prepared !== undefined) {
    await mkdir(join(transaction, 'new'), { recursive: true });
    await writeFile(join(transaction, 'new', 'SKILL.md'), options.prepared);
  }
  if (options.previous !== undefined) {
    await mkdir(join(transaction, 'old'), { recursive: true });
    await writeFile(join(transaction, 'old', 'SKILL.md'), options.previous);
  }
  if (options.staged !== undefined) {
    await mkdir(join(localDir, '.proposed', name), { recursive: true });
    await writeFile(join(localDir, '.proposed', name, 'SKILL.md'), options.staged);
  }

  const operation = options.operation ?? 'promote';
  await mkdir(join(localDir, '.promotion_journals'), { recursive: true, mode: 0o700 });
  await writeFile(join(localDir, '.promotion_journals', `${name}.json`), `${JSON.stringify({
    version: 1,
    name,
    transactionId,
    ownerPid: 2_147_483_647,
    ownerToken: 'dead_owner',
    state: options.state,
    hadLive: options.hadLive ?? true,
    operation,
    desiredPresent: options.desiredPresent ?? true,
    cleanupStaged: options.cleanupStaged ?? operation === 'promote',
    createdAt: 1,
  })}\n`, { mode: 0o600 });
}

describe('SkillStore failure-atomic replacement', () => {
  let root: string;
  let localDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-atomic-'));
    localDir = join(root, 'skills');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function install(version: string): Promise<void> {
    const store = new SkillStore({ localDir });
    await store.stage('atomic', { 'SKILL.md': version });
    await store.promote('atomic');
  }

  it.each(PRE_COMMIT_PHASES)('restores the old skill when promotion fails at %s', async phase => {
    await install('v1');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'v2' });
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => `promote_${phase}`,
      promotionPhaseHook: current => {
        if (current === phase) throw new Error(`fault:${phase}`);
      },
    });

    await expect(store.promote('atomic')).rejects.toThrow(`fault:${phase}`);
    expect(await readFile(join(localDir, 'atomic', 'SKILL.md'), 'utf-8')).toBe('v1');
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('v2');
    expect(await onlyEntries(join(localDir, '.promotion_journals'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_transactions'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_locks'))).toEqual([]);
  });

  it('rolls a failed first promotion back to absence', async () => {
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'first version' });
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => 'first_promotion',
      promotionPhaseHook: phase => {
        if (phase === 'new_live') throw new Error('fail after live rename');
      },
    });

    await expect(store.promote('atomic')).rejects.toThrow('fail after live rename');
    expect(await store.snapshotLive('atomic')).toBeNull();
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('first version');
  });

  it('finishes a durably committed promotion when later cleanup faults', async () => {
    await install('v1');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'v2' });
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => 'commit_cleanup',
      promotionPhaseHook: phase => {
        if (phase === 'committed') throw new Error('cleanup fault');
      },
    });

    await expect(store.promote('atomic')).resolves.toBeUndefined();
    expect(await readFile(join(localDir, 'atomic', 'SKILL.md'), 'utf-8')).toBe('v2');
    expect(await exists(join(localDir, '.proposed', 'atomic'))).toBe(false);
  });

  it('creates owner-only transaction metadata before the first live rename', async () => {
    await install('v1');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'v2' });
    let observed: Record<string, number> = {};
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => 'mode_check',
      promotionPhaseHook: async phase => {
        if (phase !== 'prepared') return;
        observed = {
          journalDirectory: (await stat(join(localDir, '.promotion_journals'))).mode & 0o777,
          journal: (await stat(join(localDir, '.promotion_journals', 'atomic.json'))).mode & 0o777,
          transactionDirectory: (await stat(join(localDir, '.promotion_transactions', 'atomic.mode_check'))).mode & 0o777,
          lock: (await stat(join(localDir, '.promotion_locks', 'atomic.lock'))).mode & 0o777,
        };
        throw new Error('stop after inspection');
      },
    });

    await expect(store.promote('atomic')).rejects.toThrow('stop after inspection');
    expect(observed).toEqual({
      journalDirectory: 0o700,
      journal: 0o600,
      transactionDirectory: 0o700,
      lock: 0o600,
    });
  });

  it.each(PRE_COMMIT_PHASES)('restores the current skill when snapshot rollback fails at %s', async phase => {
    await install('v2');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'unrelated proposal' });
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => `rollback_${phase}`,
      promotionPhaseHook: current => {
        if (current === phase) throw new Error(`rollback fault:${phase}`);
      },
    });

    await expect(store.rollback('atomic', { 'SKILL.md': 'v1' })).rejects.toThrow(`rollback fault:${phase}`);
    expect(await readFile(join(localDir, 'atomic', 'SKILL.md'), 'utf-8')).toBe('v2');
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('unrelated proposal');
  });

  it.each(PRE_COMMIT_PHASES)('restores the current skill when null rollback fails at %s', async phase => {
    await install('v2');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'unrelated proposal' });
    const store = new SkillStore({
      localDir,
      transactionIdFactory: () => `null_${phase}`,
      promotionPhaseHook: current => {
        if (current === phase) throw new Error(`null rollback fault:${phase}`);
      },
    });

    await expect(store.rollback('atomic', null)).rejects.toThrow(`null rollback fault:${phase}`);
    expect(await readFile(join(localDir, 'atomic', 'SKILL.md'), 'utf-8')).toBe('v2');
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('unrelated proposal');
  });

  it('commits snapshot and null rollbacks without touching staging, and null rollback is idempotent', async () => {
    await install('v2');
    const setup = new SkillStore({ localDir });
    await setup.stage('atomic', { 'SKILL.md': 'unrelated proposal' });
    const committedFault = new SkillStore({
      localDir,
      transactionIdFactory: () => 'rollback_commit',
      promotionPhaseHook: phase => {
        if (phase === 'committed') throw new Error('post-commit rollback fault');
      },
    });

    await expect(committedFault.rollback('atomic', { 'SKILL.md': 'v1' })).resolves.toBeUndefined();
    expect(await readFile(join(localDir, 'atomic', 'SKILL.md'), 'utf-8')).toBe('v1');
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('unrelated proposal');

    const store = new SkillStore({ localDir });
    await store.rollback('atomic', null);
    await store.rollback('atomic', null);
    expect(await store.snapshotLive('atomic')).toBeNull();
    expect(await readFile(join(localDir, '.proposed', 'atomic', 'SKILL.md'), 'utf-8')).toBe('unrelated proposal');
  });
});

describe('SkillStore crash recovery', () => {
  let root: string;
  let localDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-recovery-'));
    localDir = join(root, 'skills');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['prepared', undefined, 'v2'],
    ['old_moved', undefined, 'v2'],
    ['new_live', 'v2', undefined],
  ] as const)('recovers a physically interrupted %s transaction to the old tree', async (state, live, prepared) => {
    await seedJournal(localDir, { state, live, prepared, previous: 'v1', staged: 'v2' });
    const store = new SkillStore({ localDir });

    await store.recoverPendingPromotions();
    expect(await readFile(join(localDir, 'recoverable', 'SKILL.md'), 'utf-8')).toBe('v1');
    expect(await readFile(join(localDir, '.proposed', 'recoverable', 'SKILL.md'), 'utf-8')).toBe('v2');
    expect(await onlyEntries(join(localDir, '.promotion_journals'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_transactions'))).toEqual([]);
  });

  it('finalizes a committed promotion and removes only its staged proposal', async () => {
    await seedJournal(localDir, { state: 'committed', live: 'v2', previous: 'v1', staged: 'v2' });
    const store = new SkillStore({ localDir });

    // Public reads recover first as defense in depth, even if startup forgot the
    // explicit recoverPendingPromotions() call.
    expect((await store.snapshotLive('recoverable'))?.['SKILL.md']).toBe('v2');
    expect(await exists(join(localDir, '.proposed', 'recoverable'))).toBe(false);
    expect(await onlyEntries(join(localDir, '.promotion_journals'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_transactions'))).toEqual([]);
  });

  it('cleans individually valid near-limit old and new transaction trees', async () => {
    await seedJournal(localDir, {
      state: 'committed',
      live: 'v2',
      prepared: 'v2',
      previous: 'v1',
      staged: 'v2',
    });
    const transaction = join(localDir, '.promotion_transactions', 'recoverable.crash_tx');
    await writeFile(join(localDir, 'recoverable', 'note.txt'), 'n2');
    await writeFile(join(transaction, 'new', 'note.txt'), 'n2');
    await writeFile(join(transaction, 'old', 'note.txt'), 'n1');
    const store = new SkillStore({
      localDir,
      limits: { maxFiles: 2, maxFileBytes: 2, maxTotalBytes: 4 },
    });

    await store.recoverPendingPromotions();
    expect((await store.snapshotLive('recoverable'))?.['SKILL.md']).toBe('v2');
    expect(await onlyEntries(join(localDir, '.promotion_transactions'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_journals'))).toEqual([]);
  });

  it('finalizes a committed null rollback while preserving unrelated staging', async () => {
    await seedJournal(localDir, {
      state: 'committed',
      operation: 'rollback',
      desiredPresent: false,
      cleanupStaged: false,
      previous: 'v1',
      staged: 'future proposal',
    });
    const store = new SkillStore({ localDir });

    await store.recoverPendingPromotions();
    expect(await store.snapshotLive('recoverable')).toBeNull();
    expect(await readFile(join(localDir, '.proposed', 'recoverable', 'SKILL.md'), 'utf-8')).toBe('future proposal');
    expect(await onlyEntries(join(localDir, '.promotion_journals'))).toEqual([]);
    expect(await onlyEntries(join(localDir, '.promotion_transactions'))).toEqual([]);
  });
});

describe('SkillStore filesystem boundary hardening', () => {
  let root: string;
  let localDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-security-'));
    localDir = join(root, 'skills');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects symlinks during reads, snapshots, and promotion without exposing their target', async () => {
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'outside secret');
    const looseTree = join(root, 'loose-tree');
    await mkdir(looseTree);
    await symlink(secret, join(looseTree, 'SKILL.md'));
    const store = new SkillStore({ localDir });
    await expect(store.readDir(looseTree)).rejects.toThrow(/Symlink rejected/);

    await mkdir(join(localDir, 'snapshot'), { recursive: true });
    await symlink(secret, join(localDir, 'snapshot', 'SKILL.md'));
    await expect(store.snapshotLive('snapshot')).rejects.toThrow(/Symlink rejected/);

    const setup = new SkillStore({ localDir });
    await setup.stage('promoted', { 'SKILL.md': 'safe old' });
    await setup.promote('promoted');
    await setup.stage('promoted', { 'SKILL.md': 'candidate', 'scripts/run.ts': 'safe' });
    await symlink(secret, join(localDir, '.proposed', 'promoted', 'scripts', 'secret.txt'));
    await expect(new SkillStore({ localDir }).promote('promoted')).rejects.toThrow(/Symlink rejected/);
    expect(await readFile(join(localDir, 'promoted', 'SKILL.md'), 'utf-8')).toBe('safe old');
  });

  it('rejects a hard link to an outside file where hard links are supported', async () => {
    const secret = join(root, 'secret.txt');
    const tree = join(root, 'hardlink-tree');
    await writeFile(secret, 'outside secret');
    await chmod(secret, 0o600);
    await mkdir(tree);
    try {
      await link(secret, join(tree, 'SKILL.md'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }

    await expect(new SkillStore({ localDir }).readDir(tree)).rejects.toThrow(/Hard-linked file rejected/);
  });

  it('rejects FIFOs and other non-regular entries', async () => {
    if (process.platform === 'win32') return;
    const tree = join(root, 'fifo-tree');
    await mkdir(tree);
    await writeFile(join(tree, 'SKILL.md'), 'safe');
    await execFileAsync('mkfifo', [join(tree, 'input.pipe')]);

    await expect(new SkillStore({ localDir }).readDir(tree)).rejects.toThrow(/Non-regular file rejected/);
  });

  it('validates paths and all write bounds before creating staging state', async () => {
    const cases: Array<{ name: string; files: Record<string, string>; error: RegExp }> = [
      { name: 'too-many', files: { 'SKILL.md': 'a', 'a.txt': 'b', 'b.txt': 'c' }, error: /file-count limit/ },
      { name: 'too-large', files: { 'SKILL.md': '123456' }, error: /per-file byte limit/ },
      { name: 'too-total', files: { 'SKILL.md': '12345', 'a.txt': '1234' }, error: /total-byte limit/ },
      { name: 'bad-path', files: { 'SKILL.md': 'safe', '../secret': 'x' }, error: /Unsafe skill file path/ },
    ];

    for (const testCase of cases) {
      const caseLocalDir = join(root, testCase.name);
      const store = new SkillStore({
        localDir: caseLocalDir,
        limits: { maxFiles: 2, maxFileBytes: 5, maxTotalBytes: 8 },
      });
      await expect(store.stage('bounded', testCase.files)).rejects.toThrow(testCase.error);
      expect(await exists(caseLocalDir)).toBe(false);
    }
  });

  it('enforces file-count, per-file, and total-byte bounds on existing trees', async () => {
    const store = new SkillStore({
      localDir,
      limits: { maxFiles: 2, maxFileBytes: 5, maxTotalBytes: 8 },
    });
    const tooMany = join(root, 'read-too-many');
    await mkdir(tooMany);
    await Promise.all(['a', 'b', 'c'].map(name => writeFile(join(tooMany, name), 'x')));
    await expect(store.readDir(tooMany)).rejects.toThrow(/file-count limit/);

    const tooLarge = join(root, 'read-too-large');
    await mkdir(tooLarge);
    await writeFile(join(tooLarge, 'SKILL.md'), '123456');
    await expect(store.readDir(tooLarge)).rejects.toThrow(/per-file byte limit/);

    const tooTotal = join(root, 'read-too-total');
    await mkdir(tooTotal);
    await writeFile(join(tooTotal, 'SKILL.md'), '12345');
    await writeFile(join(tooTotal, 'a.txt'), '1234');
    await expect(store.readDir(tooTotal)).rejects.toThrow(/total-byte limit/);
  });

  it('fails curator backup closed on an unsafe tree and leaves the live skill untouched', async () => {
    const store = new SkillStore({ localDir });
    await store.stage('curated', { 'SKILL.md': 'live procedure' });
    await store.promote('curated');
    await store.markAgentCreated('curated', 'create', 0);
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'outside secret');
    await symlink(secret, join(localDir, 'curated', 'secret.txt'));

    await expect(store.curate({
      now: 365 * 24 * 60 * 60 * 1000,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      backupKeep: 3,
    })).rejects.toThrow(/Symlink rejected/);
    expect(await readFile(join(localDir, 'curated', 'SKILL.md'), 'utf-8')).toBe('live procedure');
    expect(await exists(join(localDir, '.curator_backups'))).toBe(false);
    expect(await exists(join(localDir, '.archive', 'curated'))).toBe(false);
  });

  it('bounds curator backups across the complete set of agent-created skills', async () => {
    const store = new SkillStore({
      localDir,
      limits: { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 1_000 },
    });
    for (const name of ['first', 'second']) {
      await store.stage(name, { 'SKILL.md': name, 'notes.txt': 'notes' });
      await store.promote(name);
      await store.markAgentCreated(name, 'create', 0);
    }

    await expect(store.curate({
      now: 365 * 24 * 60 * 60 * 1000,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      backupKeep: 3,
    })).rejects.toThrow(/Curator backup exceeds file-count limit/);
    expect(await exists(join(localDir, '.curator_backups'))).toBe(false);
    expect(await readFile(join(localDir, 'first', 'SKILL.md'), 'utf-8')).toBe('first');
    expect(await readFile(join(localDir, 'second', 'SKILL.md'), 'utf-8')).toBe('second');
  });
});
