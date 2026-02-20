/**
 * ls Skill Execution Script
 *
 * Lists files and directories with optional detail mode.
 */

import * as fs from 'fs';
import * as path from 'path';

interface LsArgs {
  path?: string;
  all?: boolean;
  long?: boolean;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const MAX_ENTRIES = 500;

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
    // Let the operation handle missing files
  }

  return { valid: true, resolved };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
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

  let args: LsArgs;
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

  const targetPath = args.path || '.';
  const showAll = args.all === true;
  const longMode = args.long === true;

  const validation = validatePath(targetPath, workspaceRoot);
  if (!validation.valid) {
    outputResult({
      success: false,
      output: '',
      error: `Path blocked: ${validation.reason}`,
      exitCode: 1,
    });
    return;
  }

  const dirPath = validation.resolved;

  if (!fs.existsSync(dirPath)) {
    outputResult({
      success: false,
      output: '',
      error: `Directory not found: ${targetPath}`,
      exitCode: 1,
    });
    return;
  }

  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) {
    outputResult({
      success: false,
      output: '',
      error: `Not a directory: ${targetPath}`,
      exitCode: 1,
    });
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to read directory: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  // Filter hidden files unless --all
  if (!showAll) {
    entries = entries.filter(e => !e.name.startsWith('.'));
  }

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    const aIsDir = a.isDirectory() ? 0 : 1;
    const bIsDir = b.isDirectory() ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name);
  });

  // Cap entries
  const truncated = entries.length > MAX_ENTRIES;
  entries = entries.slice(0, MAX_ENTRIES);

  let output: string;

  if (longMode) {
    const lines: string[] = [];
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const st = fs.statSync(fullPath);
        const type = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-';
        const size = formatSize(st.size);
        const mtime = st.mtime.toISOString().slice(0, 16).replace('T', ' ');
        const suffix = entry.isDirectory() ? '/' : '';
        lines.push(`${type} ${size.padStart(7)} ${mtime} ${entry.name}${suffix}`);
      } catch {
        const suffix = entry.isDirectory() ? '/' : '';
        lines.push(`? ${' '.repeat(7)} ${'?'.repeat(16)} ${entry.name}${suffix}`);
      }
    }
    output = lines.join('\n');
  } else {
    output = entries
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .join('\n');
  }

  if (truncated) {
    output += `\n... (truncated to ${MAX_ENTRIES} entries)`;
  }

  outputResult({
    success: true,
    output,
    exitCode: 0,
  });
}

main();
