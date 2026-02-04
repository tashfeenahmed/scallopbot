/**
 * SkillExecutor - Runs skill scripts with proper environment setup and output capture
 *
 * This executor takes a skill path directly, loads its SKILL.md configuration,
 * and spawns the appropriate script with SKILL_ARGS environment variable.
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { join, extname, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * Options for executing a skill
 */
export interface SkillExecuteOptions {
  /** Path to skill directory (e.g., src/skills/bundled/bash) */
  skillPath: string;
  /** Action name from scripts mapping (e.g., "run") */
  action: string;
  /** Arguments to pass as SKILL_ARGS */
  args: Record<string, unknown>;
  /** Override workspace root (defaults to cwd) */
  workspaceRoot?: string;
  /** Override default timeout in milliseconds */
  timeout?: number;
}

/**
 * Result from skill execution
 */
export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

/**
 * Parsed skill configuration from SKILL.md frontmatter
 */
interface SkillConfig {
  name: string;
  description: string;
  scripts?: Record<string, string>;
}

/** Default timeout for script execution (30 seconds) */
const DEFAULT_TIMEOUT = 30000;

/** Grace period before SIGKILL after SIGTERM (5 seconds) */
const SIGKILL_GRACE_PERIOD = 5000;

/**
 * SkillExecutor class for running skill scripts
 *
 * Usage:
 * ```typescript
 * const executor = new SkillExecutor();
 * const result = await executor.execute({
 *   skillPath: './src/skills/bundled/bash',
 *   action: 'run',
 *   args: { command: 'echo hello' }
 * });
 * ```
 */
export class SkillExecutor {
  /**
   * Execute a skill script
   *
   * @param options - Execution options including skill path, action, and arguments
   * @returns Promise<SkillResult> - The result of script execution
   * @throws Error if SKILL.md not found or script not found
   */
  async execute(options: SkillExecuteOptions): Promise<SkillResult> {
    const { skillPath, action, args, workspaceRoot, timeout } = options;

    // Resolve skill path to absolute
    const absoluteSkillPath = resolve(skillPath);

    // Load skill configuration
    const config = await this.loadSkillConfig(absoluteSkillPath);

    // Find script path for the requested action
    const scriptRelativePath = config.scripts?.[action];
    if (!scriptRelativePath) {
      throw new Error(
        `Script not found: No script mapping for action "${action}" in skill "${config.name}". ` +
          `Available actions: ${Object.keys(config.scripts || {}).join(', ') || 'none'}`
      );
    }

    // Resolve full script path
    const scriptPath = join(absoluteSkillPath, scriptRelativePath);
    if (!existsSync(scriptPath)) {
      throw new Error(
        `Script not found: ${scriptPath} does not exist for action "${action}"`
      );
    }

    // Determine runner based on file extension
    const ext = extname(scriptPath);
    let command: string;
    let commandArgs: string[];

    switch (ext) {
      case '.ts':
        command = 'npx';
        commandArgs = ['tsx', scriptPath];
        break;
      case '.js':
        command = 'node';
        commandArgs = [scriptPath];
        break;
      case '.sh':
        command = 'bash';
        commandArgs = [scriptPath];
        break;
      default:
        throw new Error(
          `Unsupported script type: ${ext}. Supported extensions: .ts, .js, .sh`
        );
    }

    // Prepare environment variables
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SKILL_ARGS: JSON.stringify(args),
      SKILL_DIR: workspaceRoot || process.cwd(),
    };

    // Execute script and capture output
    return this.spawnScript(command, commandArgs, env, timeout ?? DEFAULT_TIMEOUT);
  }

  /**
   * Load skill configuration from SKILL.md
   *
   * @param skillPath - Absolute path to skill directory
   * @returns SkillConfig parsed from YAML frontmatter
   * @throws Error if SKILL.md not found or invalid format
   */
  async loadSkillConfig(skillPath: string): Promise<SkillConfig> {
    const skillMdPath = join(skillPath, 'SKILL.md');

    if (!existsSync(skillMdPath)) {
      throw new Error(`SKILL.md not found: ${skillMdPath}`);
    }

    const content = await readFile(skillMdPath, 'utf-8');

    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      throw new Error(
        `Invalid SKILL.md format: No YAML frontmatter found in ${skillMdPath}`
      );
    }

    const frontmatter = frontmatterMatch[1];

    // Simple YAML parsing for the fields we need
    const config: SkillConfig = {
      name: this.parseYamlField(frontmatter, 'name') || 'unknown',
      description: this.parseYamlField(frontmatter, 'description') || '',
      scripts: this.parseYamlScripts(frontmatter),
    };

    return config;
  }

  /**
   * Parse a simple YAML field value
   */
  private parseYamlField(yaml: string, field: string): string | undefined {
    const match = yaml.match(new RegExp(`^${field}:\\s*["']?([^"'\\n]+)["']?`, 'm'));
    return match?.[1]?.trim();
  }

  /**
   * Parse the scripts mapping from YAML
   */
  private parseYamlScripts(yaml: string): Record<string, string> | undefined {
    const scriptsMatch = yaml.match(/scripts:\r?\n((?:[ \t]+\w+:[ \t]*["']?[^\n]+["']?\r?\n?)+)/);
    if (!scriptsMatch) {
      return undefined;
    }

    const scriptsBlock = scriptsMatch[1];
    const scripts: Record<string, string> = {};

    const lineRegex = /^\s+(\w+):\s*["']?([^"'\n]+)["']?/gm;
    let match;
    while ((match = lineRegex.exec(scriptsBlock)) !== null) {
      scripts[match[1]] = match[2].trim();
    }

    return Object.keys(scripts).length > 0 ? scripts : undefined;
  }

  /**
   * Spawn script process and capture output with timeout handling
   *
   * Timeout behavior:
   * 1. After timeout expires, sends SIGTERM for graceful shutdown
   * 2. After additional 5 seconds, sends SIGKILL if still running
   * 3. Returns exitCode 124 (standard timeout exit code)
   */
  private spawnScript(
    command: string,
    args: string[],
    env: Record<string, string>,
    timeout: number
  ): Promise<SkillResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let killTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const proc: ChildProcess = spawn(command, args, {
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      /**
       * Clean up timers and event listeners
       */
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (killTimeoutId) {
          clearTimeout(killTimeoutId);
          killTimeoutId = null;
        }
        // Remove event listeners to prevent memory leaks
        proc.stdout?.removeAllListeners('data');
        proc.stderr?.removeAllListeners('data');
        proc.removeAllListeners('close');
        proc.removeAllListeners('error');
      };

      /**
       * Resolve the promise with result (only once)
       */
      const resolveOnce = (result: SkillResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      // Set up timeout with graceful shutdown
      timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');

        // Set up SIGKILL after grace period if still running
        killTimeoutId = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_PERIOD);
      }, timeout);

      // Capture stdout
      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      // Capture stderr
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Handle process completion
      proc.on('close', (code) => {
        // If killed by timeout, return timeout result
        if (killed) {
          resolveOnce({
            success: false,
            output: stdout,
            error: `Script killed due to timeout (${timeout}ms)`,
            exitCode: 124, // Standard timeout exit code
          });
          return;
        }

        const exitCode = code ?? 0;

        // Try to parse stdout as JSON (skill result format)
        try {
          const parsed = JSON.parse(stdout.trim());
          resolveOnce({
            success: parsed.success ?? exitCode === 0,
            output: parsed.output ?? stdout,
            error: parsed.error ?? (stderr || undefined),
            exitCode: parsed.exitCode ?? exitCode,
          });
        } catch {
          // If not valid JSON, return raw output
          resolveOnce({
            success: exitCode === 0,
            output: stdout,
            error: stderr || undefined,
            exitCode,
          });
        }
      });

      // Handle spawn errors
      proc.on('error', (err) => {
        resolveOnce({
          success: false,
          output: '',
          error: `Failed to execute script: ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }
}
