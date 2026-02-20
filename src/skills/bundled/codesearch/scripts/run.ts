/**
 * Code Search Skill Execution Script
 *
 * Searches for code definitions (functions, classes, interfaces, imports)
 * using language-aware regex patterns.
 */

import * as fs from 'fs';
import * as path from 'path';
import { walk } from '../../_shared/walk.js';

interface CodeSearchArgs {
  query: string;
  path?: string;
  language?: string;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

interface MatchResult {
  file: string;
  line: number;
  content: string;
}

const MAX_RESULTS = 100;

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

  return { valid: true, resolved };
}

/** Map of file extension to language */
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'ts', '.tsx': 'ts',
    '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
  };
  return map[ext] || null;
}

/** Language extension glob patterns */
function languageGlob(lang: string): string | null {
  const map: Record<string, string> = {
    ts: '**/*.{ts,tsx}',
    js: '**/*.{js,jsx,mjs,cjs}',
    py: '**/*.py',
    go: '**/*.go',
    rust: '**/*.rs',
    java: '**/*.java',
  };
  return map[lang] || null;
}

/** Get definition patterns for a language and query */
function getDefinitionPatterns(lang: string, query: string): RegExp[] {
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  switch (lang) {
    case 'ts':
    case 'js':
      return [
        new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${q}\\b`),
        new RegExp(`(?:export\\s+)?class\\s+${q}\\b`),
        new RegExp(`(?:export\\s+)?interface\\s+${q}\\b`),
        new RegExp(`(?:export\\s+)?type\\s+${q}\\b`),
        new RegExp(`(?:export\\s+)?enum\\s+${q}\\b`),
        new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${q}\\b`),
        new RegExp(`(?:import|export)\\s.*\\b${q}\\b`),
        // Method definitions
        new RegExp(`^\\s+(?:async\\s+)?${q}\\s*\\(`),
      ];
    case 'py':
      return [
        new RegExp(`^\\s*def\\s+${q}\\b`),
        new RegExp(`^\\s*class\\s+${q}\\b`),
        new RegExp(`^\\s*(?:from|import)\\s.*\\b${q}\\b`),
      ];
    case 'go':
      return [
        new RegExp(`^func\\s+(?:\\([^)]*\\)\\s+)?${q}\\b`),
        new RegExp(`^type\\s+${q}\\s+struct\\b`),
        new RegExp(`^type\\s+${q}\\s+interface\\b`),
        new RegExp(`^type\\s+${q}\\b`),
      ];
    case 'rust':
      return [
        new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${q}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?struct\\s+${q}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?enum\\s+${q}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?trait\\s+${q}\\b`),
        new RegExp(`^\\s*impl\\s+${q}\\b`),
        new RegExp(`^\\s*(?:pub\\s+)?mod\\s+${q}\\b`),
      ];
    case 'java':
      return [
        new RegExp(`(?:public|private|protected)?\\s*(?:static\\s+)?class\\s+${q}\\b`),
        new RegExp(`(?:public|private|protected)?\\s*interface\\s+${q}\\b`),
        new RegExp(`(?:public|private|protected)?\\s*enum\\s+${q}\\b`),
        new RegExp(`(?:public|private|protected)?\\s*(?:static\\s+)?\\w+\\s+${q}\\s*\\(`),
      ];
    default:
      // Generic fallback
      return [new RegExp(`\\b${q}\\b`)];
  }
}

async function main(): Promise<void> {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: CodeSearchArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.query) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: query', exitCode: 1 });
    return;
  }

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
    const matches: MatchResult[] = [];
    const globPattern = args.language ? languageGlob(args.language) : undefined;

    for await (const filePath of walk({ root: searchRoot, globPattern: globPattern || undefined, skipBinary: true })) {
      if (matches.length >= MAX_RESULTS) break;

      const lang = args.language || detectLanguage(filePath);
      if (!lang) continue;

      const fullPath = path.join(searchRoot, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const patterns = getDefinitionPatterns(lang, args.query);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_RESULTS) break;

        for (const pattern of patterns) {
          if (pattern.test(lines[i])) {
            matches.push({
              file: filePath,
              line: i + 1,
              content: lines[i].trimEnd(),
            });
            break; // One match per line is enough
          }
        }
      }
    }

    if (matches.length === 0) {
      outputResult({ success: true, output: '(no definitions found)', exitCode: 0 });
      return;
    }

    // Group results by file
    const grouped = new Map<string, MatchResult[]>();
    for (const m of matches) {
      const existing = grouped.get(m.file) || [];
      existing.push(m);
      grouped.set(m.file, existing);
    }

    const lines: string[] = [];
    for (const [file, fileMatches] of grouped) {
      lines.push(`## ${file}`);
      for (const m of fileMatches) {
        lines.push(`  ${m.line}: ${m.content}`);
      }
      lines.push('');
    }

    outputResult({
      success: true,
      output: lines.join('\n').trim(),
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
