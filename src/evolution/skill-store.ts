/**
 * Self-evolution skill file store.
 *
 * Handles the on-disk lifecycle of machine-authored skills, all within the LOCAL
 * skills dir (~/.scallopbot/skills/). Because local skills shadow bundled ones
 * (workspace > local > bundled, first name wins) and the loader only scans one
 * level deep, this gives us:
 *   - staging:   write to <skills>/.proposed/<name>/  (never loaded as live)
 *   - promote:   move .proposed/<name>/ -> <skills>/<name>/  (shadows bundled)
 *   - snapshot:  capture the prior live <name>/ before promoting (for rollback)
 *   - rollback:  restore the snapshot, or delete the override if there was none
 *
 * A skill is represented as a flat map of relative path -> file content, e.g.
 *   { 'SKILL.md': '...', 'scripts/run.ts': '...' }
 */

import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join, dirname, relative, sep, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { Logger } from 'pino';

export type SkillFiles = Record<string, string>;

const DEFAULT_LOCAL_DIR = join(homedir(), '.scallopbot', 'skills');
const PROPOSED_DIR_NAME = '.proposed';
const USAGE_FILE_NAME = '.usage.json';
const ARCHIVE_DIR_NAME = '.archive';
const BACKUP_DIR_NAME = '.curator_backups';
const PROMOTION_JOURNAL_DIR_NAME = '.promotion_journals';
const PROMOTION_TRANSACTION_DIR_NAME = '.promotion_transactions';
const PROMOTION_LOCK_DIR_NAME = '.promotion_locks';
const SAFE_SKILL_NAME = /^[a-z][a-z0-9_-]{0,127}$/;
const SAFE_TRANSACTION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const JOURNAL_VERSION = 1;

export interface SkillStoreLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: SkillStoreLimits = {
  maxFiles: 128,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
};

export type PromotionPhase =
  | 'prepared'
  | 'old_moved_before_journal'
  | 'old_moved'
  | 'new_live_before_journal'
  | 'new_live'
  | 'committed';

type PromotionJournalState = 'prepared' | 'old_moved' | 'new_live' | 'committed';

interface PromotionJournal {
  version: typeof JOURNAL_VERSION;
  name: string;
  transactionId: string;
  ownerPid: number;
  ownerToken: string;
  state: PromotionJournalState;
  hadLive: boolean;
  operation: 'promote' | 'rollback';
  desiredPresent: boolean;
  cleanupStaged: boolean;
  createdAt: number;
}

interface PromotionPaths {
  journal: string;
  lock: string;
  transaction: string;
  prepared: string;
  previous: string;
  discarded: string;
  live: string;
  staged: string;
}

export interface SkillStoreOptions {
  localDir?: string;
  logger?: Logger;
  limits?: Partial<SkillStoreLimits>;
  /** Deterministic fault injection for filesystem phase tests. */
  promotionPhaseHook?: (phase: PromotionPhase, name: string) => void | Promise<void>;
  /** Deterministic transaction IDs for tests. */
  transactionIdFactory?: () => string;
}

export type SkillLifecycleState = 'active' | 'stale' | 'archived';

export interface SkillUsageEntry {
  useCount: number;
  patchCount: number;
  createdAt: number;
  lastUsedAt: number | null;
  lastPatchedAt: number | null;
  state: SkillLifecycleState;
  pinned: boolean;
  archivedAt: number | null;
  createdBy: 'agent' | 'user' | null;
}

export interface CuratorSummary {
  stale: string[];
  archived: string[];
  skippedPinned: string[];
  backupPath?: string;
}

export class SkillStore {
  private readonly localDir: string;
  private readonly proposedDir: string;
  private readonly usagePath: string;
  private readonly archiveDir: string;
  private readonly backupDir: string;
  private readonly journalDir: string;
  private readonly transactionDir: string;
  private readonly lockDir: string;
  private readonly logger?: Logger;
  private readonly limits: SkillStoreLimits;
  private readonly promotionPhaseHook?: SkillStoreOptions['promotionPhaseHook'];
  private readonly transactionIdFactory: () => string;
  private usageQueue: Promise<unknown> = Promise.resolve();
  private recoveryPromise: Promise<void> | undefined;

  constructor(opts: SkillStoreOptions = {}) {
    this.localDir = opts.localDir ?? DEFAULT_LOCAL_DIR;
    this.proposedDir = join(this.localDir, PROPOSED_DIR_NAME);
    this.usagePath = join(this.localDir, USAGE_FILE_NAME);
    this.archiveDir = join(this.localDir, ARCHIVE_DIR_NAME);
    this.backupDir = join(this.localDir, BACKUP_DIR_NAME);
    this.journalDir = join(this.localDir, PROMOTION_JOURNAL_DIR_NAME);
    this.transactionDir = join(this.localDir, PROMOTION_TRANSACTION_DIR_NAME);
    this.lockDir = join(this.localDir, PROMOTION_LOCK_DIR_NAME);
    this.logger = opts.logger;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.assertSafeLimits(this.limits);
    this.promotionPhaseHook = opts.promotionPhaseHook;
    this.transactionIdFactory = opts.transactionIdFactory ?? randomUUID;
  }

  /** Absolute path to a skill's live directory. */
  liveDir(name: string): string {
    this.assertSafeSkillName(name);
    return join(this.localDir, name);
  }

  /** Absolute path to a skill's staged (proposed) directory. */
  stagedDir(name: string): string {
    this.assertSafeSkillName(name);
    return join(this.proposedDir, name);
  }

  /** Write a candidate skill to the staging area. Returns the staged SKILL.md path. */
  async stage(name: string, files: SkillFiles): Promise<string> {
    this.assertSafeSkillName(name);
    this.validateSkillFiles(files);
    await this.ensureRecovered();
    const dir = this.stagedDir(name);
    await this.removeTreeIfPresent(dir);
    await this.writeFiles(dir, files);
    return join(dir, 'SKILL.md');
  }

  /**
   * Read a bounded regular-file tree without following symlinks. Missing roots
   * return an empty map; unsafe or non-regular entries fail closed.
   */
  async readDir(dir: string): Promise<SkillFiles> {
    await this.ensureRecovered();
    return this.readTreeSecure(dir);
  }

  /** Snapshot the current LIVE skill (local override), or null if none exists. */
  async snapshotLive(name: string): Promise<SkillFiles | null> {
    this.assertSafeSkillName(name);
    await this.ensureRecovered();
    const dir = this.liveDir(name);
    if (!(await this.directoryExists(dir))) return null;
    const files = await this.readTreeSecure(dir);
    return Object.keys(files).length > 0 ? files : null;
  }

  /**
   * Recover interrupted promotion journals. Gateway must await this before the
   * local SkillRegistry scans localDir; all store operations also call it lazily
   * as defense in depth.
   */
  async recoverPendingPromotions(): Promise<void> {
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.performRecovery().catch(error => {
        this.recoveryPromise = undefined;
        throw error;
      });
    }
    await this.recoveryPromise;
  }

  /** Promote a staged skill through a durable, failure-atomic directory swap. */
  async promote(name: string): Promise<void> {
    this.assertSafeSkillName(name);
    await this.ensureRecovered();
    const staged = this.stagedDir(name);
    const files = await this.readTreeSecure(staged);
    if (Object.keys(files).length === 0) {
      throw new Error(`No staged files for skill '${name}'`);
    }
    this.validateSkillFiles(files);
    await this.replaceLiveAtomically(name, files, { operation: 'promote', cleanupStaged: true });
  }

  /** Discard a staged proposal without promoting. */
  async discardStaged(name: string): Promise<void> {
    this.assertSafeSkillName(name);
    await this.ensureRecovered();
    await this.removeTreeIfPresent(this.stagedDir(name));
  }

  /**
   * Roll a target back to its snapshot. If snapshot is null the target did not
   * exist before promotion, so rollback deletes the live override entirely.
   */
  async rollback(name: string, snapshot: SkillFiles | null): Promise<void> {
    this.assertSafeSkillName(name);
    if (snapshot) this.validateSkillFiles(snapshot);
    await this.ensureRecovered();
    await this.replaceLiveAtomically(
      name,
      snapshot && Object.keys(snapshot).length > 0 ? snapshot : null,
      { operation: 'rollback', cleanupStaged: false },
    );
  }

  /** Mark a promoted artifact as machine-authored procedural memory. */
  async markAgentCreated(name: string, action: 'create' | 'patch', now = Date.now()): Promise<void> {
    this.assertSafeSkillName(name);
    await this.mutateUsage(async usage => {
      const hadEntry = Object.prototype.hasOwnProperty.call(usage, name);
      const entry = hadEntry ? usage[name] : this.newUsageEntry(now);
      // A background-created skill is curator-owned. Patching an existing
      // hand-authored skill must not silently transfer ownership to the curator.
      if (action === 'create' || (hadEntry && entry.createdBy === 'agent')) {
        entry.createdBy = 'agent';
      }
      entry.state = 'active';
      entry.archivedAt = null;
      if (action === 'patch') {
        entry.patchCount += 1;
        entry.lastPatchedAt = now;
      }
      usage[name] = entry;
    });
  }

  /** Record that a skill was selected and executed. */
  async recordUse(name: string, now = Date.now()): Promise<void> {
    this.assertSafeSkillName(name);
    await this.mutateUsage(async usage => {
      const entry = Object.prototype.hasOwnProperty.call(usage, name)
        ? usage[name]
        : this.newUsageEntry(now);
      entry.useCount += 1;
      entry.lastUsedAt = now;
      entry.state = 'active';
      entry.archivedAt = null;
      usage[name] = entry;
    });
  }

  async getUsage(): Promise<Record<string, SkillUsageEntry>> {
    await this.usageQueue;
    return this.readUsage();
  }

  async pin(name: string, pinned = true): Promise<boolean> {
    this.assertSafeSkillName(name);
    let found = false;
    await this.mutateUsage(async usage => {
      const entry = Object.prototype.hasOwnProperty.call(usage, name) ? usage[name] : undefined;
      if (!entry || entry.createdBy !== 'agent') return;
      entry.pinned = pinned;
      found = true;
    });
    return found;
  }

  /**
   * Deterministic curator for agent-created skills. It never deletes: unused
   * skills are moved to a recoverable archive after a pre-run backup.
   */
  async curate(options: {
    now?: number;
    staleAfterDays: number;
    archiveAfterDays: number;
    backupKeep: number;
  }): Promise<CuratorSummary> {
    await this.ensureRecovered();
    const now = options.now ?? Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const summary: CuratorSummary = { stale: [], archived: [], skippedPinned: [] };

    await this.mutateUsage(async usage => {
      const toArchive: string[] = [];
      for (const [name, entry] of Object.entries(usage)) {
        this.assertSafeSkillName(name);
        if (entry.createdBy !== 'agent' || entry.state === 'archived') continue;
        if (entry.pinned) {
          summary.skippedPinned.push(name);
          continue;
        }
        const activityAt = Math.max(entry.createdAt, entry.lastUsedAt ?? 0, entry.lastPatchedAt ?? 0);
        const idleDays = (now - activityAt) / dayMs;
        if (idleDays >= options.archiveAfterDays) {
          toArchive.push(name);
        } else if (idleDays >= options.staleAfterDays && entry.state !== 'stale') {
          entry.state = 'stale';
          summary.stale.push(name);
        }
      }

      if (toArchive.length > 0) {
        summary.backupPath = await this.createBackup(usage, now, options.backupKeep);
      }
      for (const name of toArchive) {
        const source = this.liveDir(name);
        if (!(await this.directoryExists(source))) continue;
        await this.readTreeSecure(source);
        await this.createPrivateDirectory(this.archiveDir);
        const destination = join(this.archiveDir, name);
        await this.removeTreeIfPresent(destination);
        await rename(source, destination);
        usage[name].state = 'archived';
        usage[name].archivedAt = now;
        summary.archived.push(name);
      }
    });
    return summary;
  }

  /** Restore one recoverably archived agent-created skill. */
  async restoreArchived(name: string, now = Date.now()): Promise<boolean> {
    this.assertSafeSkillName(name);
    await this.ensureRecovered();
    let restored = false;
    await this.mutateUsage(async usage => {
      const entry = Object.prototype.hasOwnProperty.call(usage, name) ? usage[name] : undefined;
      const source = join(this.archiveDir, name);
      if (!entry || entry.createdBy !== 'agent' || !(await this.directoryExists(source))) return;
      await this.readTreeSecure(source);
      const destination = this.liveDir(name);
      if (await this.directoryExists(destination)) throw new Error(`Cannot restore '${name}': live skill already exists`);
      await rename(source, destination);
      entry.state = 'active';
      entry.archivedAt = null;
      entry.lastUsedAt = now;
      restored = true;
    });
    return restored;
  }

  private newUsageEntry(now: number): SkillUsageEntry {
    return {
      useCount: 0,
      patchCount: 0,
      createdAt: now,
      lastUsedAt: null,
      lastPatchedAt: null,
      state: 'active',
      pinned: false,
      archivedAt: null,
      createdBy: null,
    };
  }

  private async readUsage(): Promise<Record<string, SkillUsageEntry>> {
    try {
      const text = await this.readRegularFileNoFollow(this.usagePath, this.metadataByteLimit());
      const parsed = JSON.parse(text) as Record<string, SkillUsageEntry>;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (!this.isNotFound(error) && !(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  private async writeUsage(usage: Record<string, SkillUsageEntry>): Promise<void> {
    const content = `${JSON.stringify(usage, null, 2)}\n`;
    if (Buffer.byteLength(content) > this.metadataByteLimit()) {
      throw new Error(`Skill usage metadata exceeds byte limit (${this.metadataByteLimit()})`);
    }
    await this.writeOwnerFileAtomic(this.usagePath, content);
  }

  private metadataByteLimit(): number {
    // Test/deployment skill-file limits may be intentionally tiny; bookkeeping
    // still needs a bounded but usable envelope independent of one skill file.
    return Math.max(DEFAULT_LIMITS.maxFileBytes, this.limits.maxFileBytes);
  }

  private async mutateUsage<T>(operation: (usage: Record<string, SkillUsageEntry>) => Promise<T>): Promise<T> {
    const run = this.usageQueue.then(async () => {
      const usage = await this.readUsage();
      const result = await operation(usage);
      await this.writeUsage(usage);
      return result;
    });
    this.usageQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async createBackup(
    usage: Record<string, SkillUsageEntry>,
    now: number,
    keep: number,
  ): Promise<string> {
    const usageContent = `${JSON.stringify(usage, null, 2)}\n`;
    if (Buffer.byteLength(usageContent) > this.metadataByteLimit()) {
      throw new Error(`Curator backup metadata exceeds byte limit (${this.metadataByteLimit()})`);
    }
    const trees: Array<{ name: string; files: SkillFiles }> = [];
    let fileCount = 0;
    let totalBytes = 0;
    // Validate every persisted name before creating or pruning any backup path.
    for (const [name, entry] of Object.entries(usage)) {
      this.assertSafeSkillName(name);
      if (entry.createdBy !== 'agent') continue;
      const files = await this.readTreeSecure(this.liveDir(name));
      fileCount += Object.keys(files).length;
      totalBytes += Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
      if (fileCount > this.limits.maxFiles) throw new Error(`Curator backup exceeds file-count limit (${this.limits.maxFiles})`);
      if (totalBytes > this.limits.maxTotalBytes) throw new Error(`Curator backup exceeds total-byte limit (${this.limits.maxTotalBytes})`);
      if (Object.keys(files).length > 0) trees.push({ name, files });
    }

    const directory = join(this.backupDir, String(now));
    await this.createPrivateDirectory(this.backupDir);
    await this.removeTreeIfPresent(directory);
    await mkdir(directory, { mode: 0o700 });
    for (const tree of trees) {
      await this.writeFiles(join(directory, 'skills', tree.name), tree.files);
    }
    await this.writeOwnerFileAtomic(join(directory, USAGE_FILE_NAME), usageContent);
    const entries: string[] = [];
    for (const entry of await readdir(this.backupDir, { withFileTypes: true })) {
      const abs = join(this.backupDir, entry.name);
      const info = await lstat(abs);
      if (info.isSymbolicLink() || !info.isDirectory() || !/^\d+$/.test(entry.name)) {
        throw new Error(`Unsafe curator backup entry '${entry.name}'`);
      }
      entries.push(entry.name);
    }
    entries.sort((a, b) => Number(b) - Number(a));
    for (const old of entries.slice(Math.max(1, keep))) {
      await this.removeTreeIfPresent(join(this.backupDir, old));
    }
    return directory;
  }

  private async writeFiles(dir: string, files: SkillFiles): Promise<void> {
    this.validateSkillFiles(files);
    const root = resolve(dir);
    await this.createStoreDirectory(root);
    const rootReal = await realpath(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolve(root, rel);
      this.assertPathContained(root, abs, rel);
      await this.ensureSafeDirectoryChain(root, rootReal, dirname(abs));
      const handle = await open(
        abs,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | this.noFollowFlag(),
        0o600,
      );
      try {
        await handle.writeFile(content, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await this.syncDirectory(root);
  }

  private assertSafeSkillName(name: string): void {
    if (!SAFE_SKILL_NAME.test(name)) {
      throw new Error(`Unsafe skill name '${name}'`);
    }
  }

  private assertSafeLimits(limits: SkillStoreLimits): void {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid skill-store limit ${name}`);
    }
  }

  private validateRelativePath(rel: string): void {
    const segments = rel.split('/');
    if (
      !rel ||
      rel.includes('\\') ||
      rel.includes('\0') ||
      isAbsolute(rel) ||
      segments.some(segment => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`Unsafe skill file path '${rel}'`);
    }
  }

  private validateSkillFiles(files: SkillFiles): void {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Skill files must be an object');
    const paths = Object.keys(files).sort();
    if (paths.length > this.limits.maxFiles) throw new Error(`Skill tree exceeds file-count limit (${this.limits.maxFiles})`);
    let total = 0;
    for (let index = 0; index < paths.length; index++) {
      const rel = paths[index];
      this.validateRelativePath(rel);
      const content = files[rel];
      if (typeof content !== 'string') throw new Error(`Skill file '${rel}' must contain text`);
      const bytes = Buffer.byteLength(content);
      if (bytes > this.limits.maxFileBytes) throw new Error(`Skill file '${rel}' exceeds per-file byte limit (${this.limits.maxFileBytes})`);
      total += bytes;
      if (total > this.limits.maxTotalBytes) throw new Error(`Skill tree exceeds total-byte limit (${this.limits.maxTotalBytes})`);
      if (index > 0 && rel.startsWith(`${paths[index - 1]}/`)) {
        throw new Error(`Skill path '${paths[index - 1]}' conflicts with '${rel}'`);
      }
    }
  }

  private assertPathContained(root: string, candidate: string, label: string): void {
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error(`Unsafe skill file path '${label}'`);
    }
  }

  private assertRealpathContained(rootReal: string, candidateReal: string, label: string): void {
    const rel = relative(rootReal, candidateReal);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error(`Skill tree path escapes through '${label}'`);
    }
  }

  private async lstatOrNull(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  private isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }

  private noFollowFlag(): number {
    return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  }

  private async ensureRecovered(): Promise<void> {
    await this.recoverPendingPromotions();
  }

  private async ensureSafeDirectoryChain(root: string, rootReal: string, target: string): Promise<void> {
    const relativeTarget = relative(root, target);
    if (!relativeTarget) return;
    if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === '..' || isAbsolute(relativeTarget)) {
      throw new Error(`Directory path escapes skill tree: '${target}'`);
    }
    let current = root;
    for (const segment of relativeTarget.split(sep)) {
      current = join(current, segment);
      let info = await this.lstatOrNull(current);
      let created = false;
      if (!info) {
        try {
          await mkdir(current, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe non-directory path component '${current}'`);
      }
      this.assertRealpathContained(rootReal, await realpath(current), current);
      if (created) await this.syncDirectory(dirname(current));
    }
  }

  private async readTreeSecure(dir: string): Promise<SkillFiles> {
    const root = resolve(dir);
    const rootInfo = await this.lstatOrNull(root);
    if (!rootInfo) return {};
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(`Skill tree root is not a regular directory: '${root}'`);
    }
    const rootReal = await realpath(root);
    const out: SkillFiles = Object.create(null) as SkillFiles;
    let fileCount = 0;
    let totalBytes = 0;

    const walk = async (current: string): Promise<void> => {
      const currentInfo = await lstat(current);
      if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) {
        throw new Error(`Unsafe directory entry in skill tree: '${current}'`);
      }
      this.assertRealpathContained(rootReal, await realpath(current), current);

      for (const entry of await readdir(current, { withFileTypes: true })) {
        const abs = join(current, entry.name);
        const rel = relative(root, abs).split(sep).join('/');
        this.validateRelativePath(rel);
        const before = await lstat(abs);
        if (before.isSymbolicLink()) throw new Error(`Symlink rejected in skill tree: '${rel}'`);
        if (before.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!before.isFile()) throw new Error(`Non-regular file rejected in skill tree: '${rel}'`);
        if (before.nlink !== 1) throw new Error(`Hard-linked file rejected in skill tree: '${rel}'`);

        fileCount++;
        if (fileCount > this.limits.maxFiles) throw new Error(`Skill tree exceeds file-count limit (${this.limits.maxFiles})`);
        if (before.size > this.limits.maxFileBytes) {
          throw new Error(`Skill file '${rel}' exceeds per-file byte limit (${this.limits.maxFileBytes})`);
        }
        const pathRealBefore = await realpath(abs);
        this.assertRealpathContained(rootReal, pathRealBefore, rel);

        const handle = await open(abs, fsConstants.O_RDONLY | this.noFollowFlag());
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error(`Skill file changed during secure open: '${rel}'`);
          }
          if (opened.size > this.limits.maxFileBytes) {
            throw new Error(`Skill file '${rel}' exceeds per-file byte limit (${this.limits.maxFileBytes})`);
          }
          const pathRealAfter = await realpath(abs);
          this.assertRealpathContained(rootReal, pathRealAfter, rel);
          if (pathRealAfter !== pathRealBefore) throw new Error(`Skill file path changed during read: '${rel}'`);
          const content = await handle.readFile();
          if (content.byteLength > this.limits.maxFileBytes) {
            throw new Error(`Skill file '${rel}' exceeds per-file byte limit (${this.limits.maxFileBytes})`);
          }
          totalBytes += content.byteLength;
          if (totalBytes > this.limits.maxTotalBytes) {
            throw new Error(`Skill tree exceeds total-byte limit (${this.limits.maxTotalBytes})`);
          }
          out[rel] = content.toString('utf-8');
        } finally {
          await handle.close();
        }
      }
    };

    await walk(root);
    return out;
  }

  private async readRegularFileNoFollow(path: string, maxBytes: number): Promise<string> {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Unsafe non-regular file '${path}'`);
    if (before.nlink !== 1) throw new Error(`Unsafe hard-linked file '${path}'`);
    if (before.size > maxBytes) throw new Error(`File exceeds byte limit: '${path}'`);
    const handle = await open(path, fsConstants.O_RDONLY | this.noFollowFlag());
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`File changed during secure open: '${path}'`);
      }
      const content = await handle.readFile();
      if (content.byteLength > maxBytes) throw new Error(`File exceeds byte limit: '${path}'`);
      return content.toString('utf-8');
    } finally {
      await handle.close();
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    const info = await this.lstatOrNull(path);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Expected a regular directory at '${path}'`);
    }
    return true;
  }

  private async removeTreeIfPresent(path: string): Promise<void> {
    const info = await this.lstatOrNull(path);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to remove unsafe tree '${path}'`);
    await this.readTreeSecure(path);
    await rm(path, { recursive: true, force: false });
  }

  /**
   * A promotion transaction can contain multiple complete versions. Validate
   * and remove each known child independently so two individually valid,
   * near-limit trees do not trip the single-skill aggregate bounds.
   */
  private async removePromotionTransaction(paths: PromotionPaths): Promise<void> {
    const info = await this.lstatOrNull(paths.transaction);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to remove unsafe promotion transaction '${paths.transaction}'`);
    }
    const children = new Map([
      ['new', paths.prepared],
      ['old', paths.previous],
      ['discarded', paths.discarded],
    ]);
    for (const entry of await readdir(paths.transaction, { withFileTypes: true })) {
      const child = children.get(entry.name);
      if (!child) throw new Error(`Unknown promotion transaction child '${entry.name}'`);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
        throw new Error(`Unsafe promotion transaction child '${entry.name}'`);
      }
      await this.removeTreeIfPresent(child);
    }
    await rmdir(paths.transaction);
  }

  private async removeRegularFileIfPresent(path: string): Promise<void> {
    const info = await this.lstatOrNull(path);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to remove unsafe file '${path}'`);
    await rm(path, { force: false });
  }

  private async createPrivateDirectory(path: string): Promise<void> {
    const existed = await this.lstatOrNull(path);
    await this.createStoreDirectory(resolve(path));
    const handle = await open(path, fsConstants.O_RDONLY | this.noFollowFlag());
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) throw new Error(`Unsafe private directory '${path}'`);
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    if (!existed) await this.syncDirectory(dirname(path));
  }

  private async createStoreDirectory(path: string): Promise<void> {
    const root = resolve(this.localDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Unsafe skill-store root '${root}'`);
    const rootReal = await realpath(root);
    if (path === root) return;
    this.assertPathContained(root, path, path);
    await this.ensureSafeDirectoryChain(root, rootReal, path);
  }

  private async writeOwnerFileAtomic(path: string, content: string): Promise<void> {
    await this.createPrivateDirectory(dirname(path));
    const temporary = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | this.noFollowFlag(),
        0o600,
      );
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error;
      this.logger?.debug({ path, code }, 'Directory fsync unsupported');
    } finally {
      await handle.close();
    }
  }

  private sameFiles(left: SkillFiles, right: SkillFiles): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
  }

  private promotionPaths(name: string, transactionId: string): PromotionPaths {
    this.assertSafeSkillName(name);
    if (!SAFE_TRANSACTION_ID.test(transactionId)) throw new Error(`Unsafe promotion transaction id '${transactionId}'`);
    const transaction = join(this.transactionDir, `${name}.${transactionId}`);
    return {
      journal: join(this.journalDir, `${name}.json`),
      lock: join(this.lockDir, `${name}.lock`),
      transaction,
      prepared: join(transaction, 'new'),
      previous: join(transaction, 'old'),
      discarded: join(transaction, 'discarded'),
      live: this.liveDir(name),
      staged: this.stagedDir(name),
    };
  }

  private validateJournal(value: unknown): PromotionJournal {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid promotion journal');
    const journal = value as Partial<PromotionJournal>;
    this.assertSafeSkillName(String(journal.name ?? ''));
    if (!SAFE_TRANSACTION_ID.test(String(journal.transactionId ?? ''))) throw new Error('Invalid promotion transaction id');
    if (!SAFE_TRANSACTION_ID.test(String(journal.ownerToken ?? ''))) throw new Error('Invalid promotion owner token');
    if (journal.version !== JOURNAL_VERSION || !['prepared', 'old_moved', 'new_live', 'committed'].includes(String(journal.state))) {
      throw new Error('Invalid promotion journal state');
    }
    if (typeof journal.ownerPid !== 'number' || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid <= 0) {
      throw new Error('Invalid promotion journal owner');
    }
    if (
      typeof journal.hadLive !== 'boolean'
      || typeof journal.createdAt !== 'number'
      || !Number.isFinite(journal.createdAt)
      || !['promote', 'rollback'].includes(String(journal.operation))
      || typeof journal.desiredPresent !== 'boolean'
      || typeof journal.cleanupStaged !== 'boolean'
    ) {
      throw new Error('Invalid promotion journal metadata');
    }
    if (
      (journal.operation === 'promote' && !journal.cleanupStaged)
      || (journal.operation === 'rollback' && journal.cleanupStaged)
    ) {
      throw new Error('Invalid promotion journal cleanup policy');
    }
    return journal as PromotionJournal;
  }

  private async writePromotionJournal(journal: PromotionJournal): Promise<void> {
    this.validateJournal(journal);
    await this.createPrivateDirectory(this.journalDir);
    await this.writeOwnerFileAtomic(
      this.promotionPaths(journal.name, journal.transactionId).journal,
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  }

  private async loadPromotionJournal(path: string): Promise<PromotionJournal> {
    const journal = this.validateJournal(JSON.parse(await this.readRegularFileNoFollow(path, 64 * 1024)));
    if (path !== this.promotionPaths(journal.name, journal.transactionId).journal) {
      throw new Error(`Promotion journal filename does not match '${journal.name}'`);
    }
    return journal;
  }

  private async acquirePromotionLock(name: string, ownerToken: string): Promise<void> {
    this.assertSafeSkillName(name);
    if (!SAFE_TRANSACTION_ID.test(ownerToken)) throw new Error('Invalid promotion owner token');
    await this.createPrivateDirectory(this.lockDir);
    const path = join(this.lockDir, `${name}.lock`);
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | this.noFollowFlag(),
        0o600,
      );
      await handle.writeFile(`${JSON.stringify({ ownerPid: process.pid, ownerToken })}\n`, 'utf-8');
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Promotion already in progress for '${name}'`);
      }
      throw error;
    } finally {
      if (handle) await handle.close();
    }
    await this.syncDirectory(this.lockDir);
  }

  private async releasePromotionLock(name: string, ownerToken: string): Promise<void> {
    const path = join(this.lockDir, `${name}.lock`);
    const info = await this.lstatOrNull(path);
    if (!info) return;
    const parsed = JSON.parse(await this.readRegularFileNoFollow(path, 4096)) as { ownerToken?: unknown };
    if (parsed.ownerToken !== ownerToken) return;
    await this.removeRegularFileIfPresent(path);
    await this.syncDirectory(this.lockDir);
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async journalHasActiveOwner(journal: PromotionJournal): Promise<boolean> {
    const path = this.promotionPaths(journal.name, journal.transactionId).lock;
    const info = await this.lstatOrNull(path);
    if (!info) return false;
    const parsed = JSON.parse(await this.readRegularFileNoFollow(path, 4096)) as {
      ownerPid?: unknown;
      ownerToken?: unknown;
    };
    return parsed.ownerPid === journal.ownerPid
      && parsed.ownerToken === journal.ownerToken
      && this.processIsAlive(journal.ownerPid);
  }

  private async runPromotionHook(phase: PromotionPhase, name: string): Promise<void> {
    await this.promotionPhaseHook?.(phase, name);
  }

  /**
   * Install a complete desired tree (or the deliberate absence of one) without
   * ever exposing a partially-written skill. The journal is durable before the
   * first live rename, so recovery can always choose the complete old or new
   * state after a process or host crash.
   */
  private async replaceLiveAtomically(
    name: string,
    desired: SkillFiles | null,
    options: { operation: 'promote' | 'rollback'; cleanupStaged: boolean },
  ): Promise<void> {
    this.assertSafeSkillName(name);
    if (desired) this.validateSkillFiles(desired);
    if (
      (options.operation === 'promote' && !options.cleanupStaged)
      || (options.operation === 'rollback' && options.cleanupStaged)
    ) {
      throw new Error('Invalid atomic replacement cleanup policy');
    }

    // Generate and validate all path-bearing identifiers before touching disk.
    const transactionId = this.transactionIdFactory();
    const ownerToken = randomUUID();
    const paths = this.promotionPaths(name, transactionId);
    if (!SAFE_TRANSACTION_ID.test(ownerToken)) throw new Error('Invalid promotion owner token');

    let lockHeld = false;
    let journal: PromotionJournal | undefined;
    try {
      await this.acquirePromotionLock(name, ownerToken);
      lockHeld = true;
      await this.createPrivateDirectory(this.transactionDir);
      await mkdir(paths.transaction, { mode: 0o700 });
      await this.syncDirectory(this.transactionDir);

      if (desired) {
        await this.writeFiles(paths.prepared, desired);
        const prepared = await this.readTreeSecure(paths.prepared);
        if (!this.sameFiles(desired, prepared)) {
          throw new Error(`Prepared skill tree for '${name}' failed verification`);
        }
      }
      await this.syncDirectory(paths.transaction);

      const hadLive = await this.directoryExists(paths.live);
      if (hadLive) await this.readTreeSecure(paths.live);
      journal = {
        version: JOURNAL_VERSION,
        name,
        transactionId,
        ownerPid: process.pid,
        ownerToken,
        state: 'prepared',
        hadLive,
        operation: options.operation,
        desiredPresent: desired !== null,
        cleanupStaged: options.cleanupStaged,
        createdAt: Date.now(),
      };
      await this.writePromotionJournal(journal);
      await this.runPromotionHook('prepared', name);

      if (hadLive) {
        await rename(paths.live, paths.previous);
        await this.syncDirectory(this.localDir);
        await this.syncDirectory(paths.transaction);
      }
      await this.runPromotionHook('old_moved_before_journal', name);
      journal.state = 'old_moved';
      await this.writePromotionJournal(journal);
      await this.runPromotionHook('old_moved', name);

      if (desired) {
        await rename(paths.prepared, paths.live);
        await this.syncDirectory(this.localDir);
        await this.syncDirectory(paths.transaction);
      }
      await this.runPromotionHook('new_live_before_journal', name);
      journal.state = 'new_live';
      await this.writePromotionJournal(journal);
      await this.runPromotionHook('new_live', name);

      journal.state = 'committed';
      await this.writePromotionJournal(journal);
      await this.runPromotionHook('committed', name);
      await this.finalizeCommittedPromotion(journal);
    } catch (error) {
      if (!journal) {
        // No durable intent exists yet, so this transaction cannot have moved
        // the live tree and its private preparation directory is disposable.
        await this.removePromotionTransaction(paths).catch(cleanupError => {
          this.logger?.warn({ err: cleanupError, name }, 'Failed to clean unjournaled skill transaction');
        });
        throw error;
      }

      const resolution = await this.recoverPromotion(journal);
      // Once the commit record is durable, cleanup/hook failures report success:
      // recovery has completed the requested state and retrying would be wrong.
      if (resolution === 'committed') return;
      throw error;
    } finally {
      if (lockHeld) await this.releasePromotionLock(name, ownerToken);
    }
  }

  private async finalizeCommittedPromotion(journal: PromotionJournal): Promise<void> {
    const resolution = await this.recoverPromotion(journal);
    if (resolution !== 'committed') throw new Error(`Committed promotion '${journal.name}' could not be finalized`);
  }

  private async cleanupPromotionArtifacts(paths: PromotionPaths, cleanupStaged: boolean): Promise<void> {
    if (cleanupStaged) {
      await this.removeTreeIfPresent(paths.staged);
      if (await this.directoryExists(this.proposedDir)) await this.syncDirectory(this.proposedDir);
    }
    await this.removePromotionTransaction(paths);
    if (await this.directoryExists(this.transactionDir)) await this.syncDirectory(this.transactionDir);
    await this.removeRegularFileIfPresent(paths.journal);
    if (await this.directoryExists(this.journalDir)) await this.syncDirectory(this.journalDir);
    await this.syncDirectory(this.localDir);
  }

  private async recoverPromotion(journal: PromotionJournal): Promise<'rolled_back' | 'committed'> {
    journal = this.validateJournal(journal);
    const paths = this.promotionPaths(journal.name, journal.transactionId);

    if (journal.state === 'committed') {
      if (journal.desiredPresent) {
        if (!(await this.directoryExists(paths.live))) {
          if (await this.directoryExists(paths.prepared)) {
            await rename(paths.prepared, paths.live);
            await this.syncDirectory(this.localDir);
          } else if (await this.directoryExists(paths.previous)) {
            // Corrupt/incomplete commit record: restore old rather than leave
            // the skill absent, retaining the old-or-new invariant.
            await rename(paths.previous, paths.live);
            await this.cleanupPromotionArtifacts(paths, false);
            return 'rolled_back';
          } else {
            throw new Error(`Committed promotion '${journal.name}' has no recoverable live tree`);
          }
        }
        await this.readTreeSecure(paths.live);
      } else if (await this.directoryExists(paths.live)) {
        // A committed null rollback deliberately makes the live override absent.
        // Quarantine any unexpected live tree inside the private transaction
        // before cleanup instead of recursively deleting a raceable live path.
        if (!(await this.directoryExists(paths.transaction))) {
          await this.createPrivateDirectory(this.transactionDir);
          await mkdir(paths.transaction, { mode: 0o700 });
        }
        await this.removeTreeIfPresent(paths.discarded);
        await rename(paths.live, paths.discarded);
        await this.syncDirectory(this.localDir);
      }
      await this.cleanupPromotionArtifacts(paths, journal.cleanupStaged);
      return 'committed';
    }

    const previousExists = await this.directoryExists(paths.previous);
    const liveExists = await this.directoryExists(paths.live);
    if (previousExists) {
      if (liveExists) {
        await this.removeTreeIfPresent(paths.discarded);
        await rename(paths.live, paths.discarded);
        await this.syncDirectory(this.localDir);
      }
      await rename(paths.previous, paths.live);
      await this.syncDirectory(this.localDir);
    } else if (!journal.hadLive && liveExists) {
      await rename(paths.live, paths.discarded);
      await this.syncDirectory(this.localDir);
    } else if (journal.hadLive && !liveExists) {
      // The old backup is unexpectedly missing. Prefer the fully prepared new
      // tree to an absent live skill, preserving the old-or-new invariant.
      if (journal.desiredPresent && await this.directoryExists(paths.prepared)) {
        await rename(paths.prepared, paths.live);
        await this.syncDirectory(this.localDir);
        journal.state = 'committed';
        await this.writePromotionJournal(journal);
        return this.recoverPromotion(journal);
      }
      throw new Error(`Promotion '${journal.name}' lost both old and new live trees`);
    }

    await this.cleanupPromotionArtifacts(paths, false);
    return 'rolled_back';
  }

  private parseTransactionDirectory(name: string): { skillName: string; transactionId: string } {
    const separator = name.indexOf('.');
    if (separator <= 0 || separator === name.length - 1 || name.indexOf('.', separator + 1) !== -1) {
      throw new Error(`Unsafe promotion transaction entry '${name}'`);
    }
    const skillName = name.slice(0, separator);
    const transactionId = name.slice(separator + 1);
    this.assertSafeSkillName(skillName);
    if (!SAFE_TRANSACTION_ID.test(transactionId)) throw new Error(`Unsafe promotion transaction entry '${name}'`);
    return { skillName, transactionId };
  }

  private async lockHasLiveOwner(name: string): Promise<boolean> {
    const path = join(this.lockDir, `${name}.lock`);
    const info = await this.lstatOrNull(path);
    if (!info) return false;
    const parsed = JSON.parse(await this.readRegularFileNoFollow(path, 4096)) as {
      ownerPid?: unknown;
      ownerToken?: unknown;
    };
    return typeof parsed.ownerPid === 'number'
      && Number.isSafeInteger(parsed.ownerPid)
      && parsed.ownerPid > 0
      && typeof parsed.ownerToken === 'string'
      && SAFE_TRANSACTION_ID.test(parsed.ownerToken)
      && this.processIsAlive(parsed.ownerPid);
  }

  private async performRecovery(): Promise<void> {
    const referencedTransactions = new Set<string>();
    if (await this.directoryExists(this.journalDir)) {
      for (const entry of await readdir(this.journalDir, { withFileTypes: true })) {
        const path = join(this.journalDir, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe promotion journal entry '${entry.name}'`);
        if (!entry.name.endsWith('.json')) {
          if (entry.name.endsWith('.tmp')) await this.removeRegularFileIfPresent(path);
          else throw new Error(`Unknown promotion journal entry '${entry.name}'`);
          continue;
        }
        const journal = await this.loadPromotionJournal(path);
        referencedTransactions.add(`${journal.name}.${journal.transactionId}`);
        if (await this.journalHasActiveOwner(journal)) continue;
        await this.recoverPromotion(journal);
        await this.releasePromotionLock(journal.name, journal.ownerToken);
      }
    }

    if (await this.directoryExists(this.transactionDir)) {
      for (const entry of await readdir(this.transactionDir, { withFileTypes: true })) {
        const path = join(this.transactionDir, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe promotion transaction entry '${entry.name}'`);
        const { skillName, transactionId } = this.parseTransactionDirectory(entry.name);
        if (!referencedTransactions.has(entry.name) && !(await this.lockHasLiveOwner(skillName))) {
          await this.removePromotionTransaction(this.promotionPaths(skillName, transactionId));
        }
      }
    }

    if (await this.directoryExists(this.lockDir)) {
      for (const entry of await readdir(this.lockDir, { withFileTypes: true })) {
        const path = join(this.lockDir, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || !entry.name.endsWith('.lock')) {
          throw new Error(`Unsafe promotion lock entry '${entry.name}'`);
        }
        const parsed = JSON.parse(await this.readRegularFileNoFollow(path, 4096)) as { ownerPid?: unknown };
        if (typeof parsed.ownerPid !== 'number' || !this.processIsAlive(parsed.ownerPid)) {
          await this.removeRegularFileIfPresent(path);
        }
      }
    }
  }
}
