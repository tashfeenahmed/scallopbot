/**
 * Durable state of a session's lean compaction. One row per session, updated
 * in place on every compaction (`session_compactions` table).
 *
 * Indices are absolute positions in the session's full message list (the
 * order SessionManager/getSessionMessages return, i.e. ascending row id).
 * Replay is: messages[0, headEnd) + summary message + messages[tailStart, …),
 * with tool results at index < stubBefore replaced by one-line stubs.
 */

import type { Message } from '../providers/types.js';
import type { AnchorIndex } from './anchors.js';

export interface CompactionState {
  version: 1;
  /** Messages [0, headEnd) are replayed (free-pass applied). */
  headEnd: number;
  /** Messages [tailStart, end) are replayed after the summary message. */
  tailStart: number;
  /** Tool results at absolute index < stubBefore are replayed as stubs. */
  stubBefore: number;
  /** Fingerprint of messages[tailStart - 1]; detects a different/rewritten transcript. */
  boundaryFingerprint: string;
  /** Role used for the summary message (chosen to keep role alternation). */
  summaryRole: Message['role'];
  /** Section body produced by the summary model (or the deterministic fallback). */
  summary: string;
  anchors: AnchorIndex;
  /** Genuine user messages from every compacted span, verbatim, newest first. */
  quotedUserMessages: string[];
  /** Visible assistant replies from the compacted spans, excerpted, newest first. */
  assistantReplies?: string[];
  /** Caller-supplied extra state (todo list, kernel variables) at compaction time. */
  extraState?: string;
  usedFallback: boolean;
  compactionCount: number;
  /** Fully rendered summary message text as replayed. */
  summaryMessage: string;
  createdAt: number;
  updatedAt: number;
}

/** Minimal persistence port (implemented by ScallopDatabase). */
export interface CompactionStore {
  getSessionCompaction(sessionId: string): { stateJson: string } | null;
  saveSessionCompaction(sessionId: string, stateJson: string, summaryMessage: string, compactionCount: number): void;
}

export function messageFingerprint(message: { role: string; content: unknown } | undefined): string {
  if (!message) return '';
  const text = `${message.role}\u0000${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`;
  // FNV-1a 32-bit, plus length: cheap and stable across processes.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}

export function isCompactionState(value: unknown): value is CompactionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<CompactionState>;
  return state.version === 1
    && typeof state.headEnd === 'number'
    && typeof state.tailStart === 'number'
    && typeof state.stubBefore === 'number'
    && typeof state.summaryMessage === 'string'
    && typeof state.boundaryFingerprint === 'string';
}

export function loadCompactionState(store: CompactionStore, sessionId: string): CompactionState | null {
  const row = store.getSessionCompaction(sessionId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.stateJson) as unknown;
    return isCompactionState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCompactionState(store: CompactionStore, sessionId: string, state: CompactionState): void {
  store.saveSessionCompaction(sessionId, JSON.stringify(state), state.summaryMessage, state.compactionCount);
}

/** True when the stored boundaries still describe this transcript. */
export function compactionStateMatches(
  state: CompactionState | null | undefined,
  messages: readonly { role: string; content: unknown }[],
): state is CompactionState {
  if (!state) return false;
  if (state.headEnd < 0 || state.headEnd > state.tailStart) return false;
  if (state.tailStart > messages.length || state.tailStart < 1) return false;
  return messageFingerprint(messages[state.tailStart - 1]) === state.boundaryFingerprint;
}
