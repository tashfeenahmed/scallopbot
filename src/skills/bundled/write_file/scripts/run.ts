/**
 * Write File Skill Execution Script
 *
 * Writes content to a file, creating directories if needed.
 */

import * as fs from 'fs';
import * as path from 'path';

interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
  createDirs?: boolean;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

function validatePath(filePath: string, workspaceRoot: string): { valid: boolean; resolved: string; reason?: string } {
  const resolved = path.resolve(workspaceRoot, filePath);

  // Check if path stays within workspace
  if (!resolved.startsWith(workspaceRoot)) {
    return { valid: false, resolved, reason: 'Path escapes workspace' };
  }

  // Block system directories
  const blocked = ['/etc', '/boot', '/sys', '/proc', '/dev', '/bin', '/sbin', '/usr'];
  for (const dir of blocked) {
    if (resolved.startsWith(dir)) {
      return { valid: false, resolved, reason: `Cannot write to system directory: ${dir}` };
    }
  }

  // Check parent directory symlinks if exists
  const parentDir = path.dirname(resolved);
  try {
    if (fs.existsSync(parentDir)) {
      const realPath = fs.realpathSync(parentDir);
      const realBase = fs.realpathSync(workspaceRoot);
      if (!realPath.startsWith(realBase)) {
        return { valid: false, resolved, reason: 'Parent symlink escapes workspace' };
      }
    }
  } catch {
    // Parent doesn't exist yet, will be created
  }

  return { valid: true, resolved };
}

function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
    return;
  }

  let args: WriteFileArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  if (!args.path) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: path',
      exitCode: 1,
    });
    return;
  }

  if (args.content === undefined || args.content === null) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: content',
      exitCode: 1,
    });
    return;
  }

  // Validate path
  const validation = validatePath(args.path, workspaceRoot);
  if (!validation.valid) {
    outputResult({
      success: false,
      output: '',
      error: `Path blocked: ${validation.reason}`,
      exitCode: 1,
    });
    return;
  }

  const filePath = validation.resolved;
  const createDirs = args.createDirs !== false; // Default true
  const append = args.append === true;

  // Create parent directories if needed
  const parentDir = path.dirname(filePath);
  if (createDirs && !fs.existsSync(parentDir)) {
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (e) {
      outputResult({
        success: false,
        output: '',
        error: `Failed to create directory: ${e instanceof Error ? e.message : String(e)}`,
        exitCode: 1,
      });
      return;
    }
  }

  // Check if target exists and is a directory
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    outputResult({
      success: false,
      output: '',
      error: `Path is a directory: ${args.path}`,
      exitCode: 1,
    });
    return;
  }

  // Write file
  try {
    if (append) {
      fs.appendFileSync(filePath, args.content, 'utf-8');
    } else {
      fs.writeFileSync(filePath, args.content, 'utf-8');
    }

    const bytes = Buffer.byteLength(args.content, 'utf-8');
    const action = append ? 'Appended to' : 'Wrote';

    outputResult({
      success: true,
      output: `${action} file: ${args.path} (${bytes} bytes)`,
      exitCode: 0,
    });
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }
}

main();
