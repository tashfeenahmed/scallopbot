/**
 * Shared gitignore-aware file walker.
 *
 * Used by glob, grep, and codesearch skills.
 * Yields file paths as an async generator, skipping .git/, node_modules/,
 * and gitignored paths by default.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Parsed gitignore rules */
interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
}

/** Options for the file walker */
export interface WalkOptions {
  /** Root directory to walk (default: process.cwd()) */
  root?: string;
  /** Glob pattern to filter files (e.g. "*.ts", "**\/*.json") */
  globPattern?: string;
  /** Maximum number of files to yield */
  maxFiles?: number;
  /** Skip binary files (default: true) */
  skipBinary?: boolean;
}

/** Always-skipped directories */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.DS_Store']);

/**
 * Parse a .gitignore file into a list of rules.
 */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of content.split('\n')) {
    let line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);

    // Convert gitignore pattern to regex
    const regex = gitignorePatternToRegex(line);
    if (regex) {
      rules.push({ pattern: regex, negated });
    }
  }

  return rules;
}

/**
 * Convert a gitignore pattern to a RegExp.
 */
function gitignorePatternToRegex(pattern: string): RegExp | null {
  // Remove trailing spaces (unless escaped)
  pattern = pattern.replace(/(?<!\\)\s+$/, '');
  if (!pattern) return null;

  // Track if pattern should only match directories
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);

  // Pattern anchored to root if it contains a slash (except trailing)
  const anchored = pattern.includes('/');

  let regexStr = '';

  // Escape and convert glob patterns
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches everything including path separators
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '[') {
      // Character class — find closing bracket
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === '\\') {
      // Escaped character
      if (i + 1 < pattern.length) {
        regexStr += '\\' + pattern[i + 1];
        i += 2;
      } else {
        regexStr += '\\\\';
        i++;
      }
    } else if ('.+^${}()|'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  if (anchored) {
    return new RegExp(`^${regexStr}(?:/.*)?$`);
  } else {
    // Unanchored patterns match any path component
    return new RegExp(`(?:^|/)${regexStr}(?:/.*)?$`);
  }
}

/**
 * Check if a relative path matches any ignore rules.
 */
export function isIgnored(relativePath: string, rules: IgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (rule.pattern.test(relativePath)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

/**
 * Convert a simple glob pattern to a RegExp for file matching.
 * Supports: *, **, ?, {a,b}
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.+/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close === -1) {
        regexStr += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, close).split(',');
        regexStr += '(?:' + alternatives.map(a => a.replace(/[.*+?^$|()[\]\\]/g, '\\$&')).join('|') + ')';
        i = close + 1;
      }
    } else if ('.+^$|()[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/**
 * Detect if a file is binary by checking for null bytes in the first 8KB.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Async generator that yields file paths, respecting gitignore rules.
 */
export async function* walk(options: WalkOptions = {}): AsyncGenerator<string> {
  const root = options.root || process.cwd();
  const maxFiles = options.maxFiles || Infinity;
  const skipBinary = options.skipBinary !== false;

  // Parse .gitignore from root
  let ignoreRules: IgnoreRule[] = [];
  const gitignorePath = path.join(root, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    ignoreRules = parseGitignore(content);
  } catch {
    // No .gitignore — that's fine
  }

  // Compile glob filter if provided
  let globFilter: RegExp | null = null;
  if (options.globPattern) {
    globFilter = globToRegex(options.globPattern);
  }

  let count = 0;

  async function* walkDir(dir: string): AsyncGenerator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxFiles) return;

      // Always skip well-known directories
      if (ALWAYS_SKIP.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);

      // Check gitignore
      if (isIgnored(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        yield* walkDir(fullPath);
      } else if (entry.isFile()) {
        // Apply glob filter
        if (globFilter && !globFilter.test(relativePath)) continue;

        // Skip binary files if requested
        if (skipBinary && isBinaryFile(fullPath)) continue;

        yield relativePath;
        count++;
      }
    }
  }

  yield* walkDir(root);
}
