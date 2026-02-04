/**
 * Skill Installer
 * Downloads and installs skills from URLs or skill registries
 * Supports ClawHub (clawhub.ai) - the OpenClaw skill registry
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { Logger } from 'pino';
import { parseFrontmatter } from './parser.js';
import { checkGates } from './loader.js';
import type { Skill, SkillFrontmatter } from './types.js';
import { unzipSync } from 'fflate';

import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { SkillInstaller as SkillInstallerSpec } from './types.js';

// ClawHub API base URL
const CLAWHUB_API_URL = process.env.CLAWHUB_REGISTRY || 'https://clawhub.ai';

/**
 * ClawHub skill metadata from API
 */
export interface ClawHubSkill {
  slug: string;
  displayName: string;
  summary: string;
  version?: string;
  stats?: {
    downloads: number;
    stars: number;
    versions?: number;
  };
  badges?: {
    official?: boolean;
    highlighted?: boolean;
  };
  owner?: {
    handle: string;
    displayName: string;
    image?: string;
  };
  createdAt?: number;
  updatedAt?: number;
}

/**
 * ClawHub search response
 */
export interface ClawHubSearchResponse {
  results: ClawHubSkill[];
  scores?: number[];
}

/**
 * ClawHub version info
 */
export interface ClawHubVersion {
  version: string;
  createdAt: number;
  changelog?: string;
  files?: Array<{
    path: string;
    size: number;
    sha256?: string;
  }>;
}

const execAsync = promisify(exec);
const DEFAULT_LOCAL_SKILLS_DIR = path.join(homedir(), '.scallopbot', 'skills');

/**
 * Escape a string for safe use in shell commands
 * Uses single quotes and escapes any embedded single quotes
 */
function escapeShellArg(arg: string): string {
  // Validate the argument doesn't contain null bytes
  if (arg.includes('\0')) {
    throw new Error('Invalid argument: contains null byte');
  }
  // Use single quotes and escape any embedded single quotes
  // 'foo'\''bar' -> foo'bar
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate that a string is safe for use as a package/formula name
 * Only allows alphanumeric, hyphens, underscores, slashes (for scoped packages), @ and .
 */
function validatePackageName(name: string): boolean {
  // Package names should match a safe pattern
  // npm: @scope/package, regular-package
  // brew: formula-name
  // go: github.com/user/repo@version
  const safePattern = /^[@a-zA-Z0-9_.\-/]+$/;
  return safePattern.test(name) && !name.includes('..') && name.length < 256;
}

/**
 * Validate URL for safe use
 */
function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validate and sanitize skill name to prevent path traversal
 * Returns sanitized name or throws if invalid
 */
function sanitizeSkillName(name: string): string {
  // Check for path traversal attempts
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid skill name: path traversal detected in "${name}"`);
  }
  // Only allow safe characters in skill names
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid skill name: "${name}" contains invalid characters`);
  }
  if (name.length > 128) {
    throw new Error(`Invalid skill name: "${name}" exceeds maximum length`);
  }
  return name;
}

/**
 * Skill installer options
 */
export interface SkillInstallerOptions {
  /** Dry run mode - don't execute commands */
  dryRun?: boolean;
  /** Node package manager to use */
  nodeManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  /** Logger instance */
  logger?: Logger;
}

/**
 * Install execution result
 */
export interface InstallExecutionResult {
  success: boolean;
  command?: string;
  output?: string;
  error?: string;
}

/**
 * Skill dependency installer
 * Executes installation commands for skill dependencies
 */
export class SkillInstaller {
  private dryRun: boolean;
  private nodeManager: string;
  private logger: Logger | null;

  constructor(options: SkillInstallerOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.nodeManager = options.nodeManager || 'npm';
    this.logger = options.logger?.child({ module: 'skill-installer' }) || null;
  }

  /**
   * Select the best installer for the current platform
   */
  selectInstaller(
    installers: SkillInstallerSpec[],
    platform: string = process.platform
  ): SkillInstallerSpec | null {
    // Filter by OS
    const compatible = installers.filter((inst) => {
      if (!('os' in inst) || !inst.os) return true;
      const osList = Array.isArray(inst.os) ? inst.os : [inst.os];
      return osList.includes(platform);
    });

    if (compatible.length === 0) return null;

    // Priority order based on platform
    const priorityOrder =
      platform === 'darwin'
        ? ['brew', 'npm', 'go', 'download']
        : ['npm', 'go', 'download', 'brew'];

    for (const kind of priorityOrder) {
      const found = compatible.find((inst) => inst.kind === kind);
      if (found) return found;
    }

    return compatible[0] || null;
  }

  /**
   * Build install command for an installer spec
   * Uses proper escaping to prevent command injection
   */
  buildInstallCommand(installer: SkillInstallerSpec): string {
    switch (installer.kind) {
      case 'brew': {
        if (!installer.formula || !validatePackageName(installer.formula)) {
          throw new Error(`Invalid brew formula name: ${installer.formula}`);
        }
        return `brew install ${escapeShellArg(installer.formula)}`;
      }

      case 'npm': {
        if (!installer.package || !validatePackageName(installer.package)) {
          throw new Error(`Invalid npm package name: ${installer.package}`);
        }
        return `${this.nodeManager} install -g ${escapeShellArg(installer.package)}`;
      }

      case 'go': {
        if (!installer.package || !validatePackageName(installer.package)) {
          throw new Error(`Invalid go package name: ${installer.package}`);
        }
        return `go install ${escapeShellArg(installer.package)}`;
      }

      case 'uv': {
        if (!installer.package || !validatePackageName(installer.package)) {
          throw new Error(`Invalid uv package name: ${installer.package}`);
        }
        return `uv tool install ${escapeShellArg(installer.package)}`;
      }

      case 'download': {
        if (!installer.url || !validateUrl(installer.url)) {
          throw new Error(`Invalid download URL: ${installer.url}`);
        }
        const binName = installer.bins?.[0] || 'binary';
        // Validate binary name - only alphanumeric, hyphens, underscores
        if (!/^[a-zA-Z0-9_-]+$/.test(binName)) {
          throw new Error(`Invalid binary name: ${binName}`);
        }
        const installDir = '$HOME/.local/bin';
        // Use escaped URL and validated binary name
        return `curl -fsSL ${escapeShellArg(installer.url)} -o /tmp/${binName} && chmod +x /tmp/${binName} && mkdir -p ${installDir} && mv /tmp/${binName} ${installDir}/${binName}`;
      }

      default:
        throw new Error(`Unknown installer kind: ${(installer as any).kind}`);
    }
  }

  /**
   * Check if a binary is available
   */
  hasBinary(name: string): boolean {
    // Validate binary name to prevent command injection
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.logger?.warn({ name }, 'Invalid binary name, rejecting');
      return false;
    }
    try {
      const cmd = process.platform === 'win32'
        ? `where ${escapeShellArg(name)}`
        : `which ${escapeShellArg(name)}`;
      execSync(cmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute an install command
   */
  async executeInstall(installer: SkillInstallerSpec): Promise<InstallExecutionResult> {
    const command = this.buildInstallCommand(installer);

    if (this.dryRun) {
      this.logger?.info({ command }, 'Dry run: would execute');
      return { success: true, command };
    }

    this.logger?.info({ command, kind: installer.kind }, 'Executing install');

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 300000, // 5 minute timeout
        env: { ...process.env, CI: 'true' }, // Non-interactive mode
      });

      this.logger?.info({ kind: installer.kind }, 'Install completed');

      return {
        success: true,
        command,
        output: stdout + (stderr ? `\n${stderr}` : ''),
      };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      this.logger?.error({ error: err.message, command }, 'Install failed');

      return {
        success: false,
        command,
        error: err.message,
        output: (err.stdout || '') + (err.stderr ? `\n${err.stderr}` : ''),
      };
    }
  }

  /**
   * Install all dependencies for a skill
   */
  async installDependencies(
    installers: SkillInstallerSpec[]
  ): Promise<InstallExecutionResult[]> {
    const results: InstallExecutionResult[] = [];

    const selected = this.selectInstaller(installers);
    if (!selected) {
      return [{ success: false, error: 'No compatible installer found' }];
    }

    // Check if already installed (if bins are specified)
    if (selected.bins?.length) {
      const allInstalled = selected.bins.every((bin) => this.hasBinary(bin));
      if (allInstalled) {
        this.logger?.info({ bins: selected.bins }, 'Dependencies already installed');
        return [{ success: true, output: 'Already installed' }];
      }
    }

    results.push(await this.executeInstall(selected));
    return results;
  }
}

/**
 * Skill package metadata from registry
 */
export interface SkillPackage {
  name: string;
  description: string;
  version: string;
  author?: string;
  homepage?: string;
  downloadUrl: string;
  checksum?: string;
}

/**
 * Registry search result
 */
export interface SearchResult {
  packages: SkillPackage[];
  total: number;
}

/**
 * Installation result
 */
export interface InstallResult {
  success: boolean;
  skill?: Skill;
  error?: string;
  path?: string;
  checksum?: string;
}

/**
 * Version metadata for installed skills
 */
interface VersionMetadata {
  version: string;
  installedAt: string;
  checksum: string;
  sourceUrl?: string;
}

export interface SkillPackageManagerOptions {
  /** Base URL for skill registry (default: GitHub raw content) */
  registryUrl?: string;
  /** Local skills directory */
  skillsDir?: string;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Skill Installer for downloading and installing skills from URLs
 */
export class SkillPackageManager {
  private registryUrl: string;
  private skillsDir: string;
  private logger: Logger | null;

  constructor(options: SkillPackageManagerOptions = {}) {
    this.registryUrl = options.registryUrl || 'https://raw.githubusercontent.com/openclaw/skills/main';
    this.skillsDir = options.skillsDir || DEFAULT_LOCAL_SKILLS_DIR;
    this.logger = options.logger?.child({ module: 'clawhub' }) || null;
  }

  /**
   * Search for skills by query
   */
  async search(query: string): Promise<SearchResult> {
    try {
      // Fetch registry index
      const indexUrl = `${this.registryUrl}/index.json`;
      const response = await fetch(indexUrl);

      if (!response.ok) {
        this.logger?.warn({ status: response.status }, 'Failed to fetch registry index');
        return { packages: [], total: 0 };
      }

      const index = (await response.json()) as { skills: SkillPackage[] };
      const lowerQuery = query.toLowerCase();

      // Filter skills matching query
      const matches = index.skills.filter(
        (pkg) =>
          pkg.name.toLowerCase().includes(lowerQuery) ||
          pkg.description.toLowerCase().includes(lowerQuery)
      );

      return {
        packages: matches,
        total: matches.length,
      };
    } catch (error) {
      this.logger?.error({ error: (error as Error).message }, 'Search failed');
      return { packages: [], total: 0 };
    }
  }

  /**
   * Get skill package info by name
   */
  async getPackage(name: string): Promise<SkillPackage | null> {
    try {
      const indexUrl = `${this.registryUrl}/index.json`;
      const response = await fetch(indexUrl);

      if (!response.ok) {
        return null;
      }

      const index = (await response.json()) as { skills: SkillPackage[] };
      return index.skills.find((pkg) => pkg.name === name) || null;
    } catch {
      return null;
    }
  }

  /**
   * Install a skill by name
   */
  async install(name: string): Promise<InstallResult> {
    // Validate name early to prevent path traversal
    try {
      sanitizeSkillName(name);
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }

    this.logger?.info({ name }, 'Installing skill');

    try {
      // Get package info
      const pkg = await this.getPackage(name);
      if (!pkg) {
        // Try direct download from convention URL
        const directUrl = `${this.registryUrl}/skills/${name}/SKILL.md`;
        return this.installFromUrl(name, directUrl);
      }

      return this.installFromUrl(name, pkg.downloadUrl);
    } catch (error) {
      return {
        success: false,
        error: `Installation failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Compute SHA-256 checksum of content
   */
  private computeChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Install a skill from a URL
   */
  async installFromUrl(name: string, url: string): Promise<InstallResult> {
    try {
      // Validate URL
      if (!validateUrl(url)) {
        return {
          success: false,
          error: `Invalid URL: ${url}`,
        };
      }

      // Fetch skill content
      const response = await fetch(url);
      if (!response.ok) {
        return {
          success: false,
          error: `Failed to download skill: HTTP ${response.status}`,
        };
      }

      const content = await response.text();

      // Compute checksum
      const checksum = this.computeChecksum(content);

      // Validate skill format
      let parsed: { frontmatter: SkillFrontmatter; content: string };
      try {
        parsed = parseFrontmatter(content, url);
      } catch (parseError) {
        return {
          success: false,
          error: `Invalid skill format: ${(parseError as Error).message}`,
        };
      }

      // Use name from frontmatter or provided name, sanitize to prevent path traversal
      let skillName: string;
      try {
        skillName = sanitizeSkillName(parsed.frontmatter.name || name);
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }

      // Create skill directory
      const skillDir = path.join(this.skillsDir, skillName);
      await fs.mkdir(skillDir, { recursive: true });

      // Write SKILL.md
      const skillPath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(skillPath, content, 'utf-8');

      // Write version metadata
      const versionMeta: VersionMetadata = {
        version: '1.0.0', // Default version
        installedAt: new Date().toISOString(),
        checksum,
        sourceUrl: url,
      };
      await fs.writeFile(
        path.join(skillDir, '.version.json'),
        JSON.stringify(versionMeta, null, 2),
        'utf-8'
      );

      // Check gates
      const gateResult = checkGates(parsed.frontmatter.metadata);

      const skill: Skill = {
        name: skillName,
        description: parsed.frontmatter.description,
        path: skillPath,
        source: 'local',
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        available: gateResult.available,
        unavailableReason: gateResult.reason,
        hasScripts: false,
      };

      this.logger?.info(
        { name: skillName, path: skillPath, available: skill.available, checksum },
        'Skill installed'
      );

      return {
        success: true,
        skill,
        path: skillPath,
        checksum,
      };
    } catch (error) {
      return {
        success: false,
        error: `Installation failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Install a skill with checksum verification
   */
  async installWithChecksum(
    name: string,
    url: string,
    expectedChecksum: string
  ): Promise<InstallResult> {
    try {
      // Validate URL
      if (!validateUrl(url)) {
        return {
          success: false,
          error: `Invalid URL: ${url}`,
        };
      }

      // Fetch skill content
      const response = await fetch(url);
      if (!response.ok) {
        return {
          success: false,
          error: `Failed to download skill: HTTP ${response.status}`,
        };
      }

      const content = await response.text();

      // Verify checksum
      const actualChecksum = this.computeChecksum(content);
      if (actualChecksum !== expectedChecksum) {
        return {
          success: false,
          error: `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        };
      }

      // Validate skill format
      let parsed: { frontmatter: SkillFrontmatter; content: string };
      try {
        parsed = parseFrontmatter(content, url);
      } catch (parseError) {
        return {
          success: false,
          error: `Invalid skill format: ${(parseError as Error).message}`,
        };
      }

      // Use name from frontmatter or provided name, sanitize to prevent path traversal
      let skillName: string;
      try {
        skillName = sanitizeSkillName(parsed.frontmatter.name || name);
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }

      // Create skill directory
      const skillDir = path.join(this.skillsDir, skillName);
      await fs.mkdir(skillDir, { recursive: true });

      // Write SKILL.md
      const skillPath = path.join(skillDir, 'SKILL.md');
      await fs.writeFile(skillPath, content, 'utf-8');

      // Write version metadata
      const versionMeta: VersionMetadata = {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        checksum: actualChecksum,
        sourceUrl: url,
      };
      await fs.writeFile(
        path.join(skillDir, '.version.json'),
        JSON.stringify(versionMeta, null, 2),
        'utf-8'
      );

      // Check gates
      const gateResult = checkGates(parsed.frontmatter.metadata);

      const skill: Skill = {
        name: skillName,
        description: parsed.frontmatter.description,
        path: skillPath,
        source: 'local',
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        available: gateResult.available,
        unavailableReason: gateResult.reason,
        hasScripts: false,
      };

      this.logger?.info(
        { name: skillName, path: skillPath, available: skill.available, checksum: actualChecksum },
        'Skill installed with verified checksum'
      );

      return {
        success: true,
        skill,
        path: skillPath,
        checksum: actualChecksum,
      };
    } catch (error) {
      return {
        success: false,
        error: `Installation failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Get installed version of a skill
   */
  async getInstalledVersion(name: string): Promise<string | null> {
    try {
      // Sanitize name to prevent path traversal
      const safeName = sanitizeSkillName(name);
      const versionPath = path.join(this.skillsDir, safeName, '.version.json');
      const content = await fs.readFile(versionPath, 'utf-8');
      const meta: VersionMetadata = JSON.parse(content);
      return meta.version;
    } catch {
      return null;
    }
  }

  /**
   * Check if an update is available for a skill
   */
  async hasUpdate(name: string): Promise<{ available: boolean; currentVersion?: string; latestVersion?: string } | null> {
    try {
      // Validate name - getInstalledVersion already sanitizes
      const currentVersion = await this.getInstalledVersion(name);
      if (!currentVersion) {
        return null;
      }

      // getPackage uses the name for API lookup, not filesystem
      const pkg = await this.getPackage(name);
      if (!pkg) {
        return null;
      }

      return {
        available: pkg.version !== currentVersion,
        currentVersion,
        latestVersion: pkg.version,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if installed version is compatible with minimum requirement
   */
  async isVersionCompatible(name: string, minVersion: string): Promise<boolean> {
    // getInstalledVersion already sanitizes the name
    const currentVersion = await this.getInstalledVersion(name);
    if (!currentVersion) {
      return false;
    }

    // Validate version format
    if (!/^\d+\.\d+\.\d+$/.test(minVersion)) {
      return false;
    }

    // Simple semver comparison (major.minor.patch)
    const current = currentVersion.split('.').map(Number);
    const min = minVersion.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const c = current[i] || 0;
      const m = min[i] || 0;
      if (c > m) return true;
      if (c < m) return false;
    }

    return true; // Equal versions
  }

  /**
   * Uninstall a skill by name
   */
  async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Sanitize name to prevent path traversal
      let safeName: string;
      try {
        safeName = sanitizeSkillName(name);
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }

      const skillDir = path.join(this.skillsDir, safeName);

      // Check if skill exists
      try {
        await fs.access(skillDir);
      } catch {
        return {
          success: false,
          error: `Skill not found: ${safeName}`,
        };
      }

      // Remove skill directory
      await fs.rm(skillDir, { recursive: true, force: true });

      this.logger?.info({ name: safeName }, 'Skill uninstalled');

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Uninstall failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * List installed skills
   */
  async listInstalled(): Promise<string[]> {
    try {
      await fs.mkdir(this.skillsDir, { recursive: true });
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      const skills: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Check if SKILL.md exists
          const skillPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
          try {
            await fs.access(skillPath);
            skills.push(entry.name);
          } catch {
            // Not a valid skill directory
          }
        }
      }

      return skills;
    } catch {
      return [];
    }
  }

  /**
   * Update a skill to latest version
   */
  async update(name: string): Promise<InstallResult> {
    // Simply reinstall - will overwrite existing
    return this.install(name);
  }

  /**
   * Update all installed skills
   */
  async updateAll(): Promise<Map<string, InstallResult>> {
    const results = new Map<string, InstallResult>();
    const installed = await this.listInstalled();

    for (const name of installed) {
      results.set(name, await this.update(name));
    }

    return results;
  }

  /**
   * Get skills directory path
   */
  getSkillsDir(): string {
    return this.skillsDir;
  }

  // ==================== ClawHub API Methods ====================

  /**
   * Search ClawHub for skills
   */
  async searchClawHub(query: string, limit: number = 10): Promise<ClawHubSkill[]> {
    try {
      const url = `${CLAWHUB_API_URL}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
      this.logger?.info({ query, limit }, 'Searching ClawHub');

      const response = await fetch(url);
      if (!response.ok) {
        this.logger?.warn({ status: response.status }, 'ClawHub search failed');
        return [];
      }

      const data = (await response.json()) as ClawHubSearchResponse;
      return data.results || [];
    } catch (error) {
      this.logger?.error({ error: (error as Error).message }, 'ClawHub search error');
      return [];
    }
  }

  /**
   * Get skill details from ClawHub
   */
  async getClawHubSkill(slug: string): Promise<ClawHubSkill | null> {
    try {
      const url = `${CLAWHUB_API_URL}/api/v1/skills/${encodeURIComponent(slug)}`;
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      // API wraps skill in a "skill" object
      const skillData = (data as { skill?: ClawHubSkill }).skill || data;
      return skillData as ClawHubSkill;
    } catch {
      return null;
    }
  }

  /**
   * Get versions of a skill from ClawHub
   */
  async getClawHubVersions(slug: string): Promise<ClawHubVersion[]> {
    try {
      const url = `${CLAWHUB_API_URL}/api/v1/skills/${encodeURIComponent(slug)}/versions`;
      const response = await fetch(url);

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      // API returns { items: [...], nextCursor: ... }
      if (Array.isArray(data)) {
        return data as ClawHubVersion[];
      }
      // Check for items (paginated response) or versions
      const wrapper = data as { items?: ClawHubVersion[]; versions?: ClawHubVersion[] };
      return wrapper.items || wrapper.versions || [];
    } catch {
      return [];
    }
  }

  /**
   * Download skill ZIP from ClawHub
   */
  async downloadFromClawHub(slug: string, version?: string): Promise<Buffer | null> {
    try {
      let url = `${CLAWHUB_API_URL}/api/v1/download?slug=${encodeURIComponent(slug)}`;
      if (version) {
        url += `&version=${encodeURIComponent(version)}`;
      }

      this.logger?.info({ slug, version }, 'Downloading from ClawHub');

      const response = await fetch(url);
      if (!response.ok) {
        this.logger?.warn({ status: response.status, slug }, 'ClawHub download failed');
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      this.logger?.error({ error: (error as Error).message, slug }, 'ClawHub download error');
      return null;
    }
  }

  /**
   * Install a skill from ClawHub
   */
  async installFromClawHub(slug: string, version?: string): Promise<InstallResult> {
    try {
      // Sanitize slug
      let safeSlug: string;
      try {
        safeSlug = sanitizeSkillName(slug);
      } catch (err) {
        return {
          success: false,
          error: (err as Error).message,
        };
      }

      this.logger?.info({ slug: safeSlug, version }, 'Installing from ClawHub');

      // Get skill info first
      const skillInfo = await this.getClawHubSkill(safeSlug);
      if (!skillInfo) {
        return {
          success: false,
          error: `Skill "${safeSlug}" not found on ClawHub`,
        };
      }

      // Download ZIP
      const zipBuffer = await this.downloadFromClawHub(safeSlug, version);
      if (!zipBuffer) {
        return {
          success: false,
          error: `Failed to download skill "${safeSlug}" from ClawHub`,
        };
      }

      // Create skill directory
      const skillDir = path.join(this.skillsDir, safeSlug);
      await fs.mkdir(skillDir, { recursive: true });

      // Extract ZIP
      try {
        const unzipped = unzipSync(new Uint8Array(zipBuffer));

        for (const [filePath, content] of Object.entries(unzipped)) {
          // Skip directories and hidden files
          if (filePath.endsWith('/') || filePath.startsWith('.') || filePath.includes('/.')) {
            continue;
          }

          const fullPath = path.join(skillDir, filePath);
          const dir = path.dirname(fullPath);

          // Create parent directories
          await fs.mkdir(dir, { recursive: true });

          // Write file
          await fs.writeFile(fullPath, content);
          this.logger?.debug({ file: filePath }, 'Extracted file');
        }
      } catch (extractError) {
        return {
          success: false,
          error: `Failed to extract ZIP: ${(extractError as Error).message}`,
        };
      }

      // Find and parse SKILL.md
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      let parsed: { frontmatter: SkillFrontmatter; content: string };

      try {
        const skillMdContent = await fs.readFile(skillMdPath, 'utf-8');
        parsed = parseFrontmatter(skillMdContent, skillMdPath);
      } catch (parseError) {
        // Clean up on failure
        await fs.rm(skillDir, { recursive: true, force: true });
        return {
          success: false,
          error: `Invalid SKILL.md format: ${(parseError as Error).message}`,
        };
      }

      // Write version metadata
      const versionMeta: VersionMetadata = {
        version: version || skillInfo.version || '1.0.0',
        installedAt: new Date().toISOString(),
        checksum: createHash('sha256').update(zipBuffer).digest('hex'),
        sourceUrl: `${CLAWHUB_API_URL}/api/v1/download?slug=${safeSlug}`,
      };
      await fs.writeFile(
        path.join(skillDir, '.version.json'),
        JSON.stringify(versionMeta, null, 2),
        'utf-8'
      );

      // Check gates
      const gateResult = checkGates(parsed.frontmatter.metadata);

      // Check if skill has scripts
      const scriptsDir = path.join(skillDir, 'scripts');
      let hasScripts = false;
      try {
        const stat = await fs.stat(scriptsDir);
        hasScripts = stat.isDirectory();
      } catch {
        // No scripts directory
      }

      const skill: Skill = {
        name: parsed.frontmatter.name || safeSlug,
        description: parsed.frontmatter.description || skillInfo.summary,
        path: skillMdPath,
        source: 'local',
        frontmatter: parsed.frontmatter,
        content: parsed.content,
        available: gateResult.available,
        unavailableReason: gateResult.reason,
        hasScripts,
        scriptsDir: hasScripts ? scriptsDir : undefined,
      };

      this.logger?.info(
        {
          name: skill.name,
          path: skillMdPath,
          available: skill.available,
          hasScripts,
          version: versionMeta.version,
        },
        'Skill installed from ClawHub'
      );

      return {
        success: true,
        skill,
        path: skillMdPath,
        checksum: versionMeta.checksum,
      };
    } catch (error) {
      return {
        success: false,
        error: `ClawHub installation failed: ${(error as Error).message}`,
      };
    }
  }
}

/**
 * Create a ClawHub client with default options
 */
export function createSkillPackageManager(options?: SkillPackageManagerOptions): SkillPackageManager {
  return new SkillPackageManager(options);
}
