/**
 * Subdirectory project-context hints.
 *
 * The workspace-root AGENTS.md/CLAUDE.md is part of the system prompt. The
 * first time a file tool touches a directory below the root, any AGENTS.md
 * or CLAUDE.md in that directory (or an ancestor between it and the root)
 * that hasn't been shown yet in this session is appended to the tool result.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isWithin } from '../../skills/bundled/_shared/pathguard.js';
import type { SessionFileState } from './state.js';
import { displayPath } from './paths.js';

export const HINT_FILES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_HINT_CHARS = 4000;
const MAX_HINTS_PER_RESULT = 3;

export function collectProjectHints(workspace: string, absPath: string, state: SessionFileState): string {
  const ws = path.resolve(workspace);
  const dir = path.dirname(path.resolve(absPath));
  if (!isWithin(ws, dir) || dir === ws) return '';
  if (state.touchedDirs.has(dir)) return '';
  state.touchedDirs.add(dir);

  // Reading a hint file directly counts as having seen it.
  if (HINT_FILES.includes(path.basename(absPath))) state.shownHints.add(path.resolve(absPath));

  const chain: string[] = [];
  for (let d = dir; d !== ws && isWithin(ws, d); d = path.dirname(d)) chain.push(d);
  chain.reverse(); // outermost first

  const blocks: string[] = [];
  for (const d of chain) {
    for (const name of HINT_FILES) {
      if (blocks.length >= MAX_HINTS_PER_RESULT) break;
      const file = path.join(d, name);
      if (state.shownHints.has(file)) continue;
      let text: string;
      try {
        if (!fs.statSync(file).isFile()) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      state.shownHints.add(file);
      if (!text.trim()) continue;
      const body = text.length > MAX_HINT_CHARS
        ? `${text.slice(0, MAX_HINT_CHARS)}\n… (truncated; read_file ${displayPath(ws, file)} for the rest)`
        : text.trimEnd();
      blocks.push(`[project-context: ${displayPath(ws, file)}]\n${body}`);
    }
  }
  return blocks.join('\n\n');
}
