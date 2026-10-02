/**
 * Full-history replay for the agent loop.
 *
 * Replaces the old "visible text of the last 8 turns" window: every message
 * since the last compaction boundary — including earlier turns' tool calls
 * and results — is replayed, prefixed by the compaction summary. Replay is a
 * pure function of (transcript, compaction state), so between compactions the
 * prefix is byte-stable and append-only, which is what prompt caching needs.
 *
 * Kind semantics follow session-message-view.ts: in completed turns, internal
 * control notes (`[System: …]`, worker transcripts), empty human rows and
 * reasoning-only assistant rows are dropped; the latest genuine human turn and
 * everything after it is kept byte-for-byte (except free-pass stubs).
 */

import type { ContentBlock, Message, ToolResultContent, ToolUseContent } from '../providers/types.js';
import type { PersistedSessionMessageKind } from '../memory/session-message-kinds.js';
import { classifySessionMessage } from '../memory/session-message-view.js';
import { compactionStateMatches, type CompactionState } from './compaction-state.js';
import { contentBlocks } from './message-text.js';

export interface ReplayInputMessage {
  role: string;
  content: unknown;
  messageKind?: PersistedSessionMessageKind | null;
}

export interface ReplayOptions {
  compactionState?: CompactionState | null;
  /** Newest images kept as images; older ones become a text placeholder. Default 3. */
  maxImages?: number;
}

/** Tool results shorter than this are kept verbatim by the free pass. */
export const STUB_MIN_CHARS = 300;
/** Identical tool results at least this long are deduplicated by the free pass. */
export const DEDUPE_MIN_CHARS = 120;
export const DEFAULT_MAX_IMAGES = 3;
export const MISSING_TOOL_RESULT = '[no result was recorded for this tool call]';

function normalizeContent(message: ReplayInputMessage): Message['content'] | null {
  const content = message.content;
  if (content == null) return null;
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content !== 'string') return null;
  // A genuine human string that happens to look like JSON stays a string.
  if (message.messageKind === 'human_user') return content;
  const blocks = contentBlocks(content);
  if (blocks && blocks.length > 0 && blocks.every(block => typeof block.type === 'string')) {
    return blocks as unknown as ContentBlock[];
  }
  return content;
}

function isEmptyContent(content: Message['content'] | null): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.length === 0;
  return content.length === 0;
}

function formatChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k chars`;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  };
  const parts: string[] = [];
  const path = pick('path', 'file_path', 'filePath', 'file', 'filename', 'target', 'dir', 'directory');
  const command = pick('command', 'cmd', 'script', 'code');
  const query = pick('query', 'q', 'pattern', 'url', 'search', 'action', 'operation', 'name', 'title', 'message');
  if (path) parts.push(path);
  if (command) parts.push(firstLine(command, 100));
  if (!path && !command && query) parts.push(firstLine(query, 100));
  const start = pick('start_line', 'startLine', 'offset', 'line');
  const end = pick('end_line', 'endLine');
  const limit = pick('limit', 'lines');
  if (start && end) parts.push(`lines ${start}-${end}`);
  else if (start && limit) parts.push(`lines ${start}-${Number(start) + Number(limit) - 1}`);
  if (parts.length === 0) {
    const firstString = Object.values(input).find(value => typeof value === 'string' && value.trim());
    if (typeof firstString === 'string') parts.push(firstLine(firstString, 80));
  }
  return parts.join(' ');
}

function describeOutcome(result: ToolResultContent): string {
  const text = typeof result.content === 'string' ? result.content : '';
  if (result.is_error) return `error: ${firstLine(text.replace(/^Error:\s*/i, ''), 90)}`;
  const exit = text.match(/"?exit[_ ]?code"?\s*[:=]\s*(-?\d+)/i) ?? text.match(/\bexit(?:ed with)?(?: code)? (-?\d+)\b/i);
  if (exit) return `exit ${exit[1]}`;
  return firstLine(text, 90);
}

/**
 * One-line stub for an old tool result, derived from the paired tool_use
 * input: `[read_file] src/x.ts lines 1-200 → <first line> (8.0k chars)`.
 */
export function stubToolResult(toolUse: ToolUseContent | undefined, result: ToolResultContent): string {
  const name = toolUse?.name ?? 'tool';
  const target = describeToolTarget(toolUse?.input);
  const outcome = describeOutcome(result);
  const size = typeof result.content === 'string' ? result.content.length : 0;
  return `[${name}]${target ? ` ${target}` : ''}${outcome ? ` → ${outcome}` : ''} (${formatChars(size)}; stubbed by compaction — session_search can recover it)`;
}

function collectToolUses(messages: readonly { content: Message['content'] | null }[]): Map<string, ToolUseContent> {
  const uses = new Map<string, ToolUseContent>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.set(block.id, block);
    }
  }
  return uses;
}

/**
 * Guarantee provider-valid tool pairing (Anthropic + OpenAI): every
 * assistant tool_use is immediately followed by a user message carrying a
 * tool_result for each id (tool_results first); orphan tool_results are
 * removed. Tool-use arguments are never modified.
 */
export function ensureToolPairing(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const blocks = Array.isArray(message.content) ? message.content : null;
    if (message.role === 'assistant' && blocks?.some(block => block.type === 'tool_use')) {
      const ids = blocks.filter((block): block is ToolUseContent => block.type === 'tool_use').map(block => block.id);
      out.push(message);
      const next = messages[index + 1];
      const nextBlocks = next && next.role === 'user' && Array.isArray(next.content) ? next.content : null;
      const found = new Map<string, ToolResultContent>();
      const others: ContentBlock[] = [];
      if (nextBlocks?.some(block => block.type === 'tool_result')) {
        for (const block of nextBlocks) {
          if (block.type === 'tool_result') {
            if (ids.includes(block.tool_use_id) && !found.has(block.tool_use_id)) found.set(block.tool_use_id, block);
          } else {
            others.push(block);
          }
        }
        index++; // consumed
      }
      const results: ContentBlock[] = ids.map(id => found.get(id)
        ?? { type: 'tool_result', tool_use_id: id, content: MISSING_TOOL_RESULT, is_error: true });
      const unchanged = nextBlocks
        && found.size === ids.length
        && nextBlocks.length === ids.length + others.length
        && nextBlocks.slice(0, ids.length).every((block, position) => block.type === 'tool_result' && block.tool_use_id === ids[position]);
      out.push(unchanged ? messages[index] : { role: 'user', content: [...results, ...others] });
      continue;
    }
    if (message.role === 'user' && blocks?.some(block => block.type === 'tool_result')) {
      const remaining = blocks.filter(block => block.type !== 'tool_result');
      if (remaining.length > 0) out.push({ ...message, content: remaining });
      continue;
    }
    out.push(message);
  }
  return out;
}

/** Replace all but the newest `maxImages` image blocks with a text placeholder. */
export function capImages(messages: readonly Message[], maxImages = DEFAULT_MAX_IMAGES): Message[] {
  let kept = 0;
  const out = [...messages];
  for (let index = out.length - 1; index >= 0; index--) {
    const content = out[index].content;
    if (!Array.isArray(content) || !content.some(block => block.type === 'image')) continue;
    let changed = false;
    const blocks = [...content].reverse().map(block => {
      if (block.type !== 'image') return block;
      if (kept < maxImages) { kept++; return block; }
      changed = true;
      return { type: 'text', text: '[older image omitted by compaction]' } as ContentBlock;
    }).reverse();
    if (changed) out[index] = { ...out[index], content: blocks };
  }
  return out;
}

/**
 * Free pass over tool results at absolute index < stubBefore: duplicates
 * become a back-reference, large results become a one-line stub.
 */
function applyFreePass(
  content: Message['content'],
  uses: Map<string, ToolUseContent>,
  seen: Map<string, string>,
): Message['content'] {
  if (!Array.isArray(content) || !content.some(block => block.type === 'tool_result')) return content;
  let changed = false;
  const blocks = content.map(block => {
    if (block.type !== 'tool_result' || typeof block.content !== 'string') return block;
    const body = block.content;
    const use = uses.get(block.tool_use_id);
    if (body.length >= DEDUPE_MIN_CHARS) {
      const previous = seen.get(body);
      if (previous) {
        changed = true;
        return { ...block, content: `[${use?.name ?? 'tool'}] output identical to the earlier ${previous} result (${formatChars(body.length)})` };
      }
      seen.set(body, use?.name ?? 'tool');
    }
    if (body.length < STUB_MIN_CHARS) return block;
    changed = true;
    return { ...block, content: stubToolResult(use, block) };
  });
  return changed ? blocks : content;
}

interface Prepared {
  index: number;
  role: Message['role'];
  content: Message['content'];
  messageKind?: PersistedSessionMessageKind | null;
}

/** Latest genuine human turn index (absolute), or -1. */
export function latestHumanTurnIndex(messages: readonly ReplayInputMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isGenuineHuman(messages[index])) return index;
  }
  return -1;
}

const HARNESS_PREFIX_RE = /^\s*\[(?:System:|kind:)/i;

export function isGenuineHuman(message: ReplayInputMessage): boolean {
  const content = normalizeContent(message);
  const view = classifySessionMessage(
    { role: message.role, content, messageKind: message.messageKind ?? null },
    { treatSubAgentSessionAsInternal: false },
  );
  return view.isHumanTurn && !HARNESS_PREFIX_RE.test(view.visibleText);
}

function shouldDropCompleted(message: Prepared): boolean {
  const view = classifySessionMessage(
    { role: message.role, content: message.content, messageKind: message.messageKind ?? null },
    { treatSubAgentSessionAsInternal: false },
  );
  if (view.kind === 'internal' && !view.hasToolResult && !view.hasToolUse) return true;
  if (view.persistedKind === 'assistant_internal' && !view.hasToolUse) return true;
  if (message.role === 'assistant' && Array.isArray(message.content)
    && message.content.length > 0 && message.content.every(block => block.type === 'thinking')) return true;
  return false;
}

/**
 * Build the message list sent to the provider: head + compaction summary +
 * everything since the boundary (or the full history when never compacted).
 */
export function buildReplayMessages(
  sessionMessages: readonly ReplayInputMessage[],
  options: ReplayOptions = {},
): Message[] {
  const state = compactionStateMatches(options.compactionState, sessionMessages)
    ? options.compactionState
    : null;
  const latestHuman = latestHumanTurnIndex(sessionMessages);

  const prepared: Prepared[] = [];
  sessionMessages.forEach((message, index) => {
    if (state && index >= state.headEnd && index < state.tailStart) return;
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const content = normalizeContent(message);
    if (isEmptyContent(content)) return;
    prepared.push({ index, role: message.role, content: content!, messageKind: message.messageKind });
  });

  const filtered = prepared.filter(message => message.index >= latestHuman || latestHuman < 0
    ? true
    : !shouldDropCompleted(message));

  const uses = collectToolUses(prepared);
  const seen = new Map<string, string>();
  const stubBefore = state?.stubBefore ?? 0;
  let messages: Message[] = filtered.map(message => ({
    role: message.role,
    content: message.index < stubBefore ? applyFreePass(message.content, uses, seen) : message.content,
  }));

  if (state) {
    const headCount = filtered.filter(message => message.index < state.headEnd).length;
    const head = messages.slice(0, headCount);
    while (head[0]?.role === 'assistant') head.shift();
    const summaryRole: Message['role'] = head.length === 0 ? 'user' : state.summaryRole;
    messages = [
      ...head,
      { role: summaryRole, content: state.summaryMessage },
      ...messages.slice(headCount),
    ];
  } else {
    while (messages[0]?.role === 'assistant') messages.shift();
  }

  return ensureToolPairing(capImages(messages, options.maxImages ?? DEFAULT_MAX_IMAGES));
}
