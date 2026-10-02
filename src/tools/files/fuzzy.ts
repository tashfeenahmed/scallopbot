/**
 * The 9-step fuzzy matching chain used by `patch`.
 *
 * Strategies run in order; the first one that finds at least one match wins.
 * One match (or any number with replace_all) is applied; several without
 * replace_all is an ambiguity the caller reports with line numbers.
 *
 *   1. exact                  byte-for-byte substring
 *   2. line-trimmed           whole lines, trailing whitespace ignored
 *   3. whitespace-normalized  runs of spaces/tabs inside lines collapsed
 *   4. indentation-flexible   block matched at a different indentation depth
 *   5. escape-normalized      literal \n, \t, \" in old_string vs real chars
 *   6. trimmed-boundary       old_string with leading/trailing whitespace trimmed
 *   7. unicode-normalized     smart quotes, NBSP, dashes, ellipsis, NFKC
 *   8. block-anchor           first+last lines anchor, middle similar enough
 *   9. context-similarity     best sliding window by Levenshtein ratio
 *
 * All text here is LF-normalized; CRLF/BOM handling lives in the caller.
 */

export type StrategyName =
  | 'exact'
  | 'line-trimmed'
  | 'whitespace-normalized'
  | 'indentation-flexible'
  | 'escape-normalized'
  | 'trimmed-boundary'
  | 'unicode-normalized'
  | 'block-anchor'
  | 'context-similarity';

export interface Match {
  start: number;
  end: number;
  /** Text to put in place of [start, end) — new_string, re-indented if needed. */
  replacement: string;
  /** For similarity strategies: 0..1. */
  similarity?: number;
}

export interface FindResult {
  strategy: StrategyName;
  matches: Match[];
}

export interface FindOptions {
  /** Only accept matches that begin at a line start (diff hunks). */
  lineAnchored?: boolean;
  blockAnchorThreshold?: number;
  contextThreshold?: number;
}

const BLOCK_ANCHOR_THRESHOLD = 0.7;
const CONTEXT_THRESHOLD = 0.8;
const MAX_SIMILARITY_TEXT = 2_000_000;
const MAX_SIMILARITY_OLD = 8_000;

// ---------------------------------------------------------------------------
// Line index
// ---------------------------------------------------------------------------

export class LineIndex {
  readonly lines: string[];
  readonly starts: number[];

  constructor(readonly text: string) {
    this.lines = text.split('\n');
    this.starts = new Array(this.lines.length);
    let pos = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.starts[i] = pos;
      pos += this.lines[i].length + 1;
    }
  }

  /** 0-based line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** End offset of line `j` (exclusive), optionally including its newline. */
  lineEnd(j: number, includeNewline: boolean): number {
    const end = this.starts[j] + this.lines[j].length;
    return includeNewline && j < this.lines.length - 1 ? end + 1 : end;
  }
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

/** Levenshtein distance, optionally bounded (returns max+1 when exceeded). */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (a.length > b.length) [a, b] = [b, a];
  const la = a.length;
  const lb = b.length;
  if (lb - la > max) return max + 1;
  if (la === 0) return lb;
  let prev = new Array<number>(la + 1);
  let cur = new Array<number>(la + 1);
  for (let i = 0; i <= la; i++) prev[i] = i;
  for (let j = 1; j <= lb; j++) {
    cur[0] = j;
    let rowMin = cur[0];
    const cb = b.charCodeAt(j - 1);
    for (let i = 1; i <= la; i++) {
      const cost = a.charCodeAt(i - 1) === cb ? 0 : 1;
      const v = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost);
      cur[i] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[la];
}

/** 1 - distance / max(len). 1 means identical. */
export function similarity(a: string, b: string, floor = 0): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const bound = floor > 0 ? Math.floor((1 - floor) * maxLen) : Infinity;
  const d = levenshtein(a, b, bound);
  if (d > bound) return 0;
  return 1 - d / maxLen;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams; a cheap prefilter. */
export function dice(a: string, b: string, aGrams = bigrams(a)): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bGrams = bigrams(b);
  let overlap = 0;
  for (const [g, n] of aGrams) {
    const m = bGrams.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

// ---------------------------------------------------------------------------
// Indentation
// ---------------------------------------------------------------------------

export function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

function firstNonBlank(lines: string[]): string | undefined {
  return lines.find(l => l.trim() !== '');
}

/**
 * Re-indent `text` so that a block written at `fromIndent` lands at
 * `toIndent` (the indentation actually present in the file).
 */
export function reindent(text: string, fromIndent: string, toIndent: string): string {
  if (fromIndent === toIndent) return text;
  return text
    .split('\n')
    .map(line => {
      if (line.trim() === '') return line;
      if (line.startsWith(fromIndent)) return toIndent + line.slice(fromIndent.length);
      // Line is less indented than the block's first line: shift by the delta.
      const lead = leadingWhitespace(line);
      if (toIndent.startsWith(fromIndent)) return toIndent.slice(fromIndent.length) + line;
      const remove = fromIndent.length - toIndent.length;
      if (remove > 0 && lead.length >= remove) return line.slice(remove);
      return line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Normalization with an offset map back into the original text
// ---------------------------------------------------------------------------

interface Mapped {
  text: string;
  /** map[k] = index in the original of normalized char k. */
  map: number[];
}

/** Compose: `outer` was computed over `inner.text`. */
function compose(inner: Mapped, outer: Mapped): Mapped {
  return { text: outer.text, map: outer.map.map(k => inner.map[k]) };
}

/**
 * Keep leading indentation, collapse internal runs of spaces/tabs to one
 * space, drop trailing spaces/tabs on every line.
 */
function collapseWhitespace(src: string): Mapped {
  let out = '';
  const map: number[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    // Line start: copy indentation verbatim.
    while (i < n && (src[i] === ' ' || src[i] === '\t')) {
      out += src[i];
      map.push(i);
      i++;
    }
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === ' ' || c === '\t') {
        const runStart = i;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        if (i < n && src[i] !== '\n') {
          out += ' ';
          map.push(runStart);
        }
        continue;
      }
      out += c;
      map.push(i);
      i++;
    }
    if (i < n) {
      out += '\n';
      map.push(i);
      i++;
    }
  }
  return { text: out, map };
}

const UNICODE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʼ': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '​': '', '‌': '', '‍': '', '⁠': '', '﻿': '',
};

function normalizeUnicode(src: string): Mapped {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    let rep: string;
    if (c in UNICODE_MAP) rep = UNICODE_MAP[c];
    else if (c >= ' ' && c <= ' ') rep = ' ';
    else if (c.charCodeAt(0) < 128) rep = c;
    else {
      // Surrogate pairs: keep them together.
      const code = src.codePointAt(i)!;
      const ch = String.fromCodePoint(code);
      rep = ch.normalize('NFKC');
      if (ch.length === 2) {
        for (let k = 0; k < rep.length; k++) map.push(i);
        out += rep;
        i++;
        continue;
      }
    }
    for (let k = 0; k < rep.length; k++) map.push(i);
    out += rep;
  }
  return { text: out, map };
}

function unicodePlain(s: string): string {
  return normalizeUnicode(s).text;
}

// ---------------------------------------------------------------------------
// Strategy plumbing
// ---------------------------------------------------------------------------

interface OldParts {
  lines: string[];
  trailingNewline: boolean;
}

function splitOld(old: string): OldParts {
  const trailingNewline = old.endsWith('\n') && old.length > 1;
  const body = trailingNewline ? old.slice(0, -1) : old;
  return { lines: body.split('\n'), trailingNewline };
}

function exactMatches(text: string, needle: string, replacement: string): Match[] {
  if (!needle) return [];
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    out.push({ start: at, end: at + needle.length, replacement });
    from = at + needle.length;
  }
  return out;
}

function mappedMatches(original: string, norm: Mapped, needle: string, replacement: string): Match[] {
  if (!needle) return [];
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = norm.text.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    const start = norm.map[at];
    const origEnd = end >= norm.text.length ? original.length : norm.map[end - 1] + 1;
    out.push({ start, end: origEnd, replacement });
    from = end;
  }
  return out;
}

/**
 * Generic whole-line window matcher. `eq` compares the window (file lines)
 * with the old lines. The replacement is new_string re-indented from the
 * old block's indentation to the file's.
 */
function lineWindowMatches(
  idx: LineIndex,
  old: OldParts,
  newString: string,
  eq: (window: string[], oldLines: string[]) => boolean,
): Match[] {
  const m = old.lines.length;
  const n = idx.lines.length;
  const out: Match[] = [];
  for (let i = 0; i + m <= n; i++) {
    const window = idx.lines.slice(i, i + m);
    if (!eq(window, old.lines)) continue;
    out.push(lineSpanMatch(idx, i, i + m - 1, old, newString));
    i += m - 1;
  }
  return out;
}

function lineSpanMatch(idx: LineIndex, first: number, last: number, old: OldParts, newString: string, sim?: number): Match {
  const start = idx.starts[first];
  const end = idx.lineEnd(last, old.trailingNewline);
  const fileIndent = leadingWhitespace(firstNonBlank(idx.lines.slice(first, last + 1)) ?? '');
  const oldIndent = leadingWhitespace(firstNonBlank(old.lines) ?? '');
  let replacement = reindent(newString, oldIndent, fileIndent);
  // The window ended at EOF without a newline: don't add one.
  if (old.trailingNewline && end === idx.starts[last] + idx.lines[last].length && replacement.endsWith('\n')) {
    replacement = replacement.slice(0, -1);
  }
  return { start, end, replacement, ...(sim !== undefined && { similarity: sim }) };
}

function minIndentStrip(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    min = Math.min(min, leadingWhitespace(l).length);
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map(l => (l.trim() === '' ? '' : l.slice(min).trimEnd()));
}

function unescapeLiterals(s: string): string {
  return s.replace(/\\(n|t|r|"|'|`|\\)/g, (_m, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      default: return c;
    }
  });
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

type Strategy = (text: string, idx: LineIndex, oldString: string, newString: string, opts: FindOptions) => Match[];

const strategies: Array<[StrategyName, Strategy]> = [
  ['exact', (text, _idx, o, n) => exactMatches(text, o, n)],

  ['line-trimmed', (_text, idx, o, n) => {
    const old = splitOld(o);
    return lineWindowMatches(idx, old, n, (w, ol) => w.every((l, k) => l.trimEnd() === ol[k].trimEnd()));
  }],

  ['whitespace-normalized', (text, _idx, o, n) => {
    const norm = collapseWhitespace(text);
    const needle = collapseWhitespace(o).text;
    if (!needle.trim()) return [];
    return mappedMatches(text, norm, needle, n);
  }],

  ['indentation-flexible', (_text, idx, o, n) => {
    const old = splitOld(o);
    const oldNorm = minIndentStrip(old.lines);
    if (oldNorm.every(l => l === '')) return [];
    return lineWindowMatches(idx, old, n, w => {
      const wn = minIndentStrip(w);
      return wn.every((l, k) => l === oldNorm[k]);
    });
  }],

  ['escape-normalized', (text, idx, o, n, opts) => {
    if (/\\(n|t|r|"|'|`|\\)/.test(o)) {
      const uo = unescapeLiterals(o);
      const un = unescapeLiterals(n);
      if (uo !== o) {
        // Retry the first four (exact … indentation-flexible) with the unescaped pair.
        for (const [, s] of strategies.slice(0, 4)) {
          const found = s(text, idx, uo, un, opts);
          if (found.length) return found;
        }
      }
    }
    // Reverse direction: the file holds literal "\n" where the model wrote a real newline.
    if (o.includes('\n') || o.includes('\t')) {
      const eo = o.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      const en = n.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      const found = exactMatches(text, eo, en);
      if (found.length) return found;
    }
    return [];
  }],

  ['trimmed-boundary', (text, _idx, o, n) => {
    const t = o.trim();
    if (!t || t === o) return [];
    return exactMatches(text, t, n.trim());
  }],

  ['unicode-normalized', (text, _idx, o, n) => {
    const uText = normalizeUnicode(text);
    const needle = collapseWhitespace(unicodePlain(o)).text;
    if (!needle.trim()) return [];
    if (needle === o && uText.text === text) return [];
    const norm = compose(uText, collapseWhitespace(uText.text));
    return mappedMatches(text, norm, needle, n);
  }],

  ['block-anchor', (text, idx, o, n, opts) => {
    if (text.length > MAX_SIMILARITY_TEXT || o.length > MAX_SIMILARITY_OLD) return [];
    const old = splitOld(o);
    const m = old.lines.length;
    if (m < 3) return [];
    const firstT = unicodePlain(old.lines[0]).trim();
    const lastT = unicodePlain(old.lines[m - 1]).trim();
    if (!firstT || !lastT) return [];
    const oldMiddle = old.lines.slice(1, -1).map(l => unicodePlain(l).trim()).join('\n');
    const threshold = opts.blockAnchorThreshold ?? BLOCK_ANCHOR_THRESHOLD;
    const slack = Math.max(3, Math.ceil(m * 0.25));
    const trimmed = idx.lines.map(l => unicodePlain(l).trim());
    const candidates: Array<{ i: number; j: number; sim: number }> = [];
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] !== firstT) continue;
      let best: { i: number; j: number; sim: number } | undefined;
      const jMin = i + Math.max(2, m - 1 - slack);
      const jMax = Math.min(trimmed.length - 1, i + m - 1 + slack);
      for (let j = jMin; j <= jMax; j++) {
        if (trimmed[j] !== lastT) continue;
        const middle = trimmed.slice(i + 1, j).join('\n');
        const sim = similarity(middle, oldMiddle, threshold);
        if (sim >= threshold && (!best || sim > best.sim)) best = { i, j, sim };
      }
      if (best) candidates.push(best);
    }
    const chosen = dropOverlaps(candidates);
    return chosen.map(c => lineSpanMatch(idx, c.i, c.j, old, n, c.sim));
  }],

  ['context-similarity', (text, idx, o, n, opts) => {
    if (text.length > MAX_SIMILARITY_TEXT || o.length > MAX_SIMILARITY_OLD) return [];
    const old = splitOld(o);
    const threshold = opts.contextThreshold ?? CONTEXT_THRESHOLD;
    const windows = scoreWindows(idx, old.lines, threshold);
    if (!windows.length) return [];
    windows.sort((a, b) => b.sim - a.sim);
    const best = windows[0];
    // Near-ties elsewhere are an ambiguity; otherwise take the single best.
    const ties = dropOverlaps(windows.filter(w => w.sim >= best.sim - 0.02));
    return ties.map(w => lineSpanMatch(idx, w.i, w.j, old, n, w.sim));
  }],
];

export const STRATEGY_ORDER: StrategyName[] = strategies.map(([name]) => name);

function dropOverlaps<T extends { i: number; j: number; sim: number }>(cands: T[]): T[] {
  const sorted = [...cands].sort((a, b) => b.sim - a.sim);
  const kept: T[] = [];
  for (const c of sorted) {
    if (kept.some(k => !(c.j < k.i || c.i > k.j))) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.i - b.i);
}

/**
 * Score sliding windows (sizes m-1..m+1) of the file against the old lines.
 * Returns windows with similarity ≥ floor.
 */
function scoreWindows(idx: LineIndex, oldLines: string[], floor: number): Array<{ i: number; j: number; sim: number }> {
  const oldText = oldLines.map(l => unicodePlain(l).trim()).join('\n');
  if (!oldText.trim()) return [];
  const oldGrams = bigrams(oldText);
  const m = oldLines.length;
  const sizes = m > 2 ? [m, m - 1, m + 1] : [m, m + 1];
  const trimmed = idx.lines.map(l => unicodePlain(l).trim());
  const diceFloor = Math.max(0, floor - 0.25);
  const out: Array<{ i: number; j: number; sim: number }> = [];
  for (const size of sizes) {
    if (size < 1) continue;
    for (let i = 0; i + size <= trimmed.length; i++) {
      const win = trimmed.slice(i, i + size).join('\n');
      const maxLen = Math.max(win.length, oldText.length);
      if (maxLen === 0) continue;
      if (Math.abs(win.length - oldText.length) / maxLen > 1 - floor) continue;
      if (dice(oldText, win, oldGrams) < diceFloor) continue;
      const sim = similarity(win, oldText, floor);
      if (sim >= floor) out.push({ i, j: i + size - 1, sim });
    }
  }
  return out;
}

/** Run the chain. Returns the first strategy with ≥1 match, or null. */
export function findMatches(text: string, oldString: string, newString: string, opts: FindOptions = {}): FindResult | null {
  if (!oldString) return null;
  const idx = new LineIndex(text);
  for (const [name, strategy] of strategies) {
    let matches = strategy(text, idx, oldString, newString, opts);
    if (opts.lineAnchored) matches = matches.filter(mt => mt.start === 0 || text[mt.start - 1] === '\n');
    if (matches.length) return { strategy: name, matches };
  }
  return null;
}

/** Non-similarity strategies only (1-7), used for already-applied detection. */
export function findStrict(text: string, needle: string): boolean {
  if (!needle) return false;
  const idx = new LineIndex(text);
  for (const [name, strategy] of strategies) {
    if (name === 'block-anchor' || name === 'context-similarity') break;
    if (strategy(text, idx, needle, needle, {}).length) return true;
  }
  return false;
}

/** The closest region to old_string (no threshold), for "no match" errors. */
export function closestRegion(text: string, oldString: string): { firstLine: number; lastLine: number; similarity: number } | null {
  if (text.length > MAX_SIMILARITY_TEXT) return null;
  const idx = new LineIndex(text);
  const old = splitOld(oldString.length > MAX_SIMILARITY_OLD ? oldString.slice(0, MAX_SIMILARITY_OLD) : oldString);
  const oldText = old.lines.map(l => l.trim()).join('\n');
  if (!oldText.trim()) return null;
  const oldGrams = bigrams(oldText);
  const m = old.lines.length;
  const trimmed = idx.lines.map(l => l.trim());
  const scored: Array<{ i: number; d: number }> = [];
  for (let i = 0; i + m <= trimmed.length; i++) {
    scored.push({ i, d: dice(oldText, trimmed.slice(i, i + m).join('\n'), oldGrams) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.d - a.d);
  let best: { firstLine: number; lastLine: number; similarity: number } | null = null;
  for (const { i } of scored.slice(0, 5)) {
    const sim = similarity(trimmed.slice(i, i + m).join('\n'), oldText);
    if (!best || sim > best.similarity) best = { firstLine: i, lastLine: i + m - 1, similarity: sim };
  }
  return best;
}

/** Apply non-overlapping matches. */
export function applyMatches(text: string, matches: Match[]): string {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const m of sorted) {
    if (m.start < pos) continue;
    out += text.slice(pos, m.start) + m.replacement;
    pos = m.end;
  }
  return out + text.slice(pos);
}

// ---------------------------------------------------------------------------
// Single-edit planning (already-applied detection, ambiguity, no-match)
// ---------------------------------------------------------------------------

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  /** 1-based line hint (diff hunks) used to pick among several matches. */
  lineHint?: number;
  lineAnchored?: boolean;
}

export type EditPlan =
  | { kind: 'applied'; text: string; strategy: StrategyName; count: number; lines: number[]; similarity?: number }
  | { kind: 'already-applied' }
  | { kind: 'ambiguous'; strategy: StrategyName; lines: number[] }
  | { kind: 'no-match'; closest: { firstLine: number; lastLine: number; similarity: number } | null }
  | { kind: 'invalid'; message: string };

function rangesInside(inner: Array<{ start: number; end: number }>, outer: Array<{ start: number; end: number }>): boolean {
  return inner.every(i => outer.some(o => i.start >= o.start && i.end <= o.end));
}

export function planEdit(text: string, edit: EditSpec): EditPlan {
  const oldString = edit.old_string;
  const newString = edit.new_string;
  if (typeof oldString !== 'string' || typeof newString !== 'string') {
    return { kind: 'invalid', message: 'old_string and new_string must both be strings.' };
  }
  if (oldString === newString) {
    return { kind: 'invalid', message: 'old_string and new_string are identical — there is nothing to change.' };
  }
  if (oldString === '') {
    return {
      kind: 'invalid',
      message: 'old_string is empty. To insert text, put an existing anchor line in old_string and repeat it in new_string with your addition; to replace the whole file use write_file.',
    };
  }

  const found = findMatches(text, oldString, newString, { lineAnchored: edit.lineAnchored });
  const idx = new LineIndex(text);
  if (!found) {
    // old_string is gone and new_string is there: the edit already happened.
    // Short new_strings ("}", "x") are too common to prove anything.
    if (newString.trim().length >= 8 && findStrict(text, newString)) return { kind: 'already-applied' };
    return { kind: 'no-match', closest: closestRegion(text, oldString) };
  }

  // Every match sits inside an occurrence of new_string (old_string is a
  // prefix/part of new_string): applying again would duplicate the addition.
  if (newString.trim()) {
    const newOcc = exactMatches(text, newString, '');
    if (newOcc.length && rangesInside(found.matches, newOcc)) return { kind: 'already-applied' };
  }

  let matches = found.matches;
  // Similarity matches that look more like new_string than old_string are
  // the edit already sitting in the file.
  if ((found.strategy === 'block-anchor' || found.strategy === 'context-similarity') && newString.trim()) {
    const region = text.slice(matches[0].start, matches[0].end);
    if (matches.length === 1 && similarity(region.trim(), newString.trim()) > similarity(region.trim(), oldString.trim())) {
      return { kind: 'already-applied' };
    }
  }

  if (matches.length > 1 && !edit.replace_all) {
    if (edit.lineHint !== undefined) {
      const hint = edit.lineHint - 1;
      matches = [matches.reduce((best, mt) =>
        Math.abs(idx.lineAt(mt.start) - hint) < Math.abs(idx.lineAt(best.start) - hint) ? mt : best)];
    } else {
      return { kind: 'ambiguous', strategy: found.strategy, lines: matches.map(mt => idx.lineAt(mt.start) + 1) };
    }
  }

  return {
    kind: 'applied',
    text: applyMatches(text, matches),
    strategy: found.strategy,
    count: matches.length,
    lines: matches.map(mt => idx.lineAt(mt.start) + 1),
    ...(matches[0].similarity !== undefined && { similarity: matches[0].similarity }),
  };
}
