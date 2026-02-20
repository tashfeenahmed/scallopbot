/**
 * Apply Patch Skill Execution Script
 *
 * Parses and applies unified diff patches to files.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ApplyPatchArgs {
  path: string;
  patch: string;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

const FUZZ_TOLERANCE = 3;

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

/**
 * Parse unified diff into hunks.
 */
function parseHunks(patch: string): Hunk[] {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('diff ')) continue;
    if (line.startsWith('index ')) continue;

    // Parse hunk header
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      current = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    // Add line to current hunk
    if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '')) {
      // Treat empty lines in a hunk as context (space-prefixed)
      if (line === '' && current.lines.length > 0) {
        current.lines.push(' ');
      } else {
        current.lines.push(line);
      }
    }
  }

  return hunks;
}

/**
 * Find the best match position for a hunk's context, with fuzz tolerance.
 */
function findHunkPosition(fileLines: string[], hunk: Hunk): number | null {
  // Extract context and removed lines from hunk (these are what we expect in the file)
  const expectedLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith(' ') || line.startsWith('-')) {
      expectedLines.push(line.slice(1));
    }
  }

  if (expectedLines.length === 0) {
    // Pure addition — use the hunk start position
    return hunk.oldStart - 1;
  }

  // Try exact position first
  const exactPos = hunk.oldStart - 1;
  if (matchesAt(fileLines, expectedLines, exactPos)) {
    return exactPos;
  }

  // Try with fuzz tolerance
  for (let offset = 1; offset <= FUZZ_TOLERANCE; offset++) {
    if (matchesAt(fileLines, expectedLines, exactPos - offset)) {
      return exactPos - offset;
    }
    if (matchesAt(fileLines, expectedLines, exactPos + offset)) {
      return exactPos + offset;
    }
  }

  return null;
}

function matchesAt(fileLines: string[], expectedLines: string[], position: number): boolean {
  if (position < 0 || position + expectedLines.length > fileLines.length) {
    return false;
  }

  for (let i = 0; i < expectedLines.length; i++) {
    if (fileLines[position + i] !== expectedLines[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Apply a single hunk at a given position.
 */
function applyHunk(fileLines: string[], hunk: Hunk, position: number): string[] {
  const result = [...fileLines];
  let resultPos = position;
  let deleteCount = 0;
  const insertLines: string[] = [];

  // Count deletes and collect inserts
  for (const line of hunk.lines) {
    if (line.startsWith('-')) {
      deleteCount++;
    } else if (line.startsWith('+')) {
      insertLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // Context line — flush pending operations
      if (deleteCount > 0 || insertLines.length > 0) {
        result.splice(resultPos, deleteCount, ...insertLines);
        resultPos += insertLines.length;
        deleteCount = 0;
        insertLines.length = 0;
      }
      resultPos++;
    }
  }

  // Flush remaining operations
  if (deleteCount > 0 || insertLines.length > 0) {
    result.splice(resultPos, deleteCount, ...insertLines);
  }

  return result;
}

function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: ApplyPatchArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.path) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: path', exitCode: 1 });
    return;
  }

  if (!args.patch) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: patch', exitCode: 1 });
    return;
  }

  const validation = validatePath(args.path, workspaceRoot);
  if (!validation.valid) {
    outputResult({ success: false, output: '', error: `Path blocked: ${validation.reason}`, exitCode: 1 });
    return;
  }

  const filePath = validation.resolved;

  if (!fs.existsSync(filePath)) {
    outputResult({ success: false, output: '', error: `File not found: ${args.path}`, exitCode: 1 });
    return;
  }

  if (fs.statSync(filePath).isDirectory()) {
    outputResult({ success: false, output: '', error: `Path is a directory: ${args.path}`, exitCode: 1 });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    outputResult({ success: false, output: '', error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  const hunks = parseHunks(args.patch);
  if (hunks.length === 0) {
    outputResult({ success: false, output: '', error: 'No valid hunks found in patch', exitCode: 1 });
    return;
  }

  let fileLines = content.split('\n');

  // Sort hunks by old start position (descending) to apply bottom-up
  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  // Find positions for all hunks first (validate before applying)
  const positions: Map<Hunk, number> = new Map();
  for (const hunk of sortedHunks) {
    const pos = findHunkPosition(fileLines, hunk);
    if (pos === null) {
      outputResult({
        success: false,
        output: '',
        error: `Hunk at line ${hunk.oldStart} failed to apply: context lines don't match`,
        exitCode: 1,
      });
      return;
    }
    positions.set(hunk, pos);
  }

  // Apply hunks bottom-up
  for (const hunk of sortedHunks) {
    const pos = positions.get(hunk)!;
    fileLines = applyHunk(fileLines, hunk, pos);
  }

  try {
    fs.writeFileSync(filePath, fileLines.join('\n'), 'utf-8');
    outputResult({
      success: true,
      output: `Applied ${hunks.length} hunk(s) to ${args.path}`,
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
