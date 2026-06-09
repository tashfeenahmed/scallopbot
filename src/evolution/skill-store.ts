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

import { mkdir, readdir, readFile, writeFile, rm, access, stat } from 'fs/promises';
import { join, dirname, relative, sep } from 'path';
import { homedir } from 'os';
import type { Logger } from 'pino';

export type SkillFiles = Record<string, string>;

const DEFAULT_LOCAL_DIR = join(homedir(), '.scallopbot', 'skills');
const PROPOSED_DIR_NAME = '.proposed';

export class SkillStore {
  private readonly localDir: string;
  private readonly proposedDir: string;
  private readonly logger?: Logger;

  constructor(opts: { localDir?: string; logger?: Logger } = {}) {
    this.localDir = opts.localDir ?? DEFAULT_LOCAL_DIR;
    this.proposedDir = join(this.localDir, PROPOSED_DIR_NAME);
    this.logger = opts.logger;
  }

  /** Absolute path to a skill's live directory. */
  liveDir(name: string): string {
    return join(this.localDir, name);
  }

  /** Absolute path to a skill's staged (proposed) directory. */
  stagedDir(name: string): string {
    return join(this.proposedDir, name);
  }

  /** Write a candidate skill to the staging area. Returns the staged SKILL.md path. */
  async stage(name: string, files: SkillFiles): Promise<string> {
    const dir = this.stagedDir(name);
    await rm(dir, { recursive: true, force: true });
    await this.writeFiles(dir, files);
    return join(dir, 'SKILL.md');
  }

  /** Read all files under a directory into a SkillFiles map (empty if absent). */
  async readDir(dir: string): Promise<SkillFiles> {
    const out: SkillFiles = {};
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(current, e.name);
        if (e.isDirectory()) {
          await walk(abs);
        } else {
          const rel = relative(dir, abs).split(sep).join('/');
          out[rel] = await readFile(abs, 'utf-8');
        }
      }
    };
    await walk(dir);
    return out;
  }

  /** Snapshot the current LIVE skill (local override), or null if none exists. */
  async snapshotLive(name: string): Promise<SkillFiles | null> {
    const dir = this.liveDir(name);
    if (!(await this.exists(dir))) return null;
    const files = await this.readDir(dir);
    return Object.keys(files).length > 0 ? files : null;
  }

  /** Promote a staged skill to live, replacing any existing live override. */
  async promote(name: string): Promise<void> {
    const staged = this.stagedDir(name);
    const files = await this.readDir(staged);
    if (Object.keys(files).length === 0) {
      throw new Error(`No staged files for skill '${name}'`);
    }
    const live = this.liveDir(name);
    await rm(live, { recursive: true, force: true });
    await this.writeFiles(live, files);
    await rm(staged, { recursive: true, force: true });
  }

  /** Discard a staged proposal without promoting. */
  async discardStaged(name: string): Promise<void> {
    await rm(this.stagedDir(name), { recursive: true, force: true });
  }

  /**
   * Roll a target back to its snapshot. If snapshot is null the target did not
   * exist before promotion, so rollback deletes the live override entirely.
   */
  async rollback(name: string, snapshot: SkillFiles | null): Promise<void> {
    const live = this.liveDir(name);
    await rm(live, { recursive: true, force: true });
    if (snapshot && Object.keys(snapshot).length > 0) {
      await this.writeFiles(live, snapshot);
    }
  }

  private async writeFiles(dir: string, files: SkillFiles): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      const s = await stat(p);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}
