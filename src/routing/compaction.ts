/**
 * Progressive Context Compaction
 *
 * Instead of jumping from "prune tool outputs" to "keep only 3 messages",
 * this module provides graduated compaction using LLM-based summarization
 * of older conversation chunks.
 */

import type { LLMProvider, Message, ContentBlock } from '../providers/types.js';

const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;
const SAFETY_MARGIN = 1.2;

/**
 * Compute an adaptive chunk ratio based on average message size vs context window.
 * Larger messages → smaller chunks to avoid overflowing the summarizer.
 */
export function computeAdaptiveChunkRatio(
  messages: Message[],
  contextWindowTokens: number
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalChars = messages.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + msg.content.length;
    return sum + (msg.content as ContentBlock[]).reduce((s, b) => {
      if (b.type === 'text') return s + b.text.length;
      if (b.type === 'tool_result') return s + b.content.length;
      return s;
    }, 0);
  }, 0);

  const avgCharsPerMessage = totalChars / messages.length;
  const avgTokensPerMessage = avgCharsPerMessage / 4; // rough estimate
  const messagesPerContext = contextWindowTokens / Math.max(avgTokensPerMessage, 1);

  // If messages are large, use smaller chunks
  if (messagesPerContext < 20) return MIN_CHUNK_RATIO;
  if (messagesPerContext < 50) return MIN_CHUNK_RATIO + (BASE_CHUNK_RATIO - MIN_CHUNK_RATIO) * 0.5;
  return BASE_CHUNK_RATIO;
}

/**
 * Split messages into chunks by approximate token budget.
 */
export function chunkMessagesByTokenBudget(
  messages: Message[],
  maxTokensPerChunk: number
): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateMessageTokens(msg);
    if (currentTokens + msgTokens > maxTokensPerChunk && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Estimate tokens for a single message.
 */
function estimateMessageTokens(msg: Message): number {
  let chars = 0;
  if (typeof msg.content === 'string') {
    chars = msg.content.length;
  } else {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Summarize a chunk of messages into a concise summary using an LLM.
 */
export async function summarizeChunk(
  messages: Message[],
  provider: LLMProvider,
  previousSummary?: string
): Promise<string> {
  const conversationText = messages.map(msg => {
    const role = msg.role;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else {
      text = (msg.content as ContentBlock[])
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n');
    }
    return `${role}: ${text.slice(0, 500)}`;
  }).join('\n');

  const prompt = previousSummary
    ? `Previous context summary:\n${previousSummary}\n\nNew conversation chunk:\n${conversationText}\n\nProvide a concise updated summary that preserves: decisions made, open questions, TODO items, constraints, key facts, and tool results. Be brief (2-4 sentences).`
    : `Conversation chunk:\n${conversationText}\n\nProvide a concise summary that preserves: decisions made, open questions, TODO items, constraints, key facts, and tool results. Be brief (2-4 sentences).`;

  try {
    const response = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a conversation summarizer. Produce concise, factual summaries that preserve actionable context. Never add information not in the original.',
      maxTokens: 512,
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n');

    return text || 'Unable to summarize this conversation chunk.';
  } catch {
    // Fallback: extract key sentences
    return fallbackSummary(messages);
  }
}

/**
 * Fallback summary when LLM is unavailable: extract first sentence of each message.
 */
function fallbackSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(0, 5)) {
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else {
      text = (msg.content as ContentBlock[])
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join(' ');
    }
    const firstSentence = text.split(/[.!?\n]/)[0]?.trim();
    if (firstSentence) parts.push(`${msg.role}: ${firstSentence.slice(0, 100)}`);
  }
  return parts.join('; ') || 'Previous conversation context (details unavailable).';
}

export interface CompactionOptions {
  /** Max fraction of context to use for history summary. Default: 0.3 */
  maxHistoryShare?: number;
  /** Number of recent messages to preserve intact. Default: 6 */
  preserveLastN?: number;
}

export interface CompactionResult {
  compactedMessages: Message[];
  summary: string;
}

/**
 * Main entry: progressively compact conversation history.
 *
 * Algorithm:
 * 1. Keep last N messages intact
 * 2. Split older messages into chunks
 * 3. Summarize each chunk sequentially (with continuity from previous summary)
 * 4. Return system message with merged summary + preserved recent messages
 */
export async function progressiveCompact(
  messages: Message[],
  provider: LLMProvider,
  contextWindowTokens: number,
  options?: CompactionOptions
): Promise<CompactionResult> {
  const { maxHistoryShare = 0.3, preserveLastN = 6 } = options || {};

  if (messages.length <= preserveLastN) {
    return { compactedMessages: messages, summary: '' };
  }

  // Split: older messages to summarize, recent messages to keep
  const olderMessages = messages.slice(0, messages.length - preserveLastN);
  const recentMessages = messages.slice(-preserveLastN);

  // Compute chunk size
  const chunkRatio = computeAdaptiveChunkRatio(olderMessages, contextWindowTokens);
  const maxChunkTokens = Math.floor(contextWindowTokens * chunkRatio);

  // Chunk the older messages
  const chunks = chunkMessagesByTokenBudget(olderMessages, maxChunkTokens);

  // Summarize each chunk sequentially for continuity
  let runningSum = '';
  for (const chunk of chunks) {
    try {
      runningSum = await summarizeChunk(chunk, provider, runningSum || undefined);
    } catch {
      runningSum += ' ' + fallbackSummary(chunk);
    }
  }

  // Trim summary to fit within history share
  const maxSummaryTokens = Math.floor(contextWindowTokens * maxHistoryShare);
  const maxSummaryChars = maxSummaryTokens * 4;
  if (runningSum.length > maxSummaryChars) {
    runningSum = runningSum.slice(0, maxSummaryChars) + '...';
  }

  // Build compacted messages
  const summaryMessage: Message = {
    role: 'user',
    content: `[Conversation summary (${olderMessages.length} earlier messages compacted):\n${runningSum}\n\nContinuing from recent messages:]`,
  };

  const compacted = repairToolUsePairing([summaryMessage, ...recentMessages]);

  return {
    compactedMessages: compacted,
    summary: runningSum,
  };
}

/**
 * Repair orphaned tool_result blocks after pruning.
 * If a user message contains tool_results whose tool_use_ids don't appear
 * in any preceding assistant message, remove those tool_results.
 */
export function repairToolUsePairing(messages: Message[]): Message[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && typeof msg.content !== 'string') {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') {
          toolUseIds.add((block as { id: string }).id);
        }
      }
    }
  }

  // Remove orphaned tool_results
  return messages.map(msg => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;

    const blocks = msg.content as ContentBlock[];
    const hasToolResults = blocks.some(b => b.type === 'tool_result');
    if (!hasToolResults) return msg;

    const filtered = blocks.filter(b => {
      if (b.type !== 'tool_result') return true;
      return toolUseIds.has((b as { tool_use_id: string }).tool_use_id);
    });

    // If all tool_results were orphaned, replace with a text note
    if (filtered.length === 0) {
      return { ...msg, content: '[Previous tool results omitted during context compaction]' };
    }

    return { ...msg, content: filtered as ContentBlock[] };
  });
}
