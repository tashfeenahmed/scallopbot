/**
 * Recent Chat Context — lightweight utility to retrieve recent conversation
 * history and format it for injection into sub-agent system prompts.
 *
 * Uses the existing db.getAllMessagesPaginated() API (synchronous, no new DB queries).
 */

import type { ScallopDatabase, SessionMessageRow } from '../memory/db.js';

export interface RecentChatContext {
  formattedContext: string;
  messageCount: number;
  lastMessageAt: number;
}

export interface RecentChatContextOptions {
  /** Maximum messages to retrieve (default: 10) */
  maxMessages?: number;
  /** Per-message character truncation limit (default: 300) */
  maxCharsPerMessage?: number;
  /** Staleness threshold in ms — returns null if last message is older (default: 48h) */
  stalenessMs?: number;
}

const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_CHARS = 300;
const DEFAULT_STALENESS_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Extract text from a session message content field.
 * Content may be a plain string or a JSON-serialized ContentBlock[] array.
 */
function extractText(content: string): string {
  if (!content) return '';
  // Try parsing as JSON ContentBlock[] (array of {type:'text', text:...})
  if (content.startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<{ type: string; text?: string }>;
      return blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('\n');
    } catch {
      // Not valid JSON — treat as plain text
    }
  }
  return content;
}

/**
 * Retrieve recent chat messages and format them as a compact transcript
 * for injection into sub-agent system prompts.
 *
 * Returns null if no messages exist or the conversation is stale.
 */
export function getRecentChatContext(
  db: ScallopDatabase,
  options?: RecentChatContextOptions,
): RecentChatContext | null {
  const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = options?.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
  const stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;

  const { messages } = db.getAllMessagesPaginated(maxMessages);

  if (messages.length === 0) return null;

  const lastMessage = messages[messages.length - 1];
  const lastMessageAt = lastMessage.createdAt;

  // Staleness guard
  if (Date.now() - lastMessageAt > stalenessMs) return null;

  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    let text = extractText(msg.content);
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '…';
    }
    // Collapse to single line for compactness
    text = text.replace(/\n+/g, ' ').trim();
    if (text) {
      lines.push(`${role}: ${text}`);
    }
  }

  if (lines.length === 0) return null;

  return {
    formattedContext: lines.join('\n'),
    messageCount: lines.length,
    lastMessageAt,
  };
}
