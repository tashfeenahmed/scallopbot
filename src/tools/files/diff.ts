/**
 * Diff helpers for the file tools:
 *  - compactDiff: a short unified-style diff of what an edit changed, for
 *    the tool result (so the model needn't re-read the file).
 *  - parsePatch: unified diff (git/diff -u) and Codex "*** Begin Patch"
 *    formats, turned into per-file hunks the fuzzy chain can apply.
 */

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

/** Line diff: common prefix/suffix trimmed, LCS on the middle (bounded). */
export function lineDiff(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', line: a[i], a: i, b: i });

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length <= 4_000_000 && am.length && bm.length) {
    // LCS table (lengths of suffixes).
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ t: ' ', line: am[i], a: pre + i, b: pre + j });
        i++; j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ t: '-', line: am[i], a: pre + i, b: pre + j });
        i++;
      } else {
        ops.push({ t: '+', line: bm[j], a: pre + i, b: pre + j });
        j++;
      }
    }
  } else {
    am.forEach((line, k) => ops.push({ t: '-', line, a: pre + k, b: pre }));
    bm.forEach((line, k) => ops.push({ t: '+', line, a: pre + am.length, b: pre + k }));
  }

  for (let k = 0; k < suf; k++) {
    ops.push({ t: ' ', line: a[a.length - suf + k], a: a.length - suf + k, b: b.length - suf + k });
  }
  return ops;
}

/**
 * Unified-style diff with `context` lines around each change, capped at
 * `maxLines` output lines. Returns '' when nothing changed.
 */
export function compactDiff(before: string, after: string, maxLines = 40, context = 2): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  // Both end with a newline: drop the phantom empty last line.
  if (a.length > 1 && b.length > 1 && a[a.length - 1] === '' && b[b.length - 1] === '') { a.pop(); b.pop(); }
  const ops = lineDiff(a, b);
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter(k => k >= 0);
  if (!changed.length) return '';

  // Group changes whose context windows touch.
  const groups: Array<[number, number]> = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = groups[groups.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi;
    else groups.push([lo, hi]);
  }

  const out: string[] = [];
  for (const [lo, hi] of groups) {
    const first = ops[lo];
    const aCount = ops.slice(lo, hi + 1).filter(o => o.t !== '+').length;
    const bCount = ops.slice(lo, hi + 1).filter(o => o.t !== '-').length;
    out.push(`@@ -${first.a + 1},${aCount} +${first.b + 1},${bCount} @@`);
    for (let k = lo; k <= hi; k++) out.push(`${ops[k].t}${ops[k].line}`);
  }
  if (out.length > maxLines) {
    const hidden = out.length - maxLines;
    return [...out.slice(0, maxLines), `… (${hidden} more diff line${hidden === 1 ? '' : 's'})`].join('\n');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

export interface Hunk {
  /** 1-based start line in the old file, when the header gave one. */
  oldStart?: number;
  oldLines: string[];
  newLines: string[];
}

export interface FilePatch {
  kind: 'update' | 'add' | 'delete';
  path: string;
  /** Codex "*** Move to:" / rename in unified diff. */
  moveTo?: string;
  hunks: Hunk[];
}

function cleanPath(raw: string): string | null {
  let p = raw.trim();
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === '/dev/null') return null;
  if (/^[ab]\//.test(p)) p = p.slice(2);
  return p;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+/;

export function parsePatch(text: string, defaultPath?: string): FilePatch[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (/^\*\*\* Begin Patch/m.test(normalized)) return parseCodexPatch(normalized);
  return parseUnifiedDiff(normalized, defaultPath);
}

function parseUnifiedDiff(text: string, defaultPath?: string): FilePatch[] {
  const lines = text.split('\n');
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;
  let oldPath: string | null | undefined;

  const ensureCurrent = (): FilePatch => {
    if (!current) {
      if (!defaultPath) throw new Error('The diff has hunks but no "--- a/file" / "+++ b/file" header, and no path was given. Add the headers or pass path.');
      current = { kind: 'update', path: defaultPath, hunks: [] };
      patches.push(current);
    }
    return current;
  };

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('similarity index')
      || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode')
      || line.startsWith('new mode') || line.startsWith('rename from') || line.startsWith('rename to')) {
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) {
      oldPath = cleanPath(line.slice(4));
      const newPath = cleanPath(lines[k + 1].slice(4));
      k++;
      hunk = null;
      if (oldPath === null && newPath) current = { kind: 'add', path: newPath, hunks: [] };
      else if (newPath === null && oldPath) current = { kind: 'delete', path: oldPath, hunks: [] };
      else {
        const p = (oldPath ?? newPath ?? defaultPath)!;
        current = { kind: 'update', path: p, hunks: [] };
        if (newPath && oldPath && newPath !== oldPath) current.moveTo = newPath;
      }
      patches.push(current);
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header || line.startsWith('@@')) {
      const cur = ensureCurrent();
      hunk = { oldLines: [], newLines: [] };
      if (header) hunk.oldStart = Number(header[1]);
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+' || line === '') {
      if (!hunk) {
        if (line === '') continue;
        const cur = ensureCurrent();
        hunk = { oldLines: [], newLines: [] };
        cur.hunks.push(hunk);
      }
      // A bare empty line inside a hunk is a blank context line (models drop the space).
      if (line === '') {
        // Trailing blank lines at the very end of the diff are noise.
        if (lines.slice(k + 1).every(l => l === '')) continue;
        hunk.oldLines.push('');
        hunk.newLines.push('');
      } else if (c === ' ') {
        hunk.oldLines.push(line.slice(1));
        hunk.newLines.push(line.slice(1));
      } else if (c === '-') {
        hunk.oldLines.push(line.slice(1));
      } else {
        hunk.newLines.push(line.slice(1));
      }
      continue;
    }
    // Any other text ends the hunk (commentary between files etc.).
    hunk = null;
  }
  if (!patches.length) throw new Error('No hunks found. Expected a unified diff ("--- a/f", "+++ b/f", "@@ -1,3 +1,4 @@") or a "*** Begin Patch" block.');
  return patches;
}

function parseCodexPatch(text: string): FilePatch[] {
  const lines = text.split('\n');
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End of File')) continue;
    if (line.startsWith('*** End Patch')) break;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line))) {
      const kind = m[1] === 'Update' ? 'update' : m[1] === 'Add' ? 'add' : 'delete';
      current = { kind, path: m[2].trim(), hunks: [] };
      patches.push(current);
      hunk = null;
      if (kind === 'add') {
        hunk = { oldLines: [], newLines: [] };
        current.hunks.push(hunk);
      }
      continue;
    }
    if ((m = /^\*\*\* Move to: (.+)$/.exec(line))) {
      if (current) current.moveTo = m[1].trim();
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      const header = HUNK_HEADER.exec(line);
      hunk = { oldLines: [], newLines: [] };
      if (header) hunk.oldStart = Number(header[1]);
      current.hunks.push(hunk);
      continue;
    }
    if (current.kind === 'delete') continue;
    if (!hunk) {
      hunk = { oldLines: [], newLines: [] };
      current.hunks.push(hunk);
    }
    const c = line[0];
    if (current.kind === 'add') {
      hunk.newLines.push(c === '+' ? line.slice(1) : line);
    } else if (c === '+') hunk.newLines.push(line.slice(1));
    else if (c === '-') hunk.oldLines.push(line.slice(1));
    else {
      const body = c === ' ' ? line.slice(1) : line;
      hunk.oldLines.push(body);
      hunk.newLines.push(body);
    }
  }
  // Drop trailing empty context lines produced by a final newline in the patch text.
  for (const p of patches) {
    for (const h of p.hunks) {
      while (h.oldLines.length && h.newLines.length && h.oldLines[h.oldLines.length - 1] === '' && h.newLines[h.newLines.length - 1] === '') {
        h.oldLines.pop();
        h.newLines.pop();
      }
    }
    if (p.kind === 'add') {
      const h = p.hunks[0];
      while (h && h.newLines.length && h.newLines[h.newLines.length - 1] === '') h.newLines.pop();
    }
  }
  if (!patches.length) throw new Error('No "*** Update File:", "*** Add File:" or "*** Delete File:" sections found in the patch.');
  return patches;
}
