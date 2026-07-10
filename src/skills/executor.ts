/**
 * Skill Executor
 *
 * Executes scripts from skill's scripts/ folder.
 * Supports TypeScript (.ts), JavaScript (.js), and Shell (.sh) scripts.
 */

import { spawn } from 'child_process';
import { access, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { constants } from 'fs';
import type { Logger } from 'pino';
import type { Skill, SkillExecutionRequest, SkillExecutionResult } from './types.js';
import { redactSensitiveText } from '../security/redaction.js';

/** Default timeout for script execution (120 seconds for browser/screenshot operations) */
const DEFAULT_TIMEOUT_MS = 120000;

/** Maximum output size in bytes (1MB) to prevent OOM from runaway scripts */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Operational knobs for skill execution (sourced from config.tuning.skills). */
export interface SkillExecutorOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Best-effort telemetry hook used by the skill curator/evolution layer. */
  onSkillExecuted?: (name: string, success: boolean, durationMs: number) => void | Promise<void>;
}

/** Non-secret process settings needed to locate runtimes and temporary files. */
const SAFE_BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  // Windows process discovery/runtime keys.
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
] as const;

/** Non-secret Smartbot runtime paths/config used by bundled skills. */
const SAFE_SMARTBOT_ENV_KEYS = [
  'AGENT_WORKSPACE', 'MEMORY_DB_PATH', 'SCALLOPBOT_DATA_DIR',
  'OLLAMA_BASE_URL', 'LOCAL_BASE_URL',
] as const;

function copyDefinedEnv(target: Record<string, string>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') target[key] = value;
  }
}

/**
 * Construct a least-privilege environment for a skill process.
 *
 * Provider keys, bot tokens and other service secrets are no longer inherited
 * wholesale. A skill receives a sensitive variable only when its frontmatter
 * explicitly declares it in `requires.env` or as `primaryEnv`.
 */
export function buildSkillSubprocessEnv(
  skill: Skill,
  request: SkillExecutionRequest,
  timezone?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  copyDefinedEnv(env, SAFE_BASE_ENV_KEYS);
  copyDefinedEnv(env, SAFE_SMARTBOT_ENV_KEYS);

  const openclaw = skill.frontmatter.metadata?.openclaw;
  const explicitlyAllowed = new Set(openclaw?.requires?.env ?? []);
  if (openclaw?.primaryEnv) explicitlyAllowed.add(openclaw.primaryEnv);
  copyDefinedEnv(env, [...explicitlyAllowed]);

  env.SKILL_NAME = skill.name;
  env.SKILL_DIR = skill.scriptsDir ? join(skill.scriptsDir, '..') : '';
  env.SKILL_ARGS = JSON.stringify(request.args || {});
  env.SKILL_WORKSPACE = process.env.AGENT_WORKSPACE || request.cwd || process.cwd();
  env.SKILL_CWD = request.cwd || env.SKILL_WORKSPACE;
  if (request.userId) env.SKILL_USER_ID = request.userId;
  if (request.sessionId) env.SKILL_SESSION_ID = request.sessionId;
  if (request.userId && timezone) env.SKILL_USER_TIMEZONE = timezone;
  return env;
}

/**
 * Skill Executor class for running scripts from skill folders
 */
export class SkillExecutor {
  private getTimezone?: (userId: string) => string;
  private scriptPathCache = new Map<string, string | null>();
  private timeoutMs: number;
  private maxOutputBytes: number;
  private onSkillExecuted?: SkillExecutorOptions['onSkillExecuted'];

  constructor(private logger?: Logger, getTimezone?: (userId: string) => string, options?: SkillExecutorOptions) {
    this.getTimezone = getTimezone;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.onSkillExecuted = options?.onSkillExecuted;
  }

  /**
   * Execute a skill script
   */
  async execute(
    skill: Skill,
    request: SkillExecutionRequest
  ): Promise<SkillExecutionResult> {
    const startedAt = Date.now();
    let result: SkillExecutionResult;
    try {
      result = await this.executeInternal(skill, request);
    } catch (error) {
      result = {
        success: false,
        error: `Failed to execute skill: ${(error as Error).message}`,
        exitCode: 1,
      };
    }

    try {
      await this.onSkillExecuted?.(skill.name, result.success, Date.now() - startedAt);
    } catch (error) {
      this.logger?.debug(
        { skill: skill.name, error: (error as Error).message },
        'Skill telemetry hook failed (non-fatal)',
      );
    }
    return result;
  }

  private async executeInternal(
    skill: Skill,
    request: SkillExecutionRequest,
  ): Promise<SkillExecutionResult> {
    // Verify skill has scripts
    if (!skill.hasScripts || !skill.scriptsDir) {
      return {
        success: false,
        error: `Skill "${skill.name}" does not have executable scripts`,
        exitCode: 1,
      };
    }

    // Resolve script path
    const scriptPath = await this.resolveScript(skill, request.action);
    if (!scriptPath) {
      const action = request.action || 'run/default';
      return {
        success: false,
        error: `No script found for action "${action}" in skill "${skill.name}". Available scripts are in: ${skill.scriptsDir}`,
        exitCode: 1,
      };
    }

    // Verify script exists
    try {
      await access(scriptPath, constants.R_OK);
    } catch {
      return {
        success: false,
        error: `Script not found or not readable: ${scriptPath}`,
        exitCode: 1,
      };
    }

    // Execute the script
    return this.runScript(scriptPath, skill, request);
  }

  /**
   * Resolve script path for an action
   *
   * Priority:
   * 1. Frontmatter scripts mapping (if action specified and exists in mapping)
   * 2. scripts/{action}.ts / .sh / .js (if action specified)
   * 3. scripts/run.ts / .sh / .js (default)
   * 4. scripts/default.ts / .sh / .js (fallback)
   */
  async resolveScript(skill: Skill, action?: string): Promise<string | null> {
    if (!skill.scriptsDir) {
      return null;
    }

    // Skill scripts are immutable at runtime — cache the resolved path so
    // we don't pay 3-9 fs.access() syscalls on every tool invocation.
    const cacheKey = `${skill.name}|${action || ''}`;
    if (this.scriptPathCache.has(cacheKey)) {
      return this.scriptPathCache.get(cacheKey)!;
    }

    const resolved = await this.resolveScriptUncached(skill, action);
    this.scriptPathCache.set(cacheKey, resolved);
    return resolved;
  }

  private async resolveScriptUncached(skill: Skill, action?: string): Promise<string | null> {
    const scriptsDir = skill.scriptsDir!;
    const frontmatterScripts = skill.frontmatter.scripts;

    // 1. Check frontmatter scripts mapping
    if (action && frontmatterScripts?.[action]) {
      const scriptPath = join(scriptsDir, '..', frontmatterScripts[action]);
      if (await this.fileExists(scriptPath)) {
        return scriptPath;
      }
    }

    // 2. Check for action-specific script
    if (action) {
      const actionScript = await this.findScriptByName(scriptsDir, action);
      if (actionScript) {
        return actionScript;
      }
    }

    // 3. Check for 'run' script (default)
    const runScript = await this.findScriptByName(scriptsDir, 'run');
    if (runScript) {
      return runScript;
    }

    // 4. Check for 'default' script (fallback)
    const defaultScript = await this.findScriptByName(scriptsDir, 'default');
    if (defaultScript) {
      return defaultScript;
    }

    return null;
  }

  /**
   * Find a script by base name (without extension)
   * Checks for .ts, .sh, .js in that order
   */
  private async findScriptByName(
    scriptsDir: string,
    baseName: string
  ): Promise<string | null> {
    const extensions = ['.ts', '.sh', '.js'];

    for (const ext of extensions) {
      const scriptPath = join(scriptsDir, `${baseName}${ext}`);
      if (await this.fileExists(scriptPath)) {
        return scriptPath;
      }
    }

    return null;
  }

  /**
   * Check if a file exists
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
   * Run a script and capture output
   */
  private async runScript(
    scriptPath: string,
    skill: Skill,
    request: SkillExecutionRequest
  ): Promise<SkillExecutionResult> {
    const ext = extname(scriptPath);
    let command: string;
    let args: string[];

    // Determine how to run the script based on extension
    switch (ext) {
      case '.ts':
        command = 'npx';
        args = ['tsx', scriptPath];
        break;
      case '.js':
        command = 'node';
        args = [scriptPath];
        break;
      case '.sh':
        command = 'bash';
        args = [scriptPath];
        break;
      default:
        return {
          success: false,
          error: `Unsupported script type: ${ext}. Supported: .ts, .js, .sh`,
          exitCode: 1,
        };
    }

    // Prepare environment variables
    const timezone = request.userId && this.getTimezone
      ? this.getTimezone(request.userId)
      : undefined;
    const env = buildSkillSubprocessEnv(skill, request, timezone);

    // Working directory: use request.cwd, or AGENT_WORKSPACE, or process.cwd()
    const cwd = request.cwd || process.env.AGENT_WORKSPACE || process.cwd();

    this.logger?.debug(
      { skill: skill.name, script: scriptPath, command, args, cwd },
      'Executing skill script'
    );

    return new Promise((resolve) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let resolved = false;
      let outputBytes = 0;
      let outputTruncated = false;

      const done = (result: SkillExecutionResult) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      const child = spawn(command, args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Set timeout
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        done({
          success: false,
          output: redactSensitiveText(stdout.join('')),
          error: `Script timed out after ${this.timeoutMs}ms`,
          exitCode: 124, // Standard timeout exit code
        });
      }, this.timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        if (outputTruncated) return;
        outputBytes += data.length;
        if (outputBytes > this.maxOutputBytes) {
          outputTruncated = true;
          stdout.push(`\n[OUTPUT TRUNCATED - exceeded ${this.maxOutputBytes} byte limit]`);
          child.kill('SIGTERM');
          return;
        }
        stdout.push(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (outputTruncated) return;
        stderr.push(data.toString());
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        done({
          success: false,
          error: `Failed to execute script: ${error.message}`,
          exitCode: 1,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const exitCode = code ?? 0;
        const success = exitCode === 0;

        done({
          success,
          output: redactSensitiveText(stdout.join('')),
          error: stderr.length > 0 ? redactSensitiveText(stderr.join('')) : undefined,
          exitCode,
        });

        this.logger?.debug(
          { skill: skill.name, exitCode, success },
          'Script execution completed'
        );
      });
    });
  }

  /**
   * List available scripts for a skill
   */
  async listScripts(skill: Skill): Promise<string[]> {
    if (!skill.scriptsDir) {
      return [];
    }

    try {
      const entries = await readdir(skill.scriptsDir);
      const scripts: string[] = [];

      for (const entry of entries) {
        const ext = extname(entry);
        if (['.ts', '.js', '.sh'].includes(ext)) {
          scripts.push(entry);
        }
      }

      return scripts;
    } catch {
      return [];
    }
  }
}

/**
 * Create a skill executor instance
 */
export function createSkillExecutor(
  logger?: Logger,
  getTimezone?: (userId: string) => string,
  options?: SkillExecutorOptions,
): SkillExecutor {
  return new SkillExecutor(logger, getTimezone, options);
}
