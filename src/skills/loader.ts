/**
 * Skill Loader
 *
 * Loads skills from multiple directories with priority:
 * 1. Workspace skills (.scallopbot/skills/)
 * 2. Local skills (~/.scallopbot/skills/)
 * 3. Bundled skills (built-in)
 *
 * Skills are gated based on:
 * - Required binaries on PATH
 * - Required environment variables
 * - Required config files
 * - Platform (darwin, linux, win32)
 */

import { readdir, readFile, access, watch } from 'fs/promises';
import { join, resolve, dirname, basename } from 'path';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';
import { constants } from 'fs';
import { EventEmitter } from 'events';
import type { Logger } from 'pino';
import type { Skill, SkillLoaderConfig, SkillMetadata } from './types.js';
import { parseFrontmatter, SkillParseError } from './parser.js';

/**
 * Skill loader events
 */
export interface SkillLoaderEvents {
  'skill:changed': (name: string) => void;
  'skill:added': (name: string) => void;
  'skill:removed': (name: string) => void;
}

/**
 * Default skill directories
 */
const DEFAULT_LOCAL_DIR = join(homedir(), '.scallopbot', 'skills');
const WORKSPACE_SKILL_DIR = '.scallopbot/skills';
const BUNDLED_SKILL_DIR = join(dirname(import.meta.url.replace('file://', '')), 'bundled');

/**
 * Gate check result
 */
export interface GateResult {
  available: boolean;
  reason?: string;
}

/**
 * Check if a binary exists on PATH (synchronous)
 */
function hasBinary(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if skill gates are satisfied (synchronous version for SDK)
 * This is a standalone function that can be used without a SkillLoader instance.
 */
export function checkGates(metadata?: SkillMetadata): GateResult {
  if (!metadata?.openclaw) {
    return { available: true };
  }

  const oc = metadata.openclaw;

  // Check OS restriction
  if (oc.os) {
    const currentPlatform = platform();
    const allowedPlatforms = Array.isArray(oc.os) ? oc.os : [oc.os];
    if (!allowedPlatforms.includes(currentPlatform)) {
      return {
        available: false,
        reason: `Requires platform: ${allowedPlatforms.join(' or ')} (current: ${currentPlatform})`,
      };
    }
  }

  // Check required binaries
  if (oc.requires?.bins?.length) {
    for (const bin of oc.requires.bins) {
      if (!hasBinary(bin)) {
        return {
          available: false,
          reason: `Missing required binary: ${bin}`,
        };
      }
    }
  }

  // Check anyBins (at least one must exist)
  if (oc.requires?.anyBins?.length) {
    const hasAny = oc.requires.anyBins.some((bin) => hasBinary(bin));
    if (!hasAny) {
      return {
        available: false,
        reason: `Missing one of required binaries: ${oc.requires.anyBins.join(', ')}`,
      };
    }
  }

  // Check required environment variables
  if (oc.requires?.env?.length) {
    for (const envVar of oc.requires.env) {
      if (!process.env[envVar]) {
        return {
          available: false,
          reason: `Missing required environment variable: ${envVar}`,
        };
      }
    }
  }

  // Note: Config file checking requires async access, so we skip it in sync version
  // The async method on SkillLoader still handles config checking

  return { available: true };
}

/**
 * Internal gate result type for the loader
 */
interface LoaderGateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Skill Loader with hot-reload support
 */
export class SkillLoader extends EventEmitter {
  private config: {
    workspaceDir?: string;
    localDir: string;
    extraDirs: string[];
    watch: boolean;
  };
  private logger: Logger | null;
  private skillCache: Map<string, Skill> = new Map();
  private watchers: AbortController[] = [];
  private isWatching = false;

  constructor(config: SkillLoaderConfig = {}, logger?: Logger) {
    super();
    this.config = {
      workspaceDir: config.workspaceDir,
      localDir: config.localDir || DEFAULT_LOCAL_DIR,
      extraDirs: config.extraDirs || [],
      watch: config.watch ?? false,
    };
    this.logger = logger?.child({ module: 'skill-loader' }) || null;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof SkillLoaderEvents>(
    event: K,
    listener: SkillLoaderEvents[K]
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof SkillLoaderEvents>(
    event: K,
    ...args: Parameters<SkillLoaderEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Load all skills from configured directories
   */
  async loadAll(): Promise<Skill[]> {
    const skills: Skill[] = [];
    const seenNames = new Set<string>();

    // Load in priority order: workspace > local > bundled
    // First loaded wins (workspace can override local/bundled)

    // 1. Workspace skills
    if (this.config.workspaceDir) {
      const workspaceSkillsDir = join(this.config.workspaceDir, WORKSPACE_SKILL_DIR);
      const workspaceSkills = await this.loadFromDirectory(workspaceSkillsDir, 'workspace');
      for (const skill of workspaceSkills) {
        if (!seenNames.has(skill.name)) {
          skills.push(skill);
          seenNames.add(skill.name);
        }
      }
    }

    // 2. Local skills
    const localSkills = await this.loadFromDirectory(this.config.localDir, 'local');
    for (const skill of localSkills) {
      if (!seenNames.has(skill.name)) {
        skills.push(skill);
        seenNames.add(skill.name);
      }
    }

    // 3. Extra directories
    for (const dir of this.config.extraDirs) {
      const extraSkills = await this.loadFromDirectory(dir, 'local');
      for (const skill of extraSkills) {
        if (!seenNames.has(skill.name)) {
          skills.push(skill);
          seenNames.add(skill.name);
        }
      }
    }

    // 4. Bundled skills
    const bundledSkills = await this.loadFromDirectory(BUNDLED_SKILL_DIR, 'bundled');
    for (const skill of bundledSkills) {
      if (!seenNames.has(skill.name)) {
        skills.push(skill);
        seenNames.add(skill.name);
      }
    }

    // Update cache
    this.skillCache.clear();
    for (const skill of skills) {
      this.skillCache.set(skill.name, skill);
    }

    this.logger?.info({ count: skills.length }, 'Skills loaded');

    return skills;
  }

  /**
   * Load skills from a directory
   */
  async loadFromDirectory(
    dir: string,
    source: 'workspace' | 'local' | 'bundled'
  ): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const resolvedDir = resolve(dir);
      await access(resolvedDir, constants.R_OK);
      const entries = await readdir(resolvedDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Look for SKILL.md in subdirectory
          const skillPath = join(resolvedDir, entry.name, 'SKILL.md');
          const skill = await this.loadSkillFile(skillPath, source);
          if (skill) {
            skills.push(skill);
          }
        } else if (entry.name === 'SKILL.md') {
          // SKILL.md in root of skill directory
          const skillPath = join(resolvedDir, entry.name);
          const skill = await this.loadSkillFile(skillPath, source);
          if (skill) {
            skills.push(skill);
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist or isn't readable - not an error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ dir, error: (error as Error).message }, 'Failed to load skills from directory');
      }
    }

    return skills;
  }

  /**
   * Load a single skill file
   */
  async loadSkillFile(
    path: string,
    source: 'workspace' | 'local' | 'bundled'
  ): Promise<Skill | null> {
    try {
      const content = await readFile(path, 'utf-8');
      const parsed = parseFrontmatter(content, path);

      // Check gates
      const gateResult = await this.checkGates(parsed.frontmatter.metadata);

      // Check for scripts/ directory
      const skillDir = dirname(path);
      const scriptsDir = join(skillDir, 'scripts');
      const hasScripts = await this.directoryExists(scriptsDir);

      // Validate script paths from frontmatter if present
      if (hasScripts && parsed.frontmatter.scripts) {
        for (const [action, scriptPath] of Object.entries(parsed.frontmatter.scripts)) {
          const fullScriptPath = join(skillDir, scriptPath);
          const scriptExists = await this.fileExists(fullScriptPath);
          if (!scriptExists) {
            this.logger?.warn(
              { skill: parsed.frontmatter.name, action, scriptPath: fullScriptPath },
              'Script path in frontmatter does not exist'
            );
          }
        }
      }

      const skill: Skill = {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        path,
        source,
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        available: gateResult.passed,
        unavailableReason: gateResult.reason,
        scriptsDir: hasScripts ? scriptsDir : undefined,
        hasScripts,
      };

      this.logger?.debug(
        { name: skill.name, path, available: skill.available, hasScripts },
        'Loaded skill'
      );

      return skill;
    } catch (error) {
      if (error instanceof SkillParseError) {
        this.logger?.warn({ path, error: error.message }, 'Failed to parse skill');
      } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ path, error: (error as Error).message }, 'Failed to load skill');
      }
      return null;
    }
  }

  /**
   * Check if a directory exists and is readable
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      await access(dirPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a file exists and is readable
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if skill gates are satisfied
   */
  async checkGates(metadata?: SkillMetadata): Promise<LoaderGateResult> {
    if (!metadata?.openclaw) {
      return { passed: true };
    }

    const oc = metadata.openclaw;

    // Check OS restriction
    if (oc.os) {
      const currentPlatform = platform();
      const allowedPlatforms = Array.isArray(oc.os) ? oc.os : [oc.os];
      if (!allowedPlatforms.includes(currentPlatform)) {
        return {
          passed: false,
          reason: `Requires platform: ${allowedPlatforms.join(' or ')} (current: ${currentPlatform})`,
        };
      }
    }

    // Check required binaries
    if (oc.requires?.bins?.length) {
      for (const bin of oc.requires.bins) {
        if (!this.hasBinary(bin)) {
          return {
            passed: false,
            reason: `Missing required binary: ${bin}`,
          };
        }
      }
    }

    // Check anyBins (at least one must exist)
    if (oc.requires?.anyBins?.length) {
      const hasAny = oc.requires.anyBins.some((bin) => this.hasBinary(bin));
      if (!hasAny) {
        return {
          passed: false,
          reason: `Missing one of required binaries: ${oc.requires.anyBins.join(', ')}`,
        };
      }
    }

    // Check required environment variables
    if (oc.requires?.env?.length) {
      for (const envVar of oc.requires.env) {
        if (!process.env[envVar]) {
          return {
            passed: false,
            reason: `Missing required environment variable: ${envVar}`,
          };
        }
      }
    }

    // Check required config files
    if (oc.requires?.config?.length) {
      for (const configPath of oc.requires.config) {
        const resolvedPath = this.expandPath(configPath);
        try {
          await access(resolvedPath, constants.R_OK);
        } catch {
          return {
            passed: false,
            reason: `Missing required config file: ${configPath}`,
          };
        }
      }
    }

    return { passed: true };
  }

  /**
   * Check if a binary exists on PATH
   */
  private hasBinary(name: string): boolean {
    try {
      const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Expand environment variables and ~ in paths
   * Supports: ~, $VAR, ${VAR}
   */
  private expandPath(inputPath: string): string {
    let result = inputPath;

    // Expand ~ to home directory
    result = result.replace(/^~/, homedir());

    // Expand $VAR and ${VAR} patterns
    result = result.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, unbraced) => {
      const varName = braced || unbraced;
      return process.env[varName] || '';
    });

    return result;
  }

  /**
   * Get a skill by name from cache
   */
  getSkill(name: string): Skill | undefined {
    return this.skillCache.get(name);
  }

  /**
   * Get all available skills (gates passed)
   */
  getAvailableSkills(): Skill[] {
    return Array.from(this.skillCache.values()).filter((s) => s.available);
  }

  /**
   * Get all loaded skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skillCache.values());
  }

  /**
   * Reload a specific skill
   */
  async reloadSkill(name: string): Promise<Skill | null> {
    const existing = this.skillCache.get(name);
    if (!existing) {
      return null;
    }

    // SDK skills cannot be reloaded from file
    if (existing.source === 'sdk') {
      return existing;
    }

    const reloaded = await this.loadSkillFile(existing.path, existing.source);
    if (reloaded) {
      this.skillCache.set(name, reloaded);
    }
    return reloaded;
  }

  /**
   * Clear the skill cache
   */
  clearCache(): void {
    this.skillCache.clear();
  }

  /**
   * Start watching skill directories for changes
   */
  async startWatching(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.isWatching = true;
    const dirsToWatch: string[] = [];

    // Collect directories to watch
    if (this.config.workspaceDir) {
      const workspaceSkillsDir = join(this.config.workspaceDir, WORKSPACE_SKILL_DIR);
      dirsToWatch.push(workspaceSkillsDir);
    }

    dirsToWatch.push(this.config.localDir);
    dirsToWatch.push(...this.config.extraDirs);

    // Start watchers for each directory
    for (const dir of dirsToWatch) {
      this.watchDirectory(dir);
    }

    this.logger?.info({ dirs: dirsToWatch }, 'Started watching skill directories');
  }

  /**
   * Watch a single directory for changes
   */
  private async watchDirectory(dir: string): Promise<void> {
    try {
      const resolvedDir = resolve(dir);
      await access(resolvedDir, constants.R_OK);

      const controller = new AbortController();
      this.watchers.push(controller);

      // Watch directory recursively
      this.watchDirectoryRecursive(resolvedDir, controller.signal);
    } catch (error) {
      // Directory doesn't exist - not an error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ dir, error: (error as Error).message }, 'Failed to watch directory');
      }
    }
  }

  /**
   * Recursively watch a directory and its subdirectories
   */
  private async watchDirectoryRecursive(dir: string, signal: AbortSignal): Promise<void> {
    try {
      const watcher = watch(dir, { recursive: true, signal });

      for await (const event of watcher) {
        if (signal.aborted) break;

        const filename = event.filename;
        if (!filename) continue;

        // Only care about SKILL.md files
        if (basename(filename) !== 'SKILL.md' && !filename.endsWith('/SKILL.md') && !filename.endsWith('\\SKILL.md')) {
          continue;
        }

        const fullPath = join(dir, filename);
        await this.handleFileChange(event.eventType, fullPath, dir);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.logger?.warn({ dir, error: (error as Error).message }, 'Watch error');
      }
    }
  }

  /**
   * Handle a file change event
   */
  private async handleFileChange(
    eventType: string,
    filePath: string,
    baseDir: string
  ): Promise<void> {
    // Debounce rapid events
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      // Try to load the skill file
      const source = this.getSourceForDir(baseDir);
      const skill = await this.loadSkillFile(filePath, source);

      if (skill) {
        const existingSkill = this.skillCache.get(skill.name);

        if (existingSkill) {
          // Skill was modified
          this.skillCache.set(skill.name, skill);
          this.emit('skill:changed', skill.name);
          this.logger?.info({ name: skill.name }, 'Skill changed');
        } else {
          // New skill added
          this.skillCache.set(skill.name, skill);
          this.emit('skill:added', skill.name);
          this.logger?.info({ name: skill.name }, 'Skill added');
        }
      }
    } catch (error) {
      // File might have been deleted
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Find and remove skill that had this path
        for (const [name, skill] of this.skillCache.entries()) {
          if (skill.path === filePath) {
            this.skillCache.delete(name);
            this.emit('skill:removed', name);
            this.logger?.info({ name }, 'Skill removed');
            break;
          }
        }
      }
    }
  }

  /**
   * Get source type for a directory
   */
  private getSourceForDir(dir: string): 'workspace' | 'local' | 'bundled' {
    if (this.config.workspaceDir) {
      const workspaceSkillsDir = join(this.config.workspaceDir, WORKSPACE_SKILL_DIR);
      if (resolve(dir).startsWith(resolve(workspaceSkillsDir))) {
        return 'workspace';
      }
    }

    if (resolve(dir).startsWith(resolve(BUNDLED_SKILL_DIR))) {
      return 'bundled';
    }

    return 'local';
  }

  /**
   * Stop watching skill directories
   */
  async stopWatching(): Promise<void> {
    if (!this.isWatching) {
      return;
    }

    for (const controller of this.watchers) {
      controller.abort();
    }

    this.watchers = [];
    this.isWatching = false;
    this.logger?.info('Stopped watching skill directories');
  }

  /**
   * Check if currently watching
   */
  isCurrentlyWatching(): boolean {
    return this.isWatching;
  }
}

/**
 * Create a skill loader with default configuration
 */
export function createSkillLoader(
  workspaceDir?: string,
  logger?: Logger
): SkillLoader {
  return new SkillLoader(
    {
      workspaceDir,
      localDir: DEFAULT_LOCAL_DIR,
    },
    logger
  );
}
