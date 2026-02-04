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

/** Default timeout for script execution (60 seconds for browser operations) */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Skill Executor class for running scripts from skill folders
 */
export class SkillExecutor {
  constructor(private logger?: Logger) {}

  /**
   * Execute a skill script
   */
  async execute(
    skill: Skill,
    request: SkillExecutionRequest
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

    const scriptsDir = skill.scriptsDir;
    const frontmatterScripts = skill.frontmatter.scripts;

    // 1. Check frontmatter scripts mapping
    if (action && frontmatterScripts?.[action]) {
      const scriptPath = join(skill.scriptsDir, '..', frontmatterScripts[action]);
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
    const env: Record<string, string> = {
      ...process.env,
      SKILL_NAME: skill.name,
      SKILL_DIR: skill.scriptsDir ? join(skill.scriptsDir, '..') : '',
      SKILL_ARGS: JSON.stringify(request.args || {}),
      SKILL_WORKSPACE: process.env.AGENT_WORKSPACE || process.cwd(),
    };

    // Working directory: use request.cwd, or skill directory, or process.cwd()
    const cwd = request.cwd || (skill.scriptsDir ? join(skill.scriptsDir, '..') : process.cwd());

    this.logger?.debug(
      { skill: skill.name, script: scriptPath, command, args, cwd },
      'Executing skill script'
    );

    return new Promise((resolve) => {
      const stdout: string[] = [];
      const stderr: string[] = [];

      const child = spawn(command, args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Set timeout
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          success: false,
          output: stdout.join(''),
          error: `Script timed out after ${DEFAULT_TIMEOUT_MS}ms`,
          exitCode: 124, // Standard timeout exit code
        });
      }, DEFAULT_TIMEOUT_MS);

      child.stdout?.on('data', (data: Buffer) => {
        stdout.push(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr.push(data.toString());
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: `Failed to execute script: ${error.message}`,
          exitCode: 1,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const exitCode = code ?? 0;
        const success = exitCode === 0;

        resolve({
          success,
          output: stdout.join(''),
          error: stderr.length > 0 ? stderr.join('') : undefined,
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
export function createSkillExecutor(logger?: Logger): SkillExecutor {
  return new SkillExecutor(logger);
}
