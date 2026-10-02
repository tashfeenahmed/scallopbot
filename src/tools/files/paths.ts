/**
 * Path resolution, containment and "did you mean" suggestions for the file tools.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWithin, isWithinAny } from '../../skills/bundled/_shared/pathguard.js';
import { levenshtein } from './fuzzy.js';

export interface ResolvedPath {
  abs: string;
  /** Display path: relative to the workspace when inside it. */
  display: string;
}

export type ResolveResult = ResolvedPath | { error: string };

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Real path of the nearest existing ancestor + the remaining tail. */
function realpathLoose(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function displayPath(workspace: string, abs: string): string {
  const rel = path.relative(workspace, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return abs;
}

/**
 * Resolve a model-supplied path against the workspace and check it stays in
 * one of the allowed roots (also after following symlinks).
 */
export function resolvePath(input: unknown, workspace: string, allowedRoots: string[]): ResolveResult {
  if (typeof input !== 'string' || !input.trim()) return { error: 'Missing required parameter: path' };
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  const abs = path.resolve(workspace, p);
  const roots = allowedRoots.map(r => path.resolve(r));
  const realRoots = roots.map(realOrSelf);
  const inside = isWithinAny(abs, roots) || isWithinAny(realpathLoose(abs), realRoots);
  if (!inside) {
    return { error: `${input} is outside the workspace (${workspace}). The file tools only work inside the workspace${roots.length > 1 ? ' and ~/.scallopbot' : ''}; use bash for other locations.` };
  }
  const real = realpathLoose(abs);
  if (!realRoots.some(r => isWithin(r, real)) && !roots.some(r => isWithin(r, real))) {
    return { error: `${input} is a symlink that points outside the workspace (${real}); use bash for it.` };
  }
  return { abs, display: displayPath(workspace, abs) };
}

// ---------------------------------------------------------------------------
// Binary / image detection
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.avif']);
const KNOWN_BINARY_EXT = new Set([
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.class', '.exe', '.dll', '.so', '.dylib',
  '.o', '.a', '.wasm', '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.flac', '.m4a', '.webm', '.avi', '.mkv',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.sqlite', '.db', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pyc', '.node', '.bin', '.dat',
]);

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

export function looksBinary(buf: Buffer, p: string): boolean {
  if (KNOWN_BINARY_EXT.has(path.extname(p).toLowerCase())) return true;
  const sample = buf.subarray(0, 8192);
  if (!sample.length) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32 && byte !== 27)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Did-you-mean
// ---------------------------------------------------------------------------

const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);

/**
 * Up to `limit` existing files whose names resemble the missing path's.
 * Bounded walk of the workspace (5,000 entries); cheap enough per miss.
 */
export function suggestSimilar(workspace: string, missingAbs: string, limit = 3): string[] {
  const wantBase = path.basename(missingAbs).toLowerCase();
  const wantStem = wantBase.replace(/\.[^.]+$/, '');
  const wantRel = displayPath(workspace, missingAbs).toLowerCase();
  const scored: Array<{ p: string; score: number }> = [];
  let budget = 5000;
  const queue: string[] = [];
  // Start with the nearest existing ancestor (most likely), then the workspace.
  let anc = path.dirname(missingAbs);
  while (!fs.existsSync(anc) && anc !== path.dirname(anc)) anc = path.dirname(anc);
  if (isWithin(workspace, anc)) queue.push(anc);
  queue.push(workspace);
  const seen = new Set<string>();
  while (queue.length && budget > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (--budget <= 0) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name) && !e.name.startsWith('.')) queue.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const base = e.name.toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      let score: number;
      if (base === wantBase) score = 0; // same name, other directory
      else if (stem === wantStem) score = 0.5; // other extension
      else {
        const d = levenshtein(base, wantBase, 4);
        if (d > Math.max(2, Math.floor(wantBase.length / 3))) {
          if (!(wantStem.length >= 4 && (stem.includes(wantStem) || wantStem.includes(stem) && stem.length >= 4))) continue;
          score = 3.5;
        } else score = d;
      }
      const relp = displayPath(workspace, abs);
      // Prefer paths that share more of the requested relative path.
      score += levenshtein(relp.toLowerCase(), wantRel, 40) / 100;
      scored.push({ p: relp, score });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return [...new Set(scored.map(s => s.p))].slice(0, limit);
}
