/**
 * Skill Loader
 *
 * Loads skills from multiple directories with priority:
 * 1. Workspace skills (.leanbot/skills/)
 * 2. Local skills (~/.leanbot/skills/)
 * 3. Bundled skills (built-in)
 *
 * Skills are gated based on:
 * - Required binaries on PATH
 * - Required environment variables
 * - Required config files
 * - Platform (darwin, linux, win32)
 */

import { readdir, readFile, stat, access } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';
import { constants } from 'fs';
import type { Logger } from 'pino';
import type { Skill, SkillLoaderConfig, SkillMetadata } from './types.js';
import { parseFrontmatter, SkillParseError } from './parser.js';

/**
 * Default skill directories
 */
const DEFAULT_LOCAL_DIR = join(homedir(), '.leanbot', 'skills');
const WORKSPACE_SKILL_DIR = '.leanbot/skills';
const BUNDLED_SKILL_DIR = join(dirname(import.meta.url.replace('file://', '')), '..', '..', 'skills');

/**
 * Gate check result
 */
interface GateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Skill Loader
 */
export class SkillLoader {
  private config: {
    workspaceDir?: string;
    localDir: string;
    extraDirs: string[];
    watch: boolean;
  };
  private logger: Logger | null;
  private skillCache: Map<string, Skill> = new Map();

  constructor(config: SkillLoaderConfig = {}, logger?: Logger) {
    this.config = {
      workspaceDir: config.workspaceDir,
      localDir: config.localDir || DEFAULT_LOCAL_DIR,
      extraDirs: config.extraDirs || [],
      watch: config.watch ?? false,
    };
    this.logger = logger?.child({ module: 'skill-loader' }) || null;
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

      const skill: Skill = {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        path,
        source,
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        available: gateResult.passed,
        unavailableReason: gateResult.reason,
      };

      this.logger?.debug(
        { name: skill.name, path, available: skill.available },
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
   * Check if skill gates are satisfied
   */
  async checkGates(metadata?: SkillMetadata): Promise<GateResult> {
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
        const resolvedPath = configPath.replace(/^~/, homedir());
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
