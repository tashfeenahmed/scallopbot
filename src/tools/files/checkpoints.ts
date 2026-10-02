/**
 * Shadow-git checkpoints for file edits.
 *
 * Before the agent first changes a file in a turn, its current bytes are
 * stored as a blob in a private git repository under
 * `${SCALLOPBOT_HOME:-~/.scallopbot}/checkpoints/<hash of workspace>/git`,
 * committed (on refs/heads/checkpoints) so they're never garbage-collected.
 * Only plumbing commands with an explicit --git-dir and a private index are
 * used: the user's own .git, index and work tree are never touched, and
 * user/system git config (hooks, filters, signing) is ignored.
 *
 * `undo` restores a checkpoint, but only files whose current content still
 * equals what the agent last wrote; files changed since (by the user or
 * anything else) are reported and left alone.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from './state.js';

export interface CheckpointFile {
  /** Path relative to the workspace. */
  path: string;
  /** Did the file exist when snapshotted? */
  existed: boolean;
  /** sha256 of the pre-edit bytes (when existed). */
  beforeHash?: string;
  /**
   * sha256 of what the agent left on disk after its last write in this
   * checkpoint; null = the agent deleted it; undefined = unknown (a bash
   * command that never called finalize()).
   */
  agentHash?: string | null;
}

export interface Checkpoint {
  id: string;
  commit: string;
  createdAt: number;
  sessionId?: string;
  turnKey?: string;
  reason: string;
  files: CheckpointFile[];
  undoneAt?: number;
}

export interface RestoreResult {
  checkpoint: Checkpoint;
  restored: string[];
  removed: string[];
  skipped: Array<{ path: string; why: string }>;
}

const MAX_CHECKPOINTS = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIR_FILES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

export function scallopbotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCALLOPBOT_HOME?.trim() || env.SCALLOPBOT_DATA_DIR?.trim() || path.join(os.homedir(), '.scallopbot');
}

interface GitResult { code: number | null; stdout: Buffer; stderr: string }

/** Environment isolated from the user's git config and any inherited repo pointers. */
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function git(gitDir: string, args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=scallopbot', '-c', 'user.email=checkpoints@scallopbot.local',
      `--git-dir=${gitDir}`, ...args,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: gitEnv(extraEnv),
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    child.stdin.on('error', () => undefined);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function gitOk(gitDir: string, args: string[], input?: Buffer | string, env?: Record<string, string>): Promise<string> {
  const r = await git(gitDir, args, input, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.toString('utf8').trim();
}

function rel(workspace: string, abs: string): string | null {
  const r = path.relative(workspace, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

function readMaybe(abs: string): Buffer | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

export class CheckpointStore {
  private queues = new Map<string, Promise<unknown>>();
  private available: boolean | undefined;

  constructor(private readonly home: string = scallopbotHome()) {}

  /** Shadow repo directory for a workspace. */
  dirFor(workspace: string): string {
    let real = path.resolve(workspace);
    try { real = fs.realpathSync(real); } catch { /* keep resolved */ }
    return path.join(this.home, 'checkpoints', sha256(real).slice(0, 16));
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => undefined);
    return next;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    try {
      const r = await git(os.tmpdir(), ['--version']);
      this.available = r.code === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private async ensureRepo(dir: string): Promise<string> {
    const gitDir = path.join(dir, 'git');
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(dir, { recursive: true });
      await gitOk(gitDir, ['init', '--bare', '--quiet', gitDir]);
    }
    return gitDir;
  }

  private manifestPath(dir: string): string {
    return path.join(dir, 'checkpoints.json');
  }

  private loadManifest(dir: string): Checkpoint[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath(dir), 'utf8')) as { checkpoints?: Checkpoint[] };
      return Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [];
    } catch {
      return [];
    }
  }

  private saveManifest(dir: string, checkpoints: Checkpoint[]): void {
    const trimmed = checkpoints.slice(-MAX_CHECKPOINTS);
    const tmp = `${this.manifestPath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, checkpoints: trimmed }, null, 1));
    fs.renameSync(tmp, this.manifestPath(dir));
  }

  /**
   * Snapshot `absPaths` (files; missing ones are recorded as "did not exist").
   * With `addTo`, the files are added to that existing checkpoint instead of
   * creating a new one (same turn). Files already in it are left as they were
   * first captured. Paths outside the workspace are ignored.
   */
  async snapshot(
    workspace: string,
    absPaths: string[],
    meta: { sessionId?: string; turnKey?: string; reason: string; addTo?: string },
  ): Promise<Checkpoint | null> {
    if (!(await this.isAvailable())) return null;
    const ws = path.resolve(workspace);
    const dir = this.dirFor(ws);
    return this.serialize(dir, async () => {
      const gitDir = await this.ensureRepo(dir);
      const checkpoints = this.loadManifest(dir);
      const existing = meta.addTo ? checkpoints.find(c => c.id === meta.addTo) : undefined;
      const already = new Set(existing?.files.map(f => f.path) ?? []);

      const entries: Array<{ relPath: string; data: Buffer | null }> = [];
      for (const abs of absPaths) {
        const r = rel(ws, path.resolve(abs));
        if (!r || already.has(r) || entries.some(e => e.relPath === r)) continue;
        const data = readMaybe(abs);
        if (data && data.length > MAX_FILE_BYTES) continue;
        entries.push({ relPath: r, data });
      }
      if (!entries.length) return existing ?? null;

      const indexFile = path.join(dir, `index.${process.pid}.${Date.now()}`);
      const env = { GIT_INDEX_FILE: indexFile };
      try {
        if (existing) await gitOk(gitDir, ['read-tree', existing.commit], undefined, env);
        const files: CheckpointFile[] = [];
        for (const e of entries) {
          if (e.data) {
            const blob = await gitOk(gitDir, ['hash-object', '-w', '--stdin', '--no-filters'], e.data);
            await gitOk(gitDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${e.relPath}`], undefined, env);
            files.push({ path: e.relPath, existed: true, beforeHash: sha256(e.data) });
          } else {
            files.push({ path: e.relPath, existed: false });
          }
        }
        const tree = await gitOk(gitDir, ['write-tree'], undefined, env);
        const parentRef = await git(gitDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/checkpoints']);
        const parentArgs = parentRef.code === 0 ? ['-p', parentRef.stdout.toString().trim()] : [];
        const message = `${meta.reason} ${files.map(f => f.path).join(' ')}`.slice(0, 500);
        const commit = await gitOk(gitDir, ['commit-tree', tree, ...parentArgs], message);
        await gitOk(gitDir, ['update-ref', 'refs/heads/checkpoints', commit]);

        let cp: Checkpoint;
        if (existing) {
          existing.commit = commit;
          existing.files.push(...files);
          cp = existing;
        } else {
          cp = {
            id: `cp-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`,
            commit,
            createdAt: Date.now(),
            sessionId: meta.sessionId,
            turnKey: meta.turnKey,
            reason: meta.reason,
            files,
          };
          checkpoints.push(cp);
        }
        this.saveManifest(dir, checkpoints);
        return cp;
      } finally {
        try { fs.rmSync(indexFile, { force: true }); } catch { /* ignore */ }
      }
    });
  }

  /** Record what the agent left on disk for a file (null = deleted). */
  async recordAgentWrite(workspace: string, checkpointId: string, absPath: string, content: Buffer | string | null): Promise<void> {
    const ws = path.resolve(workspace);
    const dir = this.dirFor(ws);
    const r = rel(ws, path.resolve(absPath));
    if (!r) return;
    await this.serialize(dir, async () => {
      const checkpoints = this.loadManifest(dir);
      const cp = checkpoints.find(c => c.id === checkpointId);
      const f = cp?.files.find(x => x.path === r);
      if (!cp || !f) return;
      f.agentHash = content === null ? null : sha256(content);
      this.saveManifest(dir, checkpoints);
    });
  }

  async list(workspace: string, limit = 10): Promise<Checkpoint[]> {
    const dir = this.dirFor(path.resolve(workspace));
    return this.loadManifest(dir).slice(-limit).reverse();
  }

  /**
   * Restore a checkpoint. Without an id: the newest not-yet-undone
   * checkpoint of `sessionId` (falling back to the newest overall).
   */
  async restore(workspace: string, opts: { id?: string; sessionId?: string } = {}): Promise<RestoreResult | { error: string }> {
    const ws = path.resolve(workspace);
    const dir = this.dirFor(ws);
    return this.serialize(dir, async () => {
      const checkpoints = this.loadManifest(dir);
      if (!checkpoints.length) return { error: 'No checkpoints exist for this workspace yet — nothing to undo.' };
      let cp: Checkpoint | undefined;
      if (opts.id) {
        cp = checkpoints.find(c => c.id === opts.id || c.commit.startsWith(opts.id!));
        if (!cp) return { error: `No checkpoint "${opts.id}". Call undo with list: true to see the available ids.` };
      } else {
        const open = checkpoints.filter(c => !c.undoneAt);
        cp = [...open].reverse().find(c => c.sessionId && c.sessionId === opts.sessionId) ?? open[open.length - 1];
        if (!cp) return { error: 'Every checkpoint has already been undone. Call undo with list: true to pick one explicitly.' };
      }
      const gitDir = path.join(dir, 'git');
      const result: RestoreResult = { checkpoint: cp, restored: [], removed: [], skipped: [] };
      for (const f of cp.files) {
        const abs = path.join(ws, ...f.path.split('/'));
        const current = readMaybe(abs);
        const currentHash = current ? sha256(current) : null;
        if (f.agentHash !== undefined && currentHash !== f.agentHash) {
          result.skipped.push({ path: f.path, why: current ? 'changed since the agent wrote it' : 'deleted since the agent wrote it' });
          continue;
        }
        try {
          if (f.existed) {
            const r = await git(gitDir, ['cat-file', 'blob', `${cp.commit}:${f.path}`]);
            if (r.code !== 0) {
              result.skipped.push({ path: f.path, why: 'snapshot missing from the checkpoint store' });
              continue;
            }
            if (currentHash === f.beforeHash) continue; // already at the checkpoint state
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, r.stdout);
            result.restored.push(f.path);
          } else if (current) {
            fs.rmSync(abs, { force: true });
            result.removed.push(f.path);
          }
        } catch (e) {
          result.skipped.push({ path: f.path, why: (e as Error).message });
        }
      }
      cp.undoneAt = Date.now();
      this.saveManifest(dir, checkpoints);
      return result;
    });
  }
}

let defaultStore: CheckpointStore | undefined;

/** The process-wide store (SCALLOPBOT_HOME at first use). */
export function defaultCheckpointStore(): CheckpointStore {
  if (!defaultStore) defaultStore = new CheckpointStore();
  return defaultStore;
}

function expandPaths(workspace: string, paths: string[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  const visit = (abs: string) => {
    if (out.length >= MAX_DIR_FILES || bytes > MAX_TOTAL_BYTES) return;
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { out.push(abs); return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(abs))) return;
      let names: string[] = [];
      try { names = fs.readdirSync(abs); } catch { return; }
      for (const n of names) visit(path.join(abs, n));
    } else if (st.isFile()) {
      bytes += st.size;
      out.push(abs);
    }
  };
  for (const p of paths) visit(path.resolve(workspace, p));
  return out;
}

/**
 * For the shell tool: snapshot files (or whole directories) a destructive
 * command is about to touch. Call `finalize()` after the command so undo
 * knows what the agent left behind; without it, undo restores those files
 * unconditionally. Returns null when nothing could be snapshotted.
 */
export async function checkpointBeforeDestructive(
  workspace: string,
  paths: string[],
  opts: { sessionId?: string; reason?: string; store?: CheckpointStore } = {},
): Promise<{ id: string; files: string[]; finalize: () => Promise<void> } | null> {
  const store = opts.store ?? defaultCheckpointStore();
  try {
    const files = expandPaths(workspace, paths);
    if (!files.length) return null;
    const cp = await store.snapshot(workspace, files, { sessionId: opts.sessionId, reason: opts.reason ?? 'bash' });
    if (!cp) return null;
    return {
      id: cp.id,
      files: cp.files.map(f => f.path),
      finalize: async () => {
        for (const abs of files) {
          const data = readMaybe(abs);
          await store.recordAgentWrite(workspace, cp.id, abs, data);
        }
      },
    };
  } catch {
    return null;
  }
}
