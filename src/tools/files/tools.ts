/**
 * Native file tools: read_file, write_file, patch (+ edit_file alias), undo.
 *
 * Every result is written for the model's next move: what happened, that it
 * is verified, and what not to do next (re-read, retry the same thing).
 */

import * as fs from 'fs';
import { recordEdit } from '../verify/ledger.js';
import * as path from 'path';
import type { Logger } from 'pino';
import type { SkillHandlerContext } from '../../skills/types.js';
import { CheckpointStore, defaultCheckpointStore, scallopbotHome } from './checkpoints.js';
import { compactDiff, parsePatch, type FilePatch } from './diff.js';
import { LineIndex, planEdit, type EditPlan, type EditSpec, type StrategyName } from './fuzzy.js';
import { collectProjectHints } from './hints.js';
import { checkerFor, formatLintDelta, LintCache, lintFiles, type LintRun } from './lint.js';
import { displayPath, humanSize, isImagePath, looksBinary, resolvePath, suggestSimilar, type ResolvedPath } from './paths.js';
import { FileStateStore, KeyedMutex, sha256, type SessionFileState } from './state.js';
import { isWithin } from '../../skills/bundled/_shared/pathguard.js';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface FileToolsDeps {
  logger?: Logger;
  /** Roots the tools may touch. Default: the workspace and SCALLOPBOT_HOME (~/.scallopbot). */
  allowedRoots?: (workspace: string) => string[];
  /** Lint delta after writes (default true). */
  lint?: boolean;
  /** Shadow-git checkpoints before writes (default true). */
  checkpoints?: boolean;
  store?: FileStateStore;
  checkpointStore?: CheckpointStore;
  /** Without ctx.turnStartedAt, writes this close together count as one turn. */
  turnWindowMs?: number;
  tscTimeoutMs?: number;
  now?: () => number;
}

export const PAGE_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_PAGE_CHARS = 100_000;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_DIFF_LINES = 40;

interface Decoded { text: string; eol: '\n' | '\r\n'; bom: boolean }

export function decodeText(buf: Buffer): Decoded {
  let s = buf.toString('utf8');
  const bom = s.startsWith('﻿');
  if (bom) s = s.slice(1);
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  if (crlf > 0 && crlf >= lf) return { text: s.replace(/\r\n/g, '\n'), eol: '\r\n', bom };
  return { text: s, eol: '\n', bom };
}

export function encodeText(d: Pick<Decoded, 'eol' | 'bom'>, text: string): Buffer {
  const body = d.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  return Buffer.from((d.bom ? '﻿' : '') + body, 'utf8');
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function readMaybe(abs: string): Buffer | null {
  try {
    if (!fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function json(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function numbered(lines: string[], firstLine: number, from: number, to: number): string {
  const out: string[] = [];
  for (let k = Math.max(0, from); k <= Math.min(lines.length - 1, to); k++) {
    const l = lines[k];
    out.push(`${firstLine + k}|${l.length > 300 ? `${l.slice(0, 300)}…` : l}`);
  }
  return out.join('\n');
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

function asInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function notFoundMessage(workspace: string, abs: string, shown: string): string {
  const suggestions = suggestSimilar(workspace, abs);
  if (suggestions.length) {
    return `File not found: ${shown}. Did you mean: ${suggestions.join(', ')}? Use one of these exact paths — don't retry ${shown}.`;
  }
  return `File not found: ${shown} (paths are relative to ${workspace}). Use glob or ls to find the right path — don't retry the same one.`;
}

export class FileTools {
  readonly store: FileStateStore;
  readonly checkpoints: CheckpointStore;
  private readonly lintCache = new LintCache();
  private readonly mutex = new KeyedMutex();
  private readonly lintEnabled: boolean;
  private readonly checkpointsEnabled: boolean;
  private readonly turnWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: FileToolsDeps = {}) {
    this.store = deps.store ?? new FileStateStore();
    this.checkpoints = deps.checkpointStore ?? defaultCheckpointStore();
    this.lintEnabled = deps.lint !== false;
    this.checkpointsEnabled = deps.checkpoints !== false;
    this.turnWindowMs = deps.turnWindowMs ?? 120_000;
    this.now = deps.now ?? Date.now;
  }

  private roots(workspace: string): string[] {
    return this.deps.allowedRoots ? this.deps.allowedRoots(workspace) : [workspace, scallopbotHome()];
  }

  private resolve(ctx: SkillHandlerContext, input: unknown): ResolvedPath | { error: string } {
    return resolvePath(input, ctx.workspace, this.roots(ctx.workspace));
  }

  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------

  async read(ctx: SkillHandlerContext): Promise<ToolResult> {
    const resolved = this.resolve(ctx, ctx.args.path);
    if ('error' in resolved) return fail(resolved.error);
    const { abs, display } = resolved;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return fail(notFoundMessage(ctx.workspace, abs, display));
    }
    if (st.isDirectory()) return fail(`${display} is a directory, not a file. Use ls or glob to list it.`);
    if (st.size > MAX_READ_BYTES) {
      return fail(`${display} is ${humanSize(st.size)} — too large for read_file. Use grep to find the part you need, or bash (sed -n 'A,Bp').`);
    }
    const state = this.store.get(ctx.sessionId);
    const hints = collectProjectHints(ctx.workspace, abs, state);
    const withHints = (s: string) => (hints ? `${s}\n\n${hints}` : s);

    const buf = fs.readFileSync(abs);
    if (isImagePath(abs)) {
      return { success: true, output: withHints(`Image file: ${display} (${path.extname(abs).slice(1).toUpperCase()}, ${humanSize(buf.length)}). read_file shows text only — use send_file to deliver it to the user, or bash/an image tool to inspect it. Don't read_file it again.`) };
    }
    if (looksBinary(buf, abs)) {
      const ext = path.extname(abs).toLowerCase();
      const how = ext === '.pdf' ? 'use pdftotext (bash) to extract its text' : 'use bash (file, xxd | head, unzip -l …) to inspect it';
      return { success: true, output: withHints(`Binary file: ${display} (${humanSize(buf.length)}) — not shown. ${how}. Don't read_file it again.`) };
    }

    const hash = sha256(buf);
    const { text } = decodeText(buf);
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const total = text ? lines.length : 0;
    const prev = state.files.get(abs);

    if (total === 0) {
      state.remember(abs, hash, st.mtimeMs, st.size, '1-0');
      return { success: true, output: withHints(`${display} is empty (0 lines).`) };
    }

    const offset = Math.max(1, asInt(ctx.args.offset) ?? 1);
    const requestedLimit = asInt(ctx.args.limit);
    const limit = Math.min(PAGE_LINES, Math.max(1, requestedLimit ?? PAGE_LINES));
    if (offset > total) {
      return fail(`offset ${offset} is past the end — ${display} has ${total} line${total === 1 ? '' : 's'}. Use an offset between 1 and ${total}.`);
    }
    const wantEnd = Math.min(total, offset + limit - 1);

    if (prev && prev.hash === hash && [...prev.ranges].some(r => {
      const [a, b] = r.split('-').map(Number);
      return a <= offset && b >= wantEnd;
    })) {
      return {
        success: true,
        output: json({ status: 'unchanged', path: display, lines: `${offset}-${wantEnd}`, note: "File unchanged since your last read in this session — don't re-read; use the content you already have." }),
      };
    }

    const body: string[] = [];
    let chars = 0;
    let end = offset - 1;
    for (let k = offset - 1; k < wantEnd; k++) {
      let l = lines[k];
      if (l.length > MAX_LINE_CHARS) l = `${l.slice(0, MAX_LINE_CHARS)} … [line truncated: ${l.length} chars]`;
      const row = `${k + 1}|${l}`;
      if (chars + row.length > MAX_PAGE_CHARS && body.length) break;
      body.push(row);
      chars += row.length + 1;
      end = k + 1;
    }

    const changed = prev && prev.hash !== hash ? ' — changed on disk since your last read' : '';
    const header = `${display} — lines ${offset}-${end} of ${total}${changed}`;
    let footer = '';
    if (end < total) {
      footer = `\n[${total - end} more line${total - end === 1 ? '' : 's'} — next page: read_file {"path":${JSON.stringify(display)},"offset":${end + 1}}]`;
    }
    state.remember(abs, hash, st.mtimeMs, st.size, `${offset}-${end}`);
    return { success: true, output: withHints(`${header}\n${body.join('\n')}${footer}`) };
  }

  // -------------------------------------------------------------------------
  // Shared write plumbing
  // -------------------------------------------------------------------------

  private turnKey(ctx: SkillHandlerContext, state: SessionFileState): string {
    const now = this.now();
    let key: string;
    if (ctx.turnStartedAt) key = `t${ctx.turnStartedAt}`;
    else if (!state.turnKey || now - state.lastActivityAt > this.turnWindowMs) key = `w${now}`;
    else key = state.turnKey;
    state.lastActivityAt = now;
    state.enterTurn(key);
    return key;
  }

  /** Snapshot files not yet captured this turn. Returns the turn's checkpoint id. */
  private async checkpoint(ctx: SkillHandlerContext, state: SessionFileState, absPaths: string[], reason: string): Promise<string | undefined> {
    const turnKey = this.turnKey(ctx, state);
    if (!this.checkpointsEnabled) return undefined;
    const fresh = absPaths.filter(p => !state.turnSnapshotted.has(p) && isWithin(ctx.workspace, p));
    if (!fresh.length) return state.turnCheckpointId;
    try {
      const cp = await this.checkpoints.snapshot(ctx.workspace, fresh, {
        sessionId: ctx.sessionId, turnKey, reason, addTo: state.turnCheckpointId,
      });
      if (cp) {
        state.turnCheckpointId = cp.id;
        for (const p of fresh) state.turnSnapshotted.add(p);
      }
    } catch (e) {
      this.deps.logger?.warn({ err: (e as Error).message }, 'file-tools: checkpoint failed');
    }
    return state.turnCheckpointId;
  }

  private async lintRuns(ctx: SkillHandlerContext, absPaths: string[]): Promise<Map<string, LintRun | null>> {
    if (!this.lintEnabled) return new Map();
    const targets = absPaths.filter(p => checkerFor(p));
    if (!targets.length) return new Map();
    return lintFiles(targets, { workspace: ctx.workspace, signal: ctx.signal, tscTimeoutMs: this.deps.tscTimeoutMs });
  }

  /** Lint "before" state, reusing the cached "after" run of the previous edit when the bytes match. */
  private async lintBefore(ctx: SkillHandlerContext, files: Array<{ abs: string; before: Buffer | null }>): Promise<Map<string, LintRun | null>> {
    const out = new Map<string, LintRun | null>();
    if (!this.lintEnabled) return out;
    const need: string[] = [];
    for (const f of files) {
      const checker = checkerFor(f.abs);
      if (!checker) continue;
      if (!f.before) { out.set(f.abs, { checker, problems: [] }); continue; }
      const cached = this.lintCache.get(f.abs, sha256(f.before));
      if (cached) out.set(f.abs, cached);
      else need.push(f.abs);
    }
    for (const [p, r] of await this.lintRuns(ctx, need)) out.set(p, r);
    return out;
  }

  private async lintAfter(ctx: SkillHandlerContext, files: Array<{ abs: string; after: Buffer | null }>): Promise<Map<string, LintRun | null>> {
    const runs = await this.lintRuns(ctx, files.filter(f => f.after).map(f => f.abs));
    for (const f of files) {
      const r = runs.get(f.abs);
      if (r && !r.skipped && f.after) this.lintCache.set(f.abs, sha256(f.after), r);
    }
    return runs;
  }

  /**
   * Write (or delete, when `after` is null) a set of files: checkpoint, lint
   * before, write, verify, lint after. Returns per-file lint deltas.
   */
  private async commit(
    ctx: SkillHandlerContext,
    state: SessionFileState,
    files: Array<{ abs: string; before: Buffer | null; after: Buffer | null }>,
    reason: string,
  ): Promise<{ ok: true; lint: Map<string, string | undefined>; checkpointId?: string } | { ok: false; error: string }> {
    const checkpointId = await this.checkpoint(ctx, state, files.map(f => f.abs), reason);
    const before = await this.lintBefore(ctx, files);
    for (const f of files) {
      try {
        if (f.after === null) {
          fs.rmSync(f.abs, { force: true });
        } else {
          fs.mkdirSync(path.dirname(f.abs), { recursive: true });
          fs.writeFileSync(f.abs, f.after);
        }
      } catch (e) {
        return { ok: false, error: `Writing ${displayPath(ctx.workspace, f.abs)} failed: ${(e as Error).message}` };
      }
      const onDisk = readMaybe(f.abs);
      const verified = f.after === null ? onDisk === null : !!onDisk && onDisk.equals(f.after);
      if (!verified) {
        return { ok: false, error: `Wrote ${displayPath(ctx.workspace, f.abs)} but the bytes on disk don't match what was written (another process may be writing it). read_file it before trying again.` };
      }
      if (f.after) {
        const st = fs.statSync(f.abs);
        state.remember(f.abs, sha256(f.after), st.mtimeMs, st.size);
      } else {
        state.files.delete(f.abs);
      }
      state.pendingOverwrite.delete(f.abs);
      // Feeds the verify-on-stop nudge: code changed since the last passing run.
      if (ctx.sessionId) recordEdit(ctx.sessionId, f.abs);
      if (checkpointId && this.checkpointsEnabled && isWithin(ctx.workspace, f.abs)) {
        try {
          await this.checkpoints.recordAgentWrite(ctx.workspace, checkpointId, f.abs, f.after);
        } catch { /* best effort */ }
      }
    }
    const after = await this.lintAfter(ctx, files);
    const lint = new Map<string, string | undefined>();
    for (const f of files) lint.set(f.abs, f.after ? formatLintDelta(before.get(f.abs) ?? null, after.get(f.abs) ?? null) : undefined);
    return { ok: true, lint, checkpointId };
  }

  // -------------------------------------------------------------------------
  // write_file
  // -------------------------------------------------------------------------

  async write(ctx: SkillHandlerContext): Promise<ToolResult> {
    const content = ctx.args.content;
    if (typeof content !== 'string') return fail('Missing required parameter: content (the full file text as a string).');
    const resolved = this.resolve(ctx, ctx.args.path);
    if ('error' in resolved) return fail(resolved.error);
    const { abs, display } = resolved;
    const overwrite = asBool(ctx.args.overwrite);
    const append = asBool(ctx.args.append);

    return this.mutex.run(abs, async () => {
      try {
        if (fs.statSync(abs).isDirectory()) return fail(`${display} is a directory — give a file path.`);
      } catch { /* doesn't exist: fine */ }
      const state = this.store.get(ctx.sessionId);
      const existing = readMaybe(abs);
      // Appending keeps everything already there, so it never needs the
      // read-before-overwrite hint.
      const bytes = append && existing
        ? Buffer.concat([existing, Buffer.from(content, 'utf8')])
        : Buffer.from(content, 'utf8');
      const lines = countLines(append && existing ? decodeText(bytes).text : content);

      if (existing) {
        const curHash = sha256(existing);
        if (existing.equals(bytes)) {
          const st = fs.statSync(abs);
          state.remember(abs, curHash, st.mtimeMs, st.size);
          return { success: true, output: json({ ok: true, path: display, bytes: bytes.length, lines, changed: false, verified: true, note: 'File already had exactly this content — nothing written, no need to re-read.' }) };
        }
        const rec = state.files.get(abs);
        const stale = !rec ? 'unread' : rec.hash !== curHash ? 'changed' : null;
        if (stale && !overwrite && !append) {
          const key = sha256(`${abs}\0${sha256(bytes)}\0${curHash}`);
          if (state.pendingOverwrite.get(abs) !== key) {
            state.pendingOverwrite.set(abs, key);
            const existingLines = countLines(decodeText(existing).text);
            const why = stale === 'unread'
              ? `${display} already exists (${existingLines} lines, ${humanSize(existing.length)}) and you haven't read it in this session, so this would replace content you haven't seen.`
              : `${display} changed on disk since you last read or wrote it (someone else edited it), so this would discard those changes.`;
            const how = stale === 'unread'
              ? 'To change part of it: read_file, then patch. To replace it entirely: call write_file again with the same arguments (or add "overwrite": true) and it will go through.'
              : 'read_file it to see the current content, then patch — or call write_file again with the same arguments (or "overwrite": true) to replace it anyway.';
            return fail(`NOT written (hint, not a block): ${why} ${how}`);
          }
        }
      }

      const hints = collectProjectHints(ctx.workspace, abs, state);
      const res = await this.commit(ctx, state, [{ abs, before: existing, after: bytes }], 'write_file');
      if (!res.ok) return fail(res.error);
      const lint = res.lint.get(abs);
      const head = json({
        ok: true, path: display, bytes: bytes.length, lines,
        ...(existing ? { replaced: true } : { created: true }),
        verified: true,
        note: 'Written and verified on disk — no need to re-read.',
      });
      return { success: true, output: [head, lint, hints].filter(Boolean).join('\n') };
    });
  }

  // -------------------------------------------------------------------------
  // patch
  // -------------------------------------------------------------------------

  async patch(ctx: SkillHandlerContext): Promise<ToolResult> {
    const args = ctx.args;
    if (typeof args.patch === 'string' && args.patch.trim()) return this.patchDiff(ctx, args.patch);

    let edits: EditSpec[];
    let rawEdits = args.edits;
    if (typeof rawEdits === 'string') {
      try { rawEdits = JSON.parse(rawEdits); } catch { return fail('edits must be an array of {old_string, new_string, replace_all?} objects (got a string that is not valid JSON).'); }
    }
    if (Array.isArray(rawEdits) && rawEdits.length) {
      edits = [];
      for (const [i, e] of rawEdits.entries()) {
        const o = e as Record<string, unknown>;
        if (!o || typeof o.old_string !== 'string' || typeof o.new_string !== 'string') {
          return fail(`edits[${i}] needs string old_string and new_string. No edits were applied.`);
        }
        edits.push({ old_string: o.old_string, new_string: o.new_string, replace_all: asBool(o.replace_all) });
      }
    } else {
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
        return fail('patch needs either old_string + new_string, edits: [{old_string, new_string}], or patch: "<unified diff>".');
      }
      edits = [{ old_string: args.old_string, new_string: args.new_string, replace_all: asBool(args.replace_all) }];
    }

    const resolved = this.resolve(ctx, args.path);
    if ('error' in resolved) return fail(resolved.error);
    const { abs, display } = resolved;

    // Creating (or filling an empty) file through patch: one edit with an empty old_string.
    if (edits.length === 1 && edits[0].old_string === '') {
      const current = readMaybe(abs);
      if (!current || current.length === 0) {
        return this.write({ ...ctx, args: { path: args.path, content: edits[0].new_string, overwrite: true } });
      }
    }

    return this.mutex.run(abs, async () => {
      const state = this.store.get(ctx.sessionId);
      const existing = readMaybe(abs);
      if (!existing) {
        try {
          if (fs.statSync(abs).isDirectory()) return fail(`${display} is a directory — give a file path.`);
        } catch { /* missing */ }
        return fail(notFoundMessage(ctx.workspace, abs, display));
      }
      if (looksBinary(existing, abs)) return fail(`${display} is a binary file — patch edits text only.`);

      const decoded = decodeText(existing);
      const original = decoded.text;
      let cur = original;
      const applied: Array<{ strategy: StrategyName; count: number; lines: number[]; similarity?: number }> = [];
      let alreadyApplied = 0;
      for (const [i, e] of edits.entries()) {
        const spec: EditSpec = {
          old_string: e.old_string.replace(/\r\n/g, '\n'),
          new_string: e.new_string.replace(/\r\n/g, '\n'),
          replace_all: e.replace_all,
        };
        const plan = planEdit(cur, spec);
        if (plan.kind === 'applied') {
          cur = plan.text;
          applied.push({ strategy: plan.strategy, count: plan.count, lines: plan.lines, similarity: plan.similarity });
        } else if (plan.kind === 'already-applied') {
          alreadyApplied++;
        } else {
          const prefix = edits.length > 1 ? `Edit ${i + 1} of ${edits.length} failed — no edits were applied (all-or-nothing). ` : '';
          return fail(prefix + this.describeFailure(plan, cur, display));
        }
      }

      if (cur === original) {
        return {
          success: true,
          output: json({ ok: true, path: display, changed: false, already_applied: true, note: "Already applied — the file already contains new_string, so nothing changed. Don't repeat this edit." }),
        };
      }

      const after = encodeText(decoded, cur);
      const hints = collectProjectHints(ctx.workspace, abs, state);
      const res = await this.commit(ctx, state, [{ abs, before: existing, after }], 'patch');
      if (!res.ok) return fail(res.error);

      const strategies = [...new Set(applied.map(a => a.strategy))];
      const fuzzy = strategies.filter(s => s !== 'exact');
      const sims = applied.filter(a => a.similarity !== undefined).map(a => Math.round(a.similarity! * 100));
      const head = json({
        ok: true,
        path: display,
        match: strategies.length === 1 ? strategies[0] : strategies,
        ...(sims.length && { similarity: `${Math.min(...sims)}%` }),
        replacements: applied.reduce((n, a) => n + a.count, 0),
        at_lines: applied.flatMap(a => a.lines),
        ...(alreadyApplied && { already_applied_edits: alreadyApplied }),
        verified: true,
        note: fuzzy.length
          ? `Edited via ${fuzzy.join('+')} match (old_string wasn't byte-exact; the file's text was used). Verified on disk — no need to re-read; check the diff.`
          : 'Edited and verified on disk — no need to re-read.',
      });
      const diff = compactDiff(original, cur, MAX_DIFF_LINES);
      return { success: true, output: [head, diff && `diff:\n${diff}`, res.lint.get(abs), hints].filter(Boolean).join('\n') };
    });
  }

  private describeFailure(plan: EditPlan, text: string, display: string): string {
    const lines = text.split('\n');
    if (plan.kind === 'invalid') return plan.message;
    if (plan.kind === 'ambiguous') {
      const shown = plan.lines.slice(0, 5).map(ln => `--- match at line ${ln}:\n${numbered(lines, 1, ln - 3, ln + 1)}`);
      const more = plan.lines.length > 5 ? `\n… and ${plan.lines.length - 5} more` : '';
      return `old_string matches ${plan.lines.length} places in ${display} (${plan.strategy} match), at lines ${plan.lines.join(', ')}:\n${shown.join('\n')}${more}\nAdd surrounding lines to old_string so it matches exactly one place, or set replace_all: true to change all of them.`;
    }
    if (plan.kind === 'no-match') {
      const c = plan.closest;
      if (c && c.similarity >= 0.3) {
        const n = c.lastLine - c.firstLine + 1;
        const region = numbered(lines, 1, c.firstLine, Math.min(c.lastLine, c.firstLine + 14));
        return `old_string not found in ${display}. Closest region: lines ${c.firstLine + 1}-${c.lastLine + 1} (${Math.round(c.similarity * 100)}% similar):\n${region}\nRe-read those lines (read_file offset ${c.firstLine + 1}, limit ${n}) and copy old_string exactly from the file — don't retry the same old_string.`;
      }
      return `old_string not found in ${display}, and nothing similar is there. read_file it and copy old_string exactly from the file — don't retry the same old_string.`;
    }
    return 'Edit could not be applied.';
  }

  // -------------------------------------------------------------------------
  // patch — diff mode
  // -------------------------------------------------------------------------

  private async patchDiff(ctx: SkillHandlerContext, patchText: string): Promise<ToolResult> {
    let patches: FilePatch[];
    try {
      patches = parsePatch(patchText, typeof ctx.args.path === 'string' ? ctx.args.path : undefined);
    } catch (e) {
      return fail(`Couldn't parse the patch: ${(e as Error).message}`);
    }

    // Resolve every path first.
    const planned: Array<{ fp: FilePatch; src: ResolvedPath; dest?: ResolvedPath }> = [];
    for (const fp of patches) {
      const src = this.resolve(ctx, fp.path);
      if ('error' in src) return fail(src.error);
      let dest: ResolvedPath | undefined;
      if (fp.moveTo) {
        const d = this.resolve(ctx, fp.moveTo);
        if ('error' in d) return fail(d.error);
        dest = d;
      }
      planned.push({ fp, src, dest });
    }
    const lockKeys = planned.flatMap(p => [p.src.abs, ...(p.dest ? [p.dest.abs] : [])]);

    return this.mutex.runAll(lockKeys, async () => {
      const state = this.store.get(ctx.sessionId);
      // Work on an in-memory view so hunks for the same file chain correctly.
      const view = new Map<string, { before: Buffer | null; after: Buffer | null; decoded?: Decoded }>();
      const load = (abs: string) => {
        if (!view.has(abs)) {
          const before = readMaybe(abs);
          view.set(abs, { before, after: before, decoded: before ? decodeText(before) : undefined });
        }
        return view.get(abs)!;
      };
      const summary: Array<{ path: string; action: string; match?: string[]; already_applied?: boolean }> = [];

      for (const [fi, { fp, src, dest }] of planned.entries()) {
        const where = `File ${fi + 1} of ${planned.length} (${src.display})`;
        const entry = load(src.abs);
        if (fp.kind === 'add') {
          const content = fp.hunks.flatMap(h => h.newLines).join('\n') + '\n';
          if (entry.after) {
            if (decodeText(entry.after).text === content) {
              summary.push({ path: src.display, action: 'unchanged', already_applied: true });
              continue;
            }
            return fail(`${where}: the patch adds ${src.display} but it already exists. Use an update section (--- a/${src.display} / +++ b/${src.display}) or write_file. No files were changed.`);
          }
          entry.after = Buffer.from(content, 'utf8');
          summary.push({ path: src.display, action: 'created' });
          continue;
        }
        if (!entry.after) return fail(`${where}: ${notFoundMessage(ctx.workspace, src.abs, src.display)} No files were changed.`);
        if (fp.kind === 'delete') {
          entry.after = null;
          summary.push({ path: src.display, action: 'deleted' });
          continue;
        }
        if (looksBinary(entry.after, src.abs)) return fail(`${where}: binary file — can't patch it. No files were changed.`);
        const decoded = entry.decoded ?? decodeText(entry.after);
        let cur = decodeText(entry.after).text;
        const strategies: string[] = [];
        let delta = 0;
        let already = 0;
        for (const [hi, h] of fp.hunks.entries()) {
          if (!h.oldLines.length) {
            // Pure insertion: after line oldStart (0 = top), else at the end.
            const idx = new LineIndex(cur);
            const insertText = h.newLines.join('\n') + '\n';
            if (cur.includes(insertText) && insertText.trim()) { already++; continue; }
            const at = h.oldStart !== undefined ? Math.min(idx.lines.length, Math.max(0, h.oldStart + delta)) : idx.lines.length;
            const offset = at >= idx.lines.length ? cur.length : idx.starts[at];
            const glue = offset === cur.length && cur && !cur.endsWith('\n') ? '\n' : '';
            cur = cur.slice(0, offset) + glue + insertText + cur.slice(offset);
            delta += h.newLines.length;
            strategies.push('insert');
            continue;
          }
          const plan = planEdit(cur, {
            old_string: h.oldLines.join('\n') + '\n',
            new_string: h.newLines.length ? h.newLines.join('\n') + '\n' : '',
            lineAnchored: true,
            ...(h.oldStart !== undefined && { lineHint: h.oldStart + delta }),
          });
          if (plan.kind === 'applied') {
            cur = plan.text;
            strategies.push(plan.strategy);
            delta += h.newLines.length - h.oldLines.length;
          } else if (plan.kind === 'already-applied') {
            already++;
          } else {
            return fail(`${where}, hunk ${hi + 1} of ${fp.hunks.length} failed — no files were changed (all-or-nothing). ${this.describeFailure(plan, cur, src.display).replace(/old_string/g, "the hunk's context/'-' lines")}`);
          }
        }
        const newBuf = encodeText(decoded, cur);
        if (dest && dest.abs !== src.abs) {
          const target = load(dest.abs);
          if (target.after) return fail(`${where}: can't move to ${dest.display} — it already exists. No files were changed.`);
          target.after = newBuf;
          entry.after = null;
          summary.push({ path: `${src.display} → ${dest.display}`, action: 'moved', match: [...new Set(strategies)] });
        } else {
          entry.after = newBuf;
          const changed = !(entry.before && entry.before.equals(newBuf));
          summary.push({ path: src.display, action: changed ? 'updated' : 'unchanged', match: [...new Set(strategies)], ...(already && { already_applied: true }) });
        }
      }

      const files = [...view.entries()]
        .filter(([, v]) => !(v.before === null && v.after === null) && !(v.before && v.after && v.before.equals(v.after)))
        .map(([abs, v]) => ({ abs, before: v.before, after: v.after }));
      if (!files.length) {
        return { success: true, output: json({ ok: true, changed: false, files: summary, note: "Already applied — every hunk is already in the files; nothing changed. Don't repeat this patch." }) };
      }
      const hints = files.map(f => collectProjectHints(ctx.workspace, f.abs, state)).filter(Boolean).join('\n\n');
      const res = await this.commit(ctx, state, files, 'patch');
      if (!res.ok) return fail(res.error);

      const perFile = Math.max(12, Math.floor(MAX_DIFF_LINES * 1.5 / files.length));
      const sections: string[] = [];
      for (const f of files) {
        const shown = displayPath(ctx.workspace, f.abs);
        if (f.after === null) { sections.push(`deleted ${shown}`); continue; }
        const beforeText = f.before ? decodeText(f.before).text : '';
        const d = compactDiff(beforeText, decodeText(f.after).text, perFile);
        if (d) sections.push(`diff ${shown}:\n${d}`);
        const lint = res.lint.get(f.abs);
        if (lint) sections.push(`${shown} ${lint}`);
      }
      const head = json({ ok: true, files: summary, verified: true, note: 'Patch applied and verified on disk — no need to re-read.' });
      return { success: true, output: [head, ...sections, hints].filter(Boolean).join('\n') };
    });
  }

  // -------------------------------------------------------------------------
  // undo
  // -------------------------------------------------------------------------

  async undo(ctx: SkillHandlerContext): Promise<ToolResult> {
    if (!this.checkpointsEnabled) return fail('Checkpoints are disabled in this deployment, so there is nothing to undo.');
    const now = this.now();
    const ago = (t: number) => {
      const s = Math.max(0, Math.round((now - t) / 1000));
      return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
    };
    if (asBool(ctx.args.list)) {
      const list = await this.checkpoints.list(ctx.workspace, 15);
      if (!list.length) return { success: true, output: 'No checkpoints yet for this workspace — nothing to undo.' };
      const rows = list.map(c => {
        const files = c.files.map(f => f.path);
        const shownFiles = files.slice(0, 4).join(', ') + (files.length > 4 ? ` (+${files.length - 4} more)` : '');
        const mine = c.sessionId === ctx.sessionId ? ' (this session)' : '';
        return `${c.id}  ${ago(c.createdAt)}${mine}  ${c.reason}  ${shownFiles}${c.undoneAt ? '  [already undone]' : ''}`;
      });
      return { success: true, output: `Recent checkpoints (newest first):\n${rows.join('\n')}\nCall undo with checkpoint_id to restore one. Files changed since by someone else are left alone.` };
    }

    const id = typeof ctx.args.checkpoint_id === 'string' && ctx.args.checkpoint_id.trim() ? ctx.args.checkpoint_id.trim() : undefined;
    const result = await this.checkpoints.restore(ctx.workspace, { id, sessionId: ctx.sessionId });
    if ('error' in result) return fail(result.error);

    const state = this.store.get(ctx.sessionId);
    for (const p of [...result.restored, ...result.removed]) {
      const abs = path.join(path.resolve(ctx.workspace), ...p.split('/'));
      const buf = readMaybe(abs);
      if (buf) {
        const st = fs.statSync(abs);
        state.remember(abs, sha256(buf), st.mtimeMs, st.size);
      } else {
        state.files.delete(abs);
      }
    }
    // The next write starts a fresh checkpoint.
    state.turnCheckpointId = undefined;
    state.turnSnapshotted.clear();

    const parts = [`Restored checkpoint ${result.checkpoint.id} (taken ${ago(result.checkpoint.createdAt)} before ${result.checkpoint.reason}).`];
    if (result.restored.length) parts.push(`Restored: ${result.restored.join(', ')}.`);
    if (result.removed.length) parts.push(`Removed files the agent had created: ${result.removed.join(', ')}.`);
    if (!result.restored.length && !result.removed.length) parts.push('No files needed restoring.');
    if (result.skipped.length) {
      parts.push(`Skipped (left as they are): ${result.skipped.map(s => `${s.path} — ${s.why}`).join('; ')}.`);
    }
    parts.push('Files are back on disk; re-read before editing them again.');
    return { success: true, output: parts.join(' ') };
  }
}
