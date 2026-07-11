/**
 * Recent Chat Context — lightweight utility to retrieve recent conversation
 * history and format it for injection into sub-agent system prompts.
 *
 * Uses the database's synchronous session-message APIs. When a user ID is
 * supplied, the context is scoped to that user's sessions.
 */

import type { ScallopDatabase } from '../memory/db.js';
import { classifySessionMessage } from '../memory/session-message-view.js';

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
  /** Exact channel identities authorized to contribute to this state owner's context. */
  identityCandidates?: readonly string[];
}

const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_CHARS = 300;
const DEFAULT_STALENESS_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Extract text from a session message content field.
 * Content may be a plain string or a JSON-serialized ContentBlock[] array.
 */
/**
 * Retrieve recent chat messages and format them as a compact transcript
 * for injection into sub-agent system prompts.
 *
 * Returns null if no messages exist or the conversation is stale.
 */
export function getRecentChatContext(
  db: ScallopDatabase,
  userIdOrOptions?: string | RecentChatContextOptions,
  maybeOptions?: RecentChatContextOptions,
): RecentChatContext | null {
  const userId = typeof userIdOrOptions === 'string' ? userIdOrOptions : undefined;
  const options = typeof userIdOrOptions === 'string' ? maybeOptions : userIdOrOptions;
  const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = options?.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
  const stalenessMs = options?.stalenessMs ?? DEFAULT_STALENESS_MS;

  // Over-fetch because provider protocol rows (tool results/reasoning) are not
  // conversation turns and must not consume the context window.
  const rawLimit = Math.min(1_000, Math.max(maxMessages * 20, 100));
  const rawMessages = userId
    ? (options?.identityCandidates
        ? db.getRecentMessagesByUserId(userId, rawLimit, options.identityCandidates)
        : db.getRecentMessagesByUserId(userId, rawLimit))
    : db.getAllMessagesPaginated(rawLimit).messages;

  const messages = rawMessages
    .map(message => {
      const session = db.getSession?.(message.sessionId);
      return {
        message,
        archived: session?.archivedAt != null || session?.transcriptDeletedAt != null,
        view: classifySessionMessage(message, { sessionMetadata: session?.metadata }),
      };
    })
    .filter(({ view, archived }) => view.isHumanVisible && !archived)
    .slice(-maxMessages);

  if (messages.length === 0) return null;

  const lastMessage = messages[messages.length - 1].message;
  const lastMessageAt = lastMessage.createdAt;

  // Staleness guard
  if (Date.now() - lastMessageAt > stalenessMs) return null;

  const lines: string[] = [];
  for (const { view } of messages) {
    const role = view.isHumanTurn ? 'User' : 'Assistant';
    let text = view.visibleText;
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
