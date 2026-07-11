/**
 * Bash Skill Execution Script
 *
 * Executes shell commands and returns JSON results.
 * Receives arguments via SKILL_ARGS environment variable.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Configuration
const DEFAULT_TIMEOUT = 60000; // 60 seconds
const DEFAULT_OUTPUT_SIZE = 30 * 1024; // 30KB
const ABSOLUTE_MAX_OUTPUT = 200 * 1024; // 200KB hard ceiling

// Dangerous command patterns (basic protection, not a security sandbox)
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // rm -rf / variations
  {
    pattern: /rm\s+.*-[rf]*\s+\/\s*($|[;&|])/i,
    reason: 'Removing root filesystem',
  },
  { pattern: /--no-preserve-root/i, reason: 'Bypassing root protection' },
  // Fork bombs
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/i, reason: 'Fork bomb detected' },
  { pattern: /\.\/\s*&\s*\.\/\s*&/i, reason: 'Potential fork bomb pattern' },
  // Raw device access
  { pattern: /\/dev\/sd[a-z]/i, reason: 'Direct disk device access' },
  { pattern: /\/dev\/nvme/i, reason: 'Direct NVMe device access' },
  { pattern: /\/dev\/hd[a-z]/i, reason: 'Direct disk device access' },
  // Filesystem destruction
  { pattern: /mkfs(\.[a-z0-9]+)?(\s|$)/i, reason: 'Filesystem formatting command' },
  { pattern: /dd\s+.*if=.*of=\/dev\//i, reason: 'Writing to raw device with dd' },
  // System directory writes
  { pattern: />\s*\/etc\//i, reason: 'Writing to /etc directory' },
  { pattern: />\s*\/boot\//i, reason: 'Writing to /boot directory' },
  { pattern: />\s*\/sys\//i, reason: 'Writing to /sys directory' },
  { pattern: />\s*\/proc\//i, reason: 'Writing to /proc directory' },
];

// Types
interface BashArgs {
  command: string;
  timeout?: number;
  cwd?: string;
  max_output: number;
}

interface BashResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate command against dangerous patterns
 * Note: This is basic protection to prevent obvious accidents, not a security sandbox
 */
function validateCommand(command: string): ValidationResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, reason };
    }
  }

  // Shared/global Python environments are deployment infrastructure. Artifact
  // work must not uninstall or replace packages used by other bots; an
  // explicit virtualenv executable remains allowed.
  if (/\b(?:python\d*(?:\.\d+)?\s+-m\s+pip|pip\d*(?:\.\d+)?)\s+uninstall\b/i.test(command)) {
    return {
      valid: false,
      reason: 'Global/shared pip uninstall is blocked; create an isolated virtual environment instead',
    };
  }
  const pipInstall = command.match(/(?:^|[;&|]\s*)([^\n;&|]*\bpip\d*(?:\.\d+)?\s+install\b)/i)?.[1] ?? '';
  if (pipInstall && !/(?:^|\s)(?:\.\/|\/)[^\s]*venv[^\s]*\/bin\/pip\b/i.test(pipInstall)) {
    return {
      valid: false,
      reason: 'Shared pip install is blocked; use <venv>/bin/pip inside an isolated virtual environment',
    };
  }
  const pythonPipInstall = command.match(/(?:^|[;&|]\s*)([^\n;&|]*\bpython\d*(?:\.\d+)?\s+-m\s+pip\s+install\b)/i)?.[1] ?? '';
  if (pythonPipInstall && !/(?:^|\s)(?:\.\/|\/)[^\s]*venv[^\s]*\/bin\/python\b/i.test(pythonPipInstall)) {
    return {
      valid: false,
      reason: 'Shared python -m pip install is blocked; use <venv>/bin/python -m pip inside an isolated virtual environment',
    };
  }

  // curl exits zero for HTTP 4xx/5xx unless fail mode is enabled. For writes,
  // that turns rejected API requests into false success receipts upstream.
  // Require a machine-verifiable exit status instead of trying to interpret
  // every service's error JSON after the fact.
  const mutatingCurl = /\bcurl\b[\s\S]*(?:(?:-X|--request)\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|(?:--data(?:-raw|-binary|-urlencode)?|-d)\s)/i.test(command);
  const curlFailMode = /(?:^|\s)--fail(?:-with-body)?(?:\s|$)/i.test(command)
    || /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?:\s|$)/.test(command);
  if (mutatingCurl && !curlFailMode) {
    return {
      valid: false,
      reason: 'Mutating curl requests must use --fail-with-body (or -f) so HTTP errors cannot be reported as success',
    };
  }

  const mutatingHttpie = /(?:^|[;&|\n]\s*)(?:http|https)\b[^\n;&|]*\b(?:POST|PUT|PATCH|DELETE)\b/i.test(command);
  if (mutatingHttpie && !/\B--check-status\b/i.test(command)) {
    return {
      valid: false,
      reason: 'Mutating HTTPie requests must use --check-status so HTTP errors cannot be reported as success',
    };
  }

  const mutatingPythonHttp = /\b(?:requests|httpx)\s*\.\s*(?:post|put|patch|delete)\s*\(/i.test(command);
  if (mutatingPythonHttp && !/\.raise_for_status\s*\(/i.test(command)) {
    return {
      valid: false,
      reason: 'Mutating Python HTTP requests must call raise_for_status() so HTTP errors cannot be reported as success',
    };
  }

  const mutatingNodeFetch = /\bfetch\s*\([\s\S]{0,2000}?\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(command);
  if (mutatingNodeFetch && !/(?:\.ok\b|\.status\b|status\s*[<>=])/i.test(command)) {
    return {
      valid: false,
      reason: 'Mutating fetch requests must validate response.ok/status and fail on non-2xx responses',
    };
  }
  return { valid: true };
}

/**
 * Validate working directory stays within workspace boundaries
 * Prevents path traversal attacks that could escape the workspace
 */
function validateCwd(cwd: string, basePath: string): ValidationResult {
  // Resolve both paths to absolute
  const resolvedCwd = path.resolve(basePath, cwd);
  const resolvedBase = path.resolve(basePath);

  // Use path.relative instead of a string prefix: `/tmp/workspace-evil` starts
  // with `/tmp/workspace` but is not inside it.
  const relative = path.relative(resolvedBase, resolvedCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      valid: false,
      reason: `Path traversal blocked: ${cwd} escapes workspace`,
    };
  }

  // Handle symlinks - resolve real path if it exists
  try {
    if (fs.existsSync(resolvedCwd)) {
      const realPath = fs.realpathSync(resolvedCwd);
      const realBase = fs.realpathSync(resolvedBase);
      const realRelative = path.relative(realBase, realPath);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        return {
          valid: false,
          reason: `Symlink escape blocked: resolves to ${realPath} outside workspace`,
        };
      }
    }
  } catch {
    // If realpath fails, directory doesn't exist - let bash handle that error
  }

  return { valid: true };
}

/**
 * Output result as JSON and exit
 */
function outputResult(result: BashResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

/**
 * Truncate string if it exceeds max size
 */
function truncate(str: string, maxSize: number): string {
  if (str.length <= maxSize) {
    return str;
  }
  const limitKB = Math.round(maxSize / 1024);
  return str.substring(0, maxSize) + `\n[Output truncated at ${limitKB}KB]`;
}

/**
 * Parse and validate arguments from SKILL_ARGS
 */
function parseArgs(): BashArgs {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
    // This will never execute due to process.exit in outputResult
    throw new Error('SKILL_ARGS not set');
  }

  let args: unknown;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    throw new Error('Invalid JSON');
  }

  // Validate args is an object
  if (!args || typeof args !== 'object') {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS must be a JSON object',
      exitCode: 1,
    });
    throw new Error('Invalid args type');
  }

  const argsObj = args as Record<string, unknown>;

  // Validate required command field
  if (!argsObj.command || typeof argsObj.command !== 'string') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing or invalid "command" field in SKILL_ARGS',
      exitCode: 1,
    });
    throw new Error('Missing command');
  }

  // SKILL_DIR is the skill installation folder, not the user's workspace.
  const workspaceRoot = process.env.SKILL_WORKSPACE || process.cwd();

  // Determine target cwd
  const targetCwd =
    typeof argsObj.cwd === 'string'
      ? path.resolve(workspaceRoot, argsObj.cwd)
      : workspaceRoot;

  // Validate cwd stays within workspace
  const cwdValidation = validateCwd(targetCwd, workspaceRoot);
  if (!cwdValidation.valid) {
    outputResult({
      success: false,
      output: '',
      error: `Path blocked: ${cwdValidation.reason}`,
      exitCode: 126,
    });
    throw new Error('Path validation failed');
  }

  // Resolve max_output: clamp to [DEFAULT_OUTPUT_SIZE, ABSOLUTE_MAX_OUTPUT]
  let maxOutput = DEFAULT_OUTPUT_SIZE;
  if (typeof argsObj.max_output === 'number') {
    maxOutput = Math.max(DEFAULT_OUTPUT_SIZE, Math.min(argsObj.max_output, ABSOLUTE_MAX_OUTPUT));
  }

  return {
    command: argsObj.command,
    timeout:
      typeof argsObj.timeout === 'number' ? argsObj.timeout : DEFAULT_TIMEOUT,
    cwd: targetCwd,
    max_output: maxOutput,
  };
}

/**
 * Execute bash command
 */
async function executeBash(args: BashArgs): Promise<void> {
  // Validate command against dangerous patterns
  const commandValidation = validateCommand(args.command);
  if (!commandValidation.valid) {
    outputResult({
      success: false,
      output: '',
      error: `Command blocked: ${commandValidation.reason}`,
      exitCode: 126, // Command cannot execute
    });
    return;
  }

  let stdout = '';
  let stderr = '';
  let killed = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const proc: ChildProcess = spawn('bash', ['-c', args.command], {
    cwd: args.cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Set timeout
  timeoutId = setTimeout(() => {
    killed = true;
    proc.kill('SIGTERM');
    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }, args.timeout);

  // Capture stdout
  proc.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
    if (stdout.length > args.max_output) {
      stdout = stdout.substring(0, args.max_output);
    }
  });

  // Capture stderr
  proc.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
    if (stderr.length > args.max_output) {
      stderr = stderr.substring(0, args.max_output);
    }
  });

  // Handle process completion
  proc.on('close', (code) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (killed) {
      outputResult({
        success: false,
        output: truncate(stdout, args.max_output),
        error: `Command killed due to timeout (${args.timeout}ms)`,
        exitCode: 124, // Standard timeout exit code
      });
      return;
    }

    const exitCode = code ?? 0;
    const success = exitCode === 0;

    outputResult({
      success,
      output: truncate(stdout, args.max_output),
      error: stderr || undefined,
      exitCode,
    });
  });

  // Handle spawn errors
  proc.on('error', (err) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    outputResult({
      success: false,
      output: '',
      error: `Failed to execute command: ${err.message}`,
      exitCode: 1,
    });
  });
}

// Main execution
const args = parseArgs();
executeBash(args);
