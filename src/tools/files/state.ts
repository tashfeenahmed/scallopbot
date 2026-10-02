/**
 * Per-session file-tool state.
 *
 * Remembers, for every session, which files the model has read or written
 * (with the content hash it last saw), which directories it has touched
 * (for project-context hints), and which files were already snapshotted in
 * the current turn (for checkpoints). Small, in-memory, LRU-capped.
 */

import { createHash } from 'crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface FileRecord {
  /** sha256 of the full file bytes the model last saw (read or wrote). */
  hash: string;
  mtimeMs: number;
  size: number;
  /** Ranges ("offset:limit") read at this exact hash. Cleared when the hash changes. */
  ranges: Set<string>;
}

export class SessionFileState {
  readonly files = new Map<string, FileRecord>();
  readonly touchedDirs = new Set<string>();
  readonly shownHints = new Set<string>();
  /** abs path → key of a write_file call that was refused with a hint. */
  readonly pendingOverwrite = new Map<string, string>();
  /** Turn bookkeeping for checkpoints. */
  turnKey: string | undefined;
  turnCheckpointId: string | undefined;
  readonly turnSnapshotted = new Set<string>();
  lastActivityAt = 0;

  private static readonly MAX_FILES = 2000;

  /** Record that the model now knows `hash` for `absPath`. */
  remember(absPath: string, hash: string, mtimeMs: number, size: number, range?: string): void {
    let rec = this.files.get(absPath);
    if (!rec || rec.hash !== hash) {
      rec = { hash, mtimeMs, size, ranges: new Set() };
    } else {
      rec.mtimeMs = mtimeMs;
      rec.size = size;
    }
    if (range) rec.ranges.add(range);
    // Refresh insertion order so the cap evicts the least recently used path.
    this.files.delete(absPath);
    this.files.set(absPath, rec);
    while (this.files.size > SessionFileState.MAX_FILES) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  /**
   * Begin (or continue) a turn. When the key changes, per-turn checkpoint
   * bookkeeping resets so the next write snapshots again.
   */
  enterTurn(turnKey: string): void {
    if (this.turnKey === turnKey) return;
    this.turnKey = turnKey;
    this.turnCheckpointId = undefined;
    this.turnSnapshotted.clear();
  }
}

export class FileStateStore {
  private sessions = new Map<string, SessionFileState>();

  constructor(private readonly maxSessions = 200) {}

  get(sessionId: string): SessionFileState {
    const key = sessionId || 'default';
    let state = this.sessions.get(key);
    if (state) {
      this.sessions.delete(key);
    } else {
      state = new SessionFileState();
    }
    this.sessions.set(key, state);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return state;
  }

  /** Drop everything known about a session. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId || 'default');
  }

  /**
   * Forget what the model has *seen* (read ranges, hints shown) while keeping
   * write/turn bookkeeping. Call after context compaction: the summarized
   * context no longer holds file contents, so "unchanged — don't re-read"
   * would be wrong.
   */
  resetReads(sessionId: string): void {
    const state = this.sessions.get(sessionId || 'default');
    if (!state) return;
    for (const rec of state.files.values()) rec.ranges.clear();
    state.shownHints.clear();
    state.touchedDirs.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Serialize async work per key (used to keep writes to one path ordered). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async runAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const step = (i: number): Promise<T> => (i >= sorted.length ? fn() : this.run(sorted[i], () => step(i + 1)));
    return step(0);
  }
}
