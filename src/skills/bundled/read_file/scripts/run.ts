/**
 * Read File Skill Execution Script
 *
 * Reads file contents with optional line range.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: BufferEncoding;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  metadata?: {
    path: string;
    lines: number;
    size: number;
    truncated?: boolean;
  };
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

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

  // Check symlinks
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realBase = fs.realpathSync(workspaceRoot);
      if (!realPath.startsWith(realBase)) {
        return { valid: false, resolved, reason: 'Symlink escapes workspace' };
      }
    }
  } catch {
    // Let the read operation handle missing files
  }

  return { valid: true, resolved };
}

function isBinaryFile(buffer: Buffer): boolean {
  // Check for null bytes in first 8KB (indicates binary)
  const sample = buffer.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
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

  let args: ReadFileArgs;
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

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    outputResult({
      success: false,
      output: '',
      error: `File not found: ${args.path}`,
      exitCode: 1,
    });
    return;
  }

  // Check if it's a directory
  const stats = fs.statSync(filePath);
  if (stats.isDirectory()) {
    outputResult({
      success: false,
      output: '',
      error: `Path is a directory, not a file: ${args.path}`,
      exitCode: 1,
    });
    return;
  }

  // Check file size
  if (stats.size > MAX_FILE_SIZE) {
    outputResult({
      success: false,
      output: '',
      error: `File too large (${Math.round(stats.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use offset/limit for partial read.`,
      exitCode: 1,
    });
    return;
  }

  // Read file
  const encoding = args.encoding || 'utf-8';
  let content: string;
  try {
    const buffer = fs.readFileSync(filePath);

    // Check for binary
    if (isBinaryFile(buffer)) {
      outputResult({
        success: false,
        output: '',
        error: 'Binary file detected. Cannot read binary files as text.',
        exitCode: 1,
      });
      return;
    }

    content = buffer.toString(encoding);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  // Split into lines
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Apply offset and limit
  const offset = Math.max(1, args.offset || 1);
  const limit = Math.min(args.limit || MAX_LINES, MAX_LINES);

  const startIndex = offset - 1;
  const endIndex = Math.min(startIndex + limit, lines.length);

  // Get requested lines with line numbers
  const selectedLines = lines.slice(startIndex, endIndex);
  const truncated = endIndex < lines.length;

  // Format with line numbers
  const formatted = selectedLines.map((line, i) => {
    const lineNum = startIndex + i + 1;
    const padding = String(endIndex).length;
    const truncatedLine = line.length > MAX_LINE_LENGTH
      ? line.substring(0, MAX_LINE_LENGTH) + '...'
      : line;
    return `${String(lineNum).padStart(padding)}| ${truncatedLine}`;
  }).join('\n');

  outputResult({
    success: true,
    output: formatted,
    exitCode: 0,
    metadata: {
      path: filePath,
      lines: totalLines,
      size: stats.size,
      truncated,
    },
  });
}

main();
