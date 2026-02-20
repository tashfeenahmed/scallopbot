/**
 * Glob Skill Execution Script
 *
 * Finds files matching a glob pattern using gitignore-aware walking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { walk } from '../../_shared/walk.js';

interface GlobArgs {
  pattern: string;
  path?: string;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const MAX_RESULTS = 200;

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

function validatePath(filePath: string, workspaceRoot: string): { valid: boolean; resolved: string; reason?: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const allowedRoots = [
    workspaceRoot,
    path.join(homeDir, '.scallopbot'),
  ];

  const isAllowed = allowedRoots.some(root => resolved.startsWith(root));
  if (!isAllowed) {
    return { valid: false, resolved, reason: 'Path outside allowed directories' };
  }

  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realAllowed = allowedRoots.some(root => {
        try {
          const realRoot = fs.realpathSync(root);
          return realPath.startsWith(realRoot);
        } catch {
          return false;
        }
      });
      if (!realAllowed) {
        return { valid: false, resolved, reason: 'Symlink escapes allowed directories' };
      }
    }
  } catch {
    // Let the operation handle missing dirs
  }

  return { valid: true, resolved };
}

async function main(): Promise<void> {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: GlobArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.pattern) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: pattern', exitCode: 1 });
    return;
  }

  // Determine search root
  let searchRoot = workspaceRoot;
  if (args.path) {
    const validation = validatePath(args.path, workspaceRoot);
    if (!validation.valid) {
      outputResult({ success: false, output: '', error: `Path blocked: ${validation.reason}`, exitCode: 1 });
      return;
    }
    searchRoot = validation.resolved;
  }

  if (!fs.existsSync(searchRoot)) {
    outputResult({ success: false, output: '', error: `Directory not found: ${args.path}`, exitCode: 1 });
    return;
  }

  try {
    const files: string[] = [];
    for await (const filePath of walk({ root: searchRoot, globPattern: args.pattern, maxFiles: MAX_RESULTS, skipBinary: false })) {
      files.push(filePath);
    }

    files.sort();

    const truncated = files.length >= MAX_RESULTS;
    let output = files.join('\n');
    if (truncated) {
      output += `\n... (truncated to ${MAX_RESULTS} results)`;
    }

    outputResult({
      success: true,
      output: output || '(no matches)',
      exitCode: 0,
    });
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Glob failed: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }
}

main();
