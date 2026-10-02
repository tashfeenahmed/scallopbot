/**
 * Lean compaction (Hermes-style).
 *
 *  1. Free pass (no LLM): old tool results → one-line stubs derived from the
 *     paired tool_use input, identical results deduplicated, newest 3 images
 *     kept. Tool-use arguments are never rewritten; every tool_use keeps a
 *     tool_result.
 *  2. Boundaries: head = first 3 messages; tail = clamp(2.5% of window,
 *     10k, 25k) tokens, ≥ 8 messages, starting at a genuine user message so a
 *     tool_use is never split from its tool_result.
 *  3. One structured summary call (main model) with fixed sections, updated
 *     iteratively ("previous summary + new turns").
 *  4. Regex anchor index (SHAs, PR/issue numbers, paths, URLs, ids, errors).
 *  5. Every genuine user message of the compacted span quoted verbatim,
 *     newest first, up to 24k chars.
 *  6. Fixed prefix/suffix; caller hook for extra state (todo list, kernel vars).
 *  7. Deterministic fallback when the summary call fails or times out.
 */

import type { ContentBlock, LLMProvider, Message, ToolResultContent, ToolUseContent } from '../providers/types.js';
import { classifySessionMessage } from '../memory/session-message-view.js';
import { stripThinkTags } from '../utils/output-safety.js';
import {
  extractAnchors, mergeAnchors, renderAnchors, emptyAnchors, type AnchorFragment, type AnchorIndex,
} from './anchors.js';
import {
  compactionStateMatches, loadCompactionState, messageFingerprint, saveCompactionState,
  type CompactionState, type CompactionStore,
} from './compaction-state.js';
import { contentBlocks, toolResultText, truncateMiddle } from './message-text.js';
import {
  buildReplayMessages, isGenuineHuman, latestHumanTurnIndex, stubToolResult, type ReplayInputMessage,
} from './replay.js';

export const COMPACTION_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted. Respond only to the latest user message below.';
export const COMPACTION_SUFFIX = 'Use session_search to recover any detail not shown here.';

export const SUMMARY_SECTIONS = [
  'Goal',
  'Constraints & Preferences',
  'Completed Actions',
  'Active State',
  'Blocked',
  'Key Decisions',
  'Errors & Fixes',
  'Relevant Files',
  'Critical Context',
] as const;

export const HEAD_MESSAGES = 3;
export const MIN_TAIL_MESSAGES = 8;
export const TAIL_MIN_TOKENS = 10_000;
export const TAIL_MAX_TOKENS = 25_000;
export const TAIL_WINDOW_RATIO = 0.025;
export const QUOTED_USER_CHARS = 24_000;
export const ASSISTANT_REPLY_CHARS = 32_000;
export const ASSISTANT_REPLY_EACH_CHARS = 1_000;
export const DEFAULT_SUMMARY_TIMEOUT_MS = 90_000;
const IMAGE_TOKENS = 1_600;
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Token estimation + trigger
// ---------------------------------------------------------------------------

export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  let images = 0;
  for (const raw of content as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type === 'text' && typeof raw.text === 'string') chars += raw.text.length;
    else if (raw.type === 'tool_result') chars += toolResultText(raw).length + 20;
    else if (raw.type === 'tool_use') chars += JSON.stringify(raw.input ?? {}).length + String(raw.name ?? '').length + 20;
    else if (raw.type === 'thinking' && typeof raw.thinking === 'string') chars += raw.thinking.length;
    else if (raw.type === 'image') images++;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export function estimateTokens(messages: readonly { content: unknown }[]): number {
  let total = 0;
  for (const message of messages) total += estimateContentTokens(message.content) + 4;
  return total;
}

/** Windows ≥ 512k compact at 50%; smaller windows at 75%. */
export function compactionThresholdRatio(windowTokens: number): number {
  return windowTokens >= 512_000 ? 0.5 : 0.75;
}

export interface CompactionTriggerInput {
  windowTokens: number;
  /** Provider-reported prompt tokens of the last request (preferred). */
  promptTokens?: number | null;
  /** Rough estimate of tokens added since that request (new tool results etc.). */
  addedTokensSincePrompt?: number;
  /** Used when promptTokens is unavailable. */
  estimatedTokens?: number;
}

export interface CompactionTriggerResult {
  compact: boolean;
  usedTokens: number;
  thresholdTokens: number;
  source: 'provider' | 'estimate';
}

export function evaluateCompactionTrigger(input: CompactionTriggerInput): CompactionTriggerResult {
  const thresholdTokens = Math.floor(Math.max(1, input.windowTokens) * compactionThresholdRatio(input.windowTokens));
  const hasReal = typeof input.promptTokens === 'number' && input.promptTokens > 0;
  const usedTokens = hasReal
    ? input.promptTokens! + Math.max(0, input.addedTokensSincePrompt ?? 0)
    : Math.max(0, input.estimatedTokens ?? 0);
  return { compact: usedTokens >= thresholdTokens, usedTokens, thresholdTokens, source: hasReal ? 'provider' : 'estimate' };
}

export function shouldCompact(input: CompactionTriggerInput): boolean {
  return evaluateCompactionTrigger(input).compact;
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

export function tailBudgetTokens(windowTokens: number): number {
  return Math.min(TAIL_MAX_TOKENS, Math.max(TAIL_MIN_TOKENS, Math.floor(windowTokens * TAIL_WINDOW_RATIO)));
}

function hasToolUse(message: ReplayInputMessage | undefined): boolean {
  const blocks = message ? (Array.isArray(message.content) ? message.content : contentBlocks(message.content)) : null;
  return !!blocks?.some(block => (block as { type?: unknown }).type === 'tool_use');
}

function hasToolResult(message: ReplayInputMessage | undefined): boolean {
  const blocks = message ? (Array.isArray(message.content) ? message.content : contentBlocks(message.content)) : null;
  return !!blocks?.some(block => (block as { type?: unknown }).type === 'tool_result');
}

/** A cut at `index` (messages[index] starts the next segment) never splits a tool pair. */
export function isSafeCut(messages: readonly ReplayInputMessage[], index: number): boolean {
  if (index <= 0 || index >= messages.length) return true;
  return !hasToolUse(messages[index - 1]) && !hasToolResult(messages[index]);
}

export interface CompactionBoundaries {
  headEnd: number;
  tailStart: number;
  /** Tool results before this absolute index are stubbed in replay. */
  stubBefore: number;
}

/**
 * Compute head/tail boundaries. Returns null when there is nothing to compact
 * (the middle would be empty).
 */
export function computeBoundaries(
  messages: readonly ReplayInputMessage[],
  windowTokens: number,
  previous?: CompactionState | null,
): CompactionBoundaries | null {
  const n = messages.length;
  // Head: first 3 messages, never ending inside a tool pair. Kept stable once chosen.
  let headEnd: number;
  if (previous) {
    headEnd = previous.headEnd;
  } else {
    headEnd = Math.min(HEAD_MESSAGES, n);
    while (headEnd < n && !isSafeCut(messages, headEnd)) headEnd++;
    if (headEnd > HEAD_MESSAGES + 2) {
      // A long unanswered chain right at the start: fall back to a smaller safe head.
      headEnd = 0;
      for (let candidate = Math.min(HEAD_MESSAGES, n); candidate > 0; candidate--) {
        if (isSafeCut(messages, candidate)) { headEnd = candidate; break; }
      }
    }
  }
  const lowerBound = Math.max(headEnd, previous?.tailStart ?? headEnd);

  // Tail by budget: ≥ budget tokens and ≥ MIN_TAIL_MESSAGES messages.
  const budget = tailBudgetTokens(windowTokens);
  let budgetCut = n;
  let accumulated = 0;
  for (let index = n - 1; index >= 0; index--) {
    accumulated += estimateContentTokens(messages[index].content) + 4;
    budgetCut = index;
    if (accumulated >= budget && n - index >= MIN_TAIL_MESSAGES) break;
  }
  if (budgetCut <= lowerBound) return null;

  // Snap the tail start back to a genuine user message so the tail holds ≥ 1
  // user message and starts on a turn boundary.
  let tailStart = -1;
  for (let index = budgetCut; index > lowerBound; index--) {
    if (isGenuineHuman(messages[index]) && isSafeCut(messages, index)) { tailStart = index; break; }
  }
  if (tailStart < 0) {
    // One very long turn: no human boundary inside the compactable range. Cut
    // at the latest safe step boundary instead (the turn's user message is in
    // the head or quoted verbatim in the summary).
    for (let index = budgetCut; index > lowerBound; index--) {
      if (isSafeCut(messages, index)) { tailStart = index; break; }
    }
  }
  if (tailStart < 0 || tailStart <= lowerBound) return null;

  // Tool results between tailStart and the budget cut are stubbed (free pass)
  // when the snap pulled in more than the budget — never the newest budget.
  let stubBefore = Math.max(headEnd, budgetCut);
  while (stubBefore > tailStart && !isSafeCut(messages, stubBefore)) stubBefore--;
  return { headEnd, tailStart, stubBefore };
}

// ---------------------------------------------------------------------------
// Span analysis: quotes, anchors, actions, transcript
// ---------------------------------------------------------------------------

function blocksOf(message: ReplayInputMessage): Record<string, unknown>[] {
  if (Array.isArray(message.content)) return message.content as Record<string, unknown>[];
  if (message.messageKind === 'human_user') return [];
  return contentBlocks(message.content) ?? [];
}

function humanText(message: ReplayInputMessage): string | null {
  if (!isGenuineHuman(message)) return null;
  const view = classifySessionMessage(
    { role: message.role, content: message.content, messageKind: message.messageKind ?? null },
    { treatSubAgentSessionAsInternal: false },
  );
  return view.visibleText || (view.isHumanTurn ? '[image]' : null);
}

/** Genuine user messages of the span, verbatim, newest first, within the char budget. */
export function quoteUserMessages(
  span: readonly ReplayInputMessage[],
  previousQuotes: readonly string[] = [],
  maxChars = QUOTED_USER_CHARS,
): string[] {
  const newest: string[] = [];
  for (let index = span.length - 1; index >= 0; index--) {
    const text = humanText(span[index]);
    if (text) newest.push(text);
  }
  const out: string[] = [];
  let used = 0;
  for (const quote of [...newest, ...previousQuotes]) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    const value = quote.length > remaining ? `${quote.slice(0, remaining)}…[truncated]` : quote;
    out.push(value);
    used += quote.length;
  }
  return out;
}

function assistantVisibleText(blocks: Record<string, unknown>[], content: unknown): string {
  if (typeof content === 'string') return stripThinkTags(content).trim();
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => stripThinkTags(block.text as string).trim())
    .filter(Boolean)
    .join('\n');
}

/** Weight of prose and tool inputs relative to raw tool output when ranking anchors. */
const HIGH_SIGNAL_WEIGHT = 3;

/**
 * Text fragments (newest first) used for the anchor index. Reasoning is
 * excluded; user/assistant prose and tool-call inputs are weighted above raw
 * tool output so identifiers the conversation actually used rank first.
 */
export function anchorFragments(span: readonly ReplayInputMessage[]): AnchorFragment[] {
  const fragments: AnchorFragment[] = [];
  for (let index = span.length - 1; index >= 0; index--) {
    const message = span[index];
    const blocks = blocksOf(message);
    if (typeof message.content === 'string' && blocks.length === 0) {
      fragments.push({ text: message.content, weight: HIGH_SIGNAL_WEIGHT });
      continue;
    }
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') fragments.push({ text: block.text, weight: HIGH_SIGNAL_WEIGHT });
      else if (block.type === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? Object.values(block.input as Record<string, unknown>) : [];
        for (const value of input) {
          if (typeof value === 'string') fragments.push({ text: value, weight: HIGH_SIGNAL_WEIGHT });
          else if (value != null) fragments.push({ text: JSON.stringify(value), weight: HIGH_SIGNAL_WEIGHT });
        }
      } else if (block.type === 'tool_result') {
        fragments.push({ text: toolResultText(block).slice(0, 20_000), weight: 1 });
      }
    }
  }
  return fragments;
}

/**
 * The assistant's visible replies from the span (what the user actually
 * saw), newest first, each trimmed to `perReplyChars`, within `maxChars`.
 * Final replies carry the conclusions — counts, totals, chosen options — that
 * a structured summary tends to drop.
 */
export function quoteAssistantReplies(
  span: readonly ReplayInputMessage[],
  previous: readonly string[] = [],
  maxChars = ASSISTANT_REPLY_CHARS,
  perReplyChars = ASSISTANT_REPLY_EACH_CHARS,
): string[] {
  const newest: string[] = [];
  for (let index = span.length - 1; index >= 0; index--) {
    const message = span[index];
    if (message.role !== 'assistant') continue;
    const view = classifySessionMessage(
      { role: message.role, content: message.content, messageKind: message.messageKind ?? null },
      { treatSubAgentSessionAsInternal: false },
    );
    if (view.kind !== 'assistant_visible' || !view.visibleText) continue;
    newest.push(truncateMiddle(view.visibleText, perReplyChars));
  }
  const out: string[] = [];
  let used = 0;
  for (const reply of [...newest, ...previous]) {
    if (used + reply.length > maxChars) {
      if (out.length === 0) out.push(reply.slice(0, maxChars));
      break;
    }
    out.push(reply);
    used += reply.length;
  }
  return out;
}

export interface ToolAction {
  name: string;
  target: string;
  outcome: string;
  isError: boolean;
}

/** Tool calls of the span with their outcomes, oldest first (deterministic). */
export function collectToolActions(span: readonly ReplayInputMessage[]): ToolAction[] {
  const uses = new Map<string, ToolUseContent>();
  const actions: ToolAction[] = [];
  for (const message of span) {
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use') uses.set(String(block.id), block as unknown as ToolUseContent);
      if (block.type === 'tool_result') {
        const result = { ...(block as unknown as ToolResultContent), content: toolResultText(block) };
        const use = uses.get(result.tool_use_id);
        const stub = stubToolResult(use, result);
        const match = stub.match(/^\[([^\]]+)\]\s?(.*?)(?: → (.*?))? \(\d/);
        actions.push({
          name: use?.name ?? match?.[1] ?? 'tool',
          target: match?.[2] ?? '',
          outcome: match?.[3] ?? '',
          isError: result.is_error === true,
        });
      }
    }
  }
  return actions;
}

/**
 * Render the compacted span as a plain transcript for the summariser, fitting
 * `maxChars` by shrinking per-result budgets, then dropping the oldest lines.
 */
export function renderSpanTranscript(span: readonly ReplayInputMessage[], maxChars: number, offset = 0): string {
  const render = (perResult: number, perText: number): string[] => {
    const lines: string[] = [];
    const uses = new Map<string, ToolUseContent>();
    span.forEach((message, position) => {
      const n = offset + position;
      const blocks = blocksOf(message);
      if (message.role === 'user') {
        const human = humanText(message);
        if (human) { lines.push(`[#${n} USER]: ${truncateMiddle(human, Math.max(perText, 4_000))}`); return; }
        for (const block of blocks) {
          if (block.type !== 'tool_result') continue;
          const use = uses.get(String(block.tool_use_id));
          const text = toolResultText(block);
          const body = perResult <= 0
            ? stubToolResult(use, { type: 'tool_result', tool_use_id: String(block.tool_use_id), content: text, is_error: block.is_error === true })
            : truncateMiddle(text, perResult);
          lines.push(`[#${n} TOOL RESULT ${use?.name ?? 'tool'}${block.is_error ? ' ERROR' : ''}]: ${body}`);
        }
        if (typeof message.content === 'string' && blocks.length === 0 && message.content.trim()) {
          lines.push(`[#${n} NOTE]: ${truncateMiddle(message.content.trim(), 600)}`);
        }
        return;
      }
      const text = assistantVisibleText(blocks, message.content);
      if (text) lines.push(`[#${n} ASSISTANT]: ${truncateMiddle(text, perText)}`);
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        uses.set(String(block.id), block as unknown as ToolUseContent);
        let input = '';
        try { input = JSON.stringify(block.input ?? {}); } catch { input = '{}'; }
        lines.push(`[#${n} TOOL CALL ${String(block.name)}]: ${truncateMiddle(input, Math.max(300, Math.min(1_500, perText)))}`);
      }
    });
    return lines;
  };

  for (const [perResult, perText] of [[2_000, 3_000], [800, 1_500], [250, 800], [0, 500]] as const) {
    const lines = render(perResult, perText);
    const text = lines.join('\n');
    if (text.length <= maxChars) return text;
    if (perResult === 0) {
      // Keep the newest lines that fit.
      const kept: string[] = [];
      let used = 0;
      for (let index = lines.length - 1; index >= 0; index--) {
        if (used + lines[index].length + 1 > maxChars - 120) {
          kept.unshift(`[… ${index + 1} older transcript lines omitted — see anchors and quoted user messages]`);
          break;
        }
        kept.unshift(lines[index]);
        used += lines[index].length + 1;
      }
      return kept.join('\n');
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Summary call + deterministic fallback
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM = `You compact long agent conversations into a structured handoff summary for the same assistant, which will continue the conversation with only this summary plus the most recent messages.

Rules:
- Write exactly these markdown sections, in this order, each as "## <name>": ${SUMMARY_SECTIONS.join(', ')}.
- Completed Actions: a numbered list, one line each, formatted "N. ACTION target — outcome [tool]".
- Copy identifiers verbatim (paths, ids, URLs, commit hashes, numbers, names, amounts, dates). Never paraphrase an identifier.
- Record the user's stated preferences, constraints and decisions explicitly, with their exact values.
- Active State: what is in progress right now and the exact next step. Blocked: what is waiting on whom (write "None" if nothing).
- Be dense and factual. No preamble, no closing remarks. Write "None" for an empty section.`;

export function buildSummaryPrompt(transcript: string, previousSummary?: string | null): string {
  const parts: string[] = [];
  if (previousSummary?.trim()) {
    parts.push('PREVIOUS SUMMARY (of even earlier turns):', previousSummary.trim(), '');
    parts.push('NEW TURNS since that summary:', transcript, '');
    parts.push('Update the summary: merge the previous summary with the new turns and keep everything still relevant. Continue the Completed Actions numbering. Drop only what is clearly obsolete.');
  } else {
    parts.push('TURNS TO SUMMARISE:', transcript, '');
    parts.push('Write the summary now.');
  }
  return parts.join('\n');
}

function countSections(summary: string): number {
  return SUMMARY_SECTIONS.filter(section => new RegExp(`^#{1,4}\\s*\\**${section.replace(/[&]/g, '\\&')}`, 'im').test(summary)).length;
}

export function isValidSummary(summary: string): boolean {
  return summary.trim().length >= 80 && countSections(summary) >= 5;
}

async function callSummary(
  provider: LLMProvider,
  prompt: string,
  options: { timeoutMs: number; signal?: AbortSignal; sessionId?: string; maxTokens: number },
): Promise<string> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      provider.complete({
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens,
        temperature: 0.2,
        signal,
        purpose: 'compaction_summary',
        ...(options.sessionId && { traceSessionId: options.sessionId }),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`compaction summary timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }),
    ]);
    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    return stripThinkTags(text).trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function deterministicSummary(input: {
  span: readonly ReplayInputMessage[];
  previousSummary?: string | null;
  quotes: readonly string[];
  anchors: AnchorIndex;
}): string {
  const actions = collectToolActions(input.span);
  const latestGoal = input.quotes[0] ?? '(no user message in the compacted span)';
  const lines: string[] = [];
  lines.push('## Goal', `Latest compacted user request: ${truncateMiddle(latestGoal, 400)}`, '(Deterministic summary — the summary model was unavailable. Quoted user messages below are authoritative.)', '');
  lines.push('## Constraints & Preferences', 'See the quoted user messages below.', '');
  lines.push('## Completed Actions');
  const shown = actions.slice(-60);
  if (shown.length === 0) lines.push('None');
  const offset = actions.length - shown.length;
  shown.forEach((action, index) => {
    lines.push(`${offset + index + 1}. ${action.isError ? 'FAILED' : 'RAN'} ${action.target || action.name} — ${action.outcome || 'done'} [${action.name}]`);
  });
  lines.push('', '## Active State', 'Unknown from the deterministic pass; continue from the latest user message.', '');
  lines.push('## Blocked', 'Unknown.', '');
  lines.push('## Key Decisions', 'See the quoted user messages below.', '');
  lines.push('## Errors & Fixes');
  const errors = actions.filter(action => action.isError).slice(-15);
  if (errors.length === 0 && input.anchors.errors.length === 0) lines.push('None');
  for (const error of errors) lines.push(`- [${error.name}] ${error.target} — ${error.outcome}`);
  lines.push('', '## Relevant Files', input.anchors.files.length ? input.anchors.files.join(', ') : 'None', '');
  lines.push('## Critical Context');
  lines.push(input.previousSummary?.trim()
    ? `Summary of even earlier turns (from the previous compaction):\n${input.previousSummary.trim()}`
    : 'None');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderSummaryMessage(input: {
  summary: string;
  anchors: AnchorIndex;
  quotes: readonly string[];
  assistantReplies?: readonly string[];
  extraState?: string;
}): string {
  const parts: string[] = [COMPACTION_PREFIX, '', input.summary.trim()];
  const anchors = renderAnchors(input.anchors);
  if (anchors) parts.push('', '## Anchor Index (verbatim from the compacted turns)', anchors);
  if (input.quotes.length > 0) {
    parts.push('', '## User Messages (verbatim, newest first)');
    input.quotes.forEach((quote, index) => {
      parts.push(`<user_message n="${index + 1}">`, quote, '</user_message>');
    });
  }
  if (input.assistantReplies?.length) {
    parts.push('', '## Your Earlier Replies (verbatim excerpts, newest first)');
    input.assistantReplies.forEach((reply, index) => {
      parts.push(`<assistant_reply n="${index + 1}">`, reply, '</assistant_reply>');
    });
  }
  if (input.extraState?.trim()) parts.push('', '## Live State', input.extraState.trim());
  parts.push('', COMPACTION_SUFFIX);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export interface LeanCompactionInput {
  /** Full session transcript (absolute indices; same list replay uses). */
  messages: readonly ReplayInputMessage[];
  windowTokens: number;
  /** Main model used for the single summary call. Omit for deterministic only. */
  provider?: LLMProvider | null;
  previous?: CompactionState | null;
  /** Extra state appended to the summary (todo list, kernel variables). */
  extraState?: string | (() => string | undefined | null);
  summaryTimeoutMs?: number;
  /** Max chars of transcript sent to the summariser (default: ~50% of window, ≤ 400k). */
  summaryInputChars?: number;
  summaryMaxTokens?: number;
  signal?: AbortSignal;
  sessionId?: string;
  now?: number;
  onSummaryError?: (error: unknown) => void;
}

export interface LeanCompactionResult {
  state: CompactionState;
  /** Replay built from the new state. */
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  usedFallback: boolean;
  compactedMessageCount: number;
}

/** Returns null when there is nothing to compact. */
export async function leanCompact(input: LeanCompactionInput): Promise<LeanCompactionResult | null> {
  const messages = input.messages;
  const previous = compactionStateMatches(input.previous, messages) ? input.previous : null;
  const boundaries = computeBoundaries(messages, input.windowTokens, previous);
  if (!boundaries) return null;

  const before = buildReplayMessages(messages, { compactionState: previous });
  const spanStart = previous ? previous.tailStart : boundaries.headEnd;
  const span = messages.slice(spanStart, boundaries.tailStart);

  const quotes = quoteUserMessages(span, previous?.quotedUserMessages ?? []);
  const assistantReplies = quoteAssistantReplies(span, previous?.assistantReplies ?? []);
  const anchors = mergeAnchors(extractAnchors(anchorFragments(span)), previous?.anchors ?? emptyAnchors());

  let summary: string | null = null;
  let usedFallback = false;
  if (input.provider) {
    const maxChars = input.summaryInputChars
      ?? Math.min(400_000, Math.max(40_000, Math.floor(input.windowTokens * 0.5) * CHARS_PER_TOKEN));
    const transcript = renderSpanTranscript(span, maxChars, spanStart);
    try {
      const text = await callSummary(input.provider, buildSummaryPrompt(transcript, previous?.summary), {
        timeoutMs: input.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
        signal: input.signal,
        sessionId: input.sessionId,
        maxTokens: input.summaryMaxTokens ?? 4_096,
      });
      if (isValidSummary(text)) summary = text;
      else input.onSummaryError?.(new Error('summary missing required sections'));
    } catch (error) {
      input.onSummaryError?.(error);
    }
  }
  if (!summary) {
    usedFallback = true;
    summary = deterministicSummary({ span, previousSummary: previous?.summary, quotes, anchors });
  }

  const extraState = typeof input.extraState === 'function' ? input.extraState() ?? undefined : input.extraState;
  const summaryMessage = renderSummaryMessage({ summary, anchors, quotes, assistantReplies, extraState: extraState ?? undefined });

  // Keep roles alternating where possible: head normally ends on a user
  // message and the tail starts on one, so the summary sits between them as
  // an assistant message. Providers merge any remaining same-role neighbours.
  const headLast = boundaries.headEnd > 0 ? messages[boundaries.headEnd - 1].role : null;
  const summaryRole: Message['role'] = headLast === 'user' ? 'assistant' : 'user';

  const now = input.now ?? Date.now();
  const state: CompactionState = {
    version: 1,
    headEnd: boundaries.headEnd,
    tailStart: boundaries.tailStart,
    stubBefore: boundaries.stubBefore,
    boundaryFingerprint: messageFingerprint(messages[boundaries.tailStart - 1]),
    summaryRole,
    summary,
    anchors,
    quotedUserMessages: quotes,
    assistantReplies,
    ...(extraState ? { extraState } : {}),
    usedFallback,
    compactionCount: (previous?.compactionCount ?? 0) + 1,
    summaryMessage,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  const replay = buildReplayMessages(messages, { compactionState: state });
  return {
    state,
    messages: replay,
    tokensBefore: estimateTokens(before),
    tokensAfter: estimateTokens(replay),
    usedFallback,
    compactedMessageCount: boundaries.tailStart - spanStart,
  };
}

export interface PrepareContextInput {
  sessionId: string;
  /** Raw session messages (SessionManager session.messages or DB rows). */
  messages: readonly ReplayInputMessage[];
  windowTokens: number;
  provider?: LLMProvider | null;
  store: CompactionStore;
  /** Provider-reported prompt tokens from the previous request in this session. */
  promptTokens?: number | null;
  /** Raw message count at the time of that request (to estimate the delta). */
  promptTokensMessageCount?: number;
  /** System prompt + tool schema tokens (estimate) for the pure-estimate path. */
  overheadTokens?: number;
  extraState?: LeanCompactionInput['extraState'];
  summaryTimeoutMs?: number;
  signal?: AbortSignal;
  onSummaryError?: (error: unknown) => void;
}

export interface PrepareContextResult {
  messages: Message[];
  state: CompactionState | null;
  compacted: boolean;
  usedFallback: boolean;
  trigger: CompactionTriggerResult;
  tokensBefore?: number;
  tokensAfter?: number;
}

/**
 * One call per agent iteration: load the persisted compaction state, build
 * the replay, compact (and persist) when the trigger fires.
 */
export async function prepareContext(input: PrepareContextInput): Promise<PrepareContextResult> {
  const loaded = loadCompactionState(input.store, input.sessionId);
  const state = compactionStateMatches(loaded, input.messages) ? loaded : null;
  const replay = buildReplayMessages(input.messages, { compactionState: state });
  const added = typeof input.promptTokensMessageCount === 'number'
    ? estimateTokens(input.messages.slice(Math.max(0, input.promptTokensMessageCount)))
    : 0;
  const trigger = evaluateCompactionTrigger({
    windowTokens: input.windowTokens,
    promptTokens: input.promptTokens,
    addedTokensSincePrompt: added,
    estimatedTokens: estimateTokens(replay) + (input.overheadTokens ?? 0),
  });
  if (!trigger.compact) {
    return { messages: replay, state, compacted: false, usedFallback: false, trigger };
  }
  const result = await leanCompact({
    messages: input.messages,
    windowTokens: input.windowTokens,
    provider: input.provider,
    previous: state,
    extraState: input.extraState,
    summaryTimeoutMs: input.summaryTimeoutMs,
    signal: input.signal,
    sessionId: input.sessionId,
    onSummaryError: input.onSummaryError,
  });
  if (!result) return { messages: replay, state, compacted: false, usedFallback: false, trigger };
  saveCompactionState(input.store, input.sessionId, result.state);
  return {
    messages: result.messages,
    state: result.state,
    compacted: true,
    usedFallback: result.usedFallback,
    trigger,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  };
}

export { buildReplayMessages, latestHumanTurnIndex };
