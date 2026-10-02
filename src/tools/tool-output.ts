/**
 * Tool-output persistence shared by every native tool.
 *
 * Big tool results are written to `${SCALLOPBOT_HOME}/tool-output/<session>/`
 * and the model gets a preview plus the path, so it can page through the full
 * text with read_file instead of the context window filling up with it.
 */

import { closeSync, mkdirSync, openSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Root of ScallopBot's local state: SCALLOPBOT_HOME, SCALLOPBOT_DATA_DIR, or ~/.scallopbot. */
export function scallopbotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCALLOPBOT_HOME || env.SCALLOPBOT_DATA_DIR || path.join(homedir(), '.scallopbot');
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'session';
}

/** Directory holding persisted tool output for one session (created on demand). */
export function toolOutputDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = path.join(scallopbotHome(env), 'tool-output', safeSegment(sessionId || 'session'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

let seq = 0;
/** `<ts>-<tool>` stem, unique within this process even for same-millisecond writes. */
export function toolOutputStem(toolName: string): string {
  seq = (seq + 1) % 1_000_000;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${String(seq).padStart(3, '0')}-${safeSegment(toolName)}`;
}

/** Write `text` to `<ts>-<tool>.txt` in the session's tool-output dir and return the path. */
export function saveToolOutput(sessionId: string, toolName: string, text: string): string {
  const file = path.join(toolOutputDir(sessionId), `${toolOutputStem(toolName)}.txt`);
  writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * Keep the start and the end of a long text (`headRatio` of the budget from the
 * head, the rest from the tail) with a marker saying how much was cut.
 */
export function capHeadTail(text: string, maxChars: number, headRatio = 0.4, note = ''): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  const marker = `\n\n... [${omitted} chars omitted of ${text.length}${note ? `; ${note}` : ''}] ...\n\n`;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/**
 * Head+tail cap applied straight to a file, without reading the whole file
 * into memory. Returns the text and the total byte size.
 */
export function readFileHeadTail(
  file: string,
  maxChars: number,
  headRatio = 0.4,
  note = '',
): { text: string; bytes: number; truncated: boolean } {
  const fd = openSync(file, 'r');
  try {
    const bytes = fstatSync(fd).size;
    // Read a little extra so multi-byte characters near the edges survive.
    if (bytes <= maxChars * 4) {
      const buf = Buffer.alloc(bytes);
      readSync(fd, buf, 0, bytes, 0);
      const full = buf.toString('utf8');
      return { text: capHeadTail(full, maxChars, headRatio, note), bytes, truncated: full.length > maxChars };
    }
    const headChars = Math.floor(maxChars * headRatio);
    const tailChars = maxChars - headChars;
    const headBuf = Buffer.alloc(headChars);
    readSync(fd, headBuf, 0, headChars, 0);
    const tailBuf = Buffer.alloc(tailChars);
    readSync(fd, tailBuf, 0, tailChars, bytes - tailChars);
    const omitted = bytes - headChars - tailChars;
    const marker = `\n\n... [${omitted} bytes omitted of ${bytes}${note ? `; ${note}` : ''}] ...\n\n`;
    return { text: headBuf.toString('utf8') + marker + tailBuf.toString('utf8'), bytes, truncated: true };
  } finally {
    closeSync(fd);
  }
}

/** Minimum persist threshold in characters. */
export const PERSIST_MIN_CHARS = 8_000;
/** Share of the model's context window (in chars, ~4 chars/token) a single result may take. */
export const PERSIST_WINDOW_SHARE = 0.15;
export const PERSIST_PREVIEW_CHARS = 1_500;

/** Tools whose output is never persisted (they are the way to read persisted output). */
const PERSIST_EXEMPT = new Set(['read_file']);

export interface PersistOptions {
  /** Explicit threshold in characters; overrides the window-based default. */
  threshold?: number;
  /** Context window of the active model, in tokens. */
  contextWindowTokens?: number;
}

/** `max(8000, 15% of the window in chars)`; 8000 when the window is unknown. */
export function persistThreshold(opts: PersistOptions = {}): number {
  if (typeof opts.threshold === 'number' && opts.threshold > 0) return opts.threshold;
  const windowChars = (opts.contextWindowTokens ?? 0) * 4;
  return Math.max(PERSIST_MIN_CHARS, Math.floor(windowChars * PERSIST_WINDOW_SHARE));
}

/**
 * Generic large-result guard for any tool result. When `text` is over the
 * threshold, the full text is saved to the session's tool-output dir and a
 * `<persisted-output>` block (path, size, 1,500-char preview, how to read it)
 * is returned instead. Otherwise `text` comes back unchanged. read_file is
 * exempt, as is output that is already a persisted-output block.
 */
export function persistLargeOutput(
  sessionId: string,
  toolName: string,
  text: string,
  opts: PersistOptions = {},
): string {
  if (PERSIST_EXEMPT.has(toolName)) return text;
  if (text.length <= persistThreshold(opts)) return text;
  if (text.startsWith('<persisted-output')) return text;
  let file: string;
  try {
    file = saveToolOutput(sessionId, toolName, text);
  } catch {
    // Disk trouble must not lose the result; fall back to an in-context cap.
    return capHeadTail(text, persistThreshold(opts));
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const preview = text.slice(0, PERSIST_PREVIEW_CHARS);
  return [
    `<persisted-output path="${file}" bytes="${bytes}" chars="${text.length}">`,
    preview,
    preview.length < text.length ? `... [preview: first ${preview.length} of ${text.length} chars]` : '',
    `</persisted-output>`,
    `The full ${toolName} output is in ${file}. Use read_file with offset/limit to read the parts you need.`,
  ].filter(Boolean).join('\n');
}
