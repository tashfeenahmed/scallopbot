/**
 * Graduated Context Compaction Pipeline
 *
 * Inspired by Claude Code's layered, cheapest-first compaction: instead of a
 * single "summarize everything" step (which is slow and lossy) or a hard
 * "keep only the last 3 messages" cliff (which drops context abruptly), this
 * runs a sequence of shapers ordered from cheapest to most expensive. After
 * each stage it re-estimates token usage and STOPS as soon as the transcript
 * fits under the target budget — so cheap, lossless stages handle the common
 * case and the expensive LLM-summary stage only runs when truly needed.
 *
 * Stage order (cheapest → most expensive), mirroring the snip → microcompact
 * → collapse → summarize progression:
 *   1. dedupeToolOutputs   — collapse repeated identical tool outputs to a ref
 *   2. snipToolOutputs     — truncate oversized tool outputs to a byte cap
 *   3. dropOldThinking     — drop reasoning/thinking blocks from older turns
 *   4. pruneToolOutputs    — replace old tool-result bodies with a placeholder
 *   5. summarizeOldest     — LLM-summarize the oldest messages (needs provider)
 *
 * Stages 1-4 are pure and synchronous (no LLM, no network), so they are safe
 * to run proactively before every model call. Stage 5 is async and only runs
 * when a provider is supplied and the cheaper stages were not enough.
 */

import type { LLMProvider, Message, ContentBlock } from '../providers/types.js';
import { progressiveCompact, repairToolUsePairing } from './compaction.js';

const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a list of messages (rough: ~4 chars/token). */
export function estimateMessagesTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
      continue;
    }
    for (const block of msg.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length;
      else if (block.type === 'thinking') chars += (block as { thinking: string }).thinking.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Map over the older slice of messages (everything except the last `preserveLastN`). */
function mapOlder(
  messages: Message[],
  preserveLastN: number,
  fn: (msg: Message) => Message
): Message[] {
  if (messages.length <= preserveLastN) return messages;
  const cutoff = messages.length - preserveLastN;
  return messages.map((msg, idx) => (idx < cutoff ? fn(msg) : msg));
}

/**
 * Stage 1 — dedupeToolOutputs.
 * If the same tool_result content appears more than once, keep the first and
 * replace later copies with a short reference. Pure; never touches the most
 * recent `preserveLastN` messages.
 */
export function dedupeToolOutputs(messages: Message[], preserveLastN = 4, minChars = 100): Message[] {
  const seen = new Map<string, number>(); // content -> first occurrence ordinal
  let ordinal = 0;
  return mapOlder(messages, preserveLastN, (msg) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const body = block.content;
      if (body.length < minChars) return block;
      const prior = seen.get(body);
      if (prior !== undefined) {
        changed = true;
        return { ...block, content: `[Identical to earlier tool output #${prior}]` };
      }
      seen.set(body, ++ordinal);
      return block;
    });
    return changed ? { ...msg, content: content as ContentBlock[] } : msg;
  });
}

/**
 * Stage 2 — snipToolOutputs.
 * Truncate any tool_result body longer than `maxChars`, keeping a head slice
 * and noting how much was dropped. Pure; preserves recent messages intact.
 */
export function snipToolOutputs(messages: Message[], maxChars = 8000, preserveLastN = 4): Message[] {
  return mapOlder(messages, preserveLastN, (msg) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= maxChars) return block;
      changed = true;
      const head = block.content.slice(0, maxChars);
      const dropped = block.content.length - maxChars;
      return { ...block, content: `${head}\n[...snipped ${dropped} chars]` };
    });
    return changed ? { ...msg, content: content as ContentBlock[] } : msg;
  });
}

/**
 * Stage 3 — dropOldThinking.
 * Remove `thinking` blocks from older messages. Reasoning traces are large and
 * rarely needed once the turn that produced them is in the past. Pure.
 */
export function dropOldThinking(messages: Message[], preserveLastN = 4): Message[] {
  return mapOlder(messages, preserveLastN, (msg) => {
    if (typeof msg.content === 'string') return msg;
    const hasThinking = msg.content.some((b) => b.type === 'thinking');
    if (!hasThinking) return msg;
    const filtered = msg.content.filter((b) => b.type !== 'thinking');
    // Don't strip a message down to nothing — leave it untouched if filtering
    // would empty it (the persistence layer rejects empty assistant content).
    if (filtered.length === 0) return msg;
    return { ...msg, content: filtered as ContentBlock[] };
  });
}

/**
 * Stage 4 — pruneToolOutputs.
 * Replace tool_result bodies in older messages with a compact placeholder that
 * records the original size. Pure; preserves recent messages intact.
 */
export function pruneToolOutputs(messages: Message[], preserveLastN = 4, minChars = 200): Message[] {
  return mapOlder(messages, preserveLastN, (msg) => {
    if (typeof msg.content === 'string') return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= minChars) return block;
      if (block.content.startsWith('[pruned:')) return block;
      changed = true;
      return { ...block, content: `[pruned: ${block.content.length} chars]` };
    });
    return changed ? { ...msg, content: content as ContentBlock[] } : msg;
  });
}

export interface CompactionStageResult {
  messages: Message[];
  /** Names of stages that actually fired, in order. */
  stagesApplied: string[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** True if the result fits under the target budget. */
  fits: boolean;
}

export interface PipelineOptions {
  /** Token budget to get under. */
  targetTokens: number;
  /** Recent messages to always keep verbatim. Default 6. */
  preserveLastN?: number;
  /** Provider for the final LLM-summary stage. If omitted, that stage is skipped. */
  provider?: LLMProvider;
  /** Context window size passed to the summary stage. Default 128000. */
  contextWindowTokens?: number;
}

const SYNC_STAGES: Array<{ name: string; apply: (m: Message[], preserveLastN: number) => Message[] }> = [
  { name: 'dedupeToolOutputs', apply: (m, p) => dedupeToolOutputs(m, p) },
  { name: 'snipToolOutputs', apply: (m, p) => snipToolOutputs(m, undefined, p) },
  { name: 'dropOldThinking', apply: (m, p) => dropOldThinking(m, p) },
  { name: 'pruneToolOutputs', apply: (m, p) => pruneToolOutputs(m, p) },
];

/**
 * Run only the cheap, synchronous (non-LLM) stages, stopping as soon as the
 * transcript fits under `targetTokens`. Safe to call before every model turn.
 */
export function compactSync(messages: Message[], opts: PipelineOptions): CompactionStageResult {
  const preserveLastN = opts.preserveLastN ?? 6;
  const before = estimateMessagesTokens(messages);
  const stagesApplied: string[] = [];
  let current = messages;

  if (before <= opts.targetTokens) {
    return { messages, stagesApplied, estimatedTokensBefore: before, estimatedTokensAfter: before, fits: true };
  }

  for (const stage of SYNC_STAGES) {
    const next = stage.apply(current, preserveLastN);
    if (next !== current && estimateMessagesTokens(next) < estimateMessagesTokens(current)) {
      stagesApplied.push(stage.name);
      current = repairToolUsePairing(next);
    }
    if (estimateMessagesTokens(current) <= opts.targetTokens) break;
  }

  const after = estimateMessagesTokens(current);
  return {
    messages: current,
    stagesApplied,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
    fits: after <= opts.targetTokens,
  };
}

/**
 * Full graduated compaction: run the cheap synchronous stages first, then —
 * only if still over budget and a provider is available — escalate to the
 * expensive LLM-summary stage.
 */
export async function compact(messages: Message[], opts: PipelineOptions): Promise<CompactionStageResult> {
  const preserveLastN = opts.preserveLastN ?? 6;
  const syncResult = compactSync(messages, opts);

  if (syncResult.fits || !opts.provider) {
    return syncResult;
  }

  // Escalate to LLM summarization of the oldest messages.
  try {
    const summary = await progressiveCompact(
      syncResult.messages,
      opts.provider,
      opts.contextWindowTokens ?? 128000,
      { preserveLastN }
    );
    if (summary.summary) {
      const after = estimateMessagesTokens(summary.compactedMessages);
      return {
        messages: summary.compactedMessages,
        stagesApplied: [...syncResult.stagesApplied, 'summarizeOldest'],
        estimatedTokensBefore: syncResult.estimatedTokensBefore,
        estimatedTokensAfter: after,
        fits: after <= opts.targetTokens,
      };
    }
  } catch {
    // Summary failed — fall through with the sync result (best effort).
  }

  return syncResult;
}
