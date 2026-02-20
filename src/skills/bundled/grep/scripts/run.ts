/**
 * Grep Skill Execution Script
 *
 * Searches file contents using regex. Tries ripgrep first, falls back to JS.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { walk } from '../../_shared/walk.js';

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  context?: number;
  max_results?: number;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const DEFAULT_MAX_RESULTS = 50;

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
    // pass
  }

  return { valid: true, resolved };
}

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function searchWithRipgrep(pattern: string, searchRoot: string, glob: string | undefined, context: number, maxResults: number): string {
  const args = [
    '--no-heading',
    '--line-number',
    '--max-count', String(maxResults),
    '--color', 'never',
  ];

  if (context > 0) {
    args.push('--context', String(context));
  }

  if (glob) {
    args.push('--glob', glob);
  }

  args.push(pattern, searchRoot);

  try {
    const result = execFileSync('rg', args, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    // Make paths relative to searchRoot
    return result
      .split('\n')
      .map(line => {
        if (line.startsWith(searchRoot)) {
          return line.slice(searchRoot.length + 1);
        }
        return line;
      })
      .join('\n')
      .trim();
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    // rg exits 1 when no matches found
    if (err.status === 1) return '';
    throw e;
  }
}

async function searchWithJs(pattern: string, searchRoot: string, glob: string | undefined, context: number, maxResults: number): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }

  const matches: string[] = [];

  for await (const filePath of walk({ root: searchRoot, globPattern: glob, skipBinary: true })) {
    if (matches.length >= maxResults) break;

    const fullPath = path.join(searchRoot, filePath);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;

      if (regex.test(lines[i])) {
        // Add context lines
        const start = Math.max(0, i - context);
        const end = Math.min(lines.length - 1, i + context);

        for (let j = start; j <= end; j++) {
          const sep = j === i ? ':' : '-';
          matches.push(`${filePath}${sep}${j + 1}${sep} ${lines[j]}`);
        }

        if (context > 0 && end < lines.length - 1) {
          matches.push('--');
        }
      }
    }
  }

  return matches.join('\n');
}

async function main(): Promise<void> {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: GrepArgs;
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

  const maxResults = Math.min(args.max_results || DEFAULT_MAX_RESULTS, 500);
  const context = Math.min(args.context || 0, 10);

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
    let output: string;

    if (hasRipgrep()) {
      output = searchWithRipgrep(args.pattern, searchRoot, args.glob, context, maxResults);
    } else {
      output = await searchWithJs(args.pattern, searchRoot, args.glob, context, maxResults);
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
      error: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }
}

main();
