/**
 * Canonical classification and presentation helpers for persisted/provider
 * conversation messages.
 *
 * Provider protocols historically store tool results as `role: "user"` and
 * reasoning/tool calls as `role: "assistant"`.  Treating the role alone as
 * authorship pollutes the dashboard, summaries, behavioural analytics and
 * long-context replay.  This module is the single boundary that distinguishes
 * genuine conversation turns from provider protocol.
 */

import type { ContentBlock, Message } from '../providers/types.js';
import { stripThinkTags } from '../utils/output-safety.js';
import {
  inferSessionMessageKind,
  isInternalSessionMetadata,
  isPersistedSessionMessageKind,
  parseSessionContentBlocks,
  type PersistedSessionMessageKind,
} from './session-message-kinds.js';

export { isInternalSessionMetadata } from './session-message-kinds.js';

export type SessionMessageKind =
  | 'human'
  | 'assistant_visible'
  | 'tool_result'
  | 'assistant_protocol'
  | 'internal';

export interface SessionMessageLike {
  role: string;
  content: unknown;
  /** Durable semantics written separately from the provider-overloaded role. */
  messageKind?: PersistedSessionMessageKind | null;
}

export interface SessionMessageViewOptions {
  /** Session metadata is required to reject background/sub-agent transcripts. */
  sessionMetadata?: Record<string, unknown> | null;
  /** Set false only while replaying a sub-agent's own isolated session. */
  treatSubAgentSessionAsInternal?: boolean;
}

export interface ClassifiedSessionMessage {
  kind: SessionMessageKind;
  persistedKind: PersistedSessionMessageKind;
  /** Text that is safe to use as visible conversation context. */
  visibleText: string;
  isHumanTurn: boolean;
  isHumanVisible: boolean;
  hasToolUse: boolean;
  hasToolResult: boolean;
}

export interface CompactConversationOptions {
  /** Number of completed human turns retained before the current turn. */
  maxCompletedTurns?: number;
  /** Maximum visible characters retained per completed message. */
  maxVisibleCharsPerMessage?: number;
}

function visibleBlockText(blocks: Record<string, unknown>[], role: string, hasToolUse: boolean): string {
  if (role === 'assistant' && hasToolUse) return '';
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => role === 'assistant' ? stripThinkTags(block.text as string) : block.text as string)
    .map(text => text.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Classify a message by actual authorship/presentation semantics, not by the
 * overloaded provider role alone.
 */
export function classifySessionMessage(
  message: SessionMessageLike,
  options: SessionMessageViewOptions = {},
): ClassifiedSessionMessage {
  const internalSession = options.treatSubAgentSessionAsInternal !== false
    && isInternalSessionMetadata(options.sessionMetadata);
  const blocks = parseSessionContentBlocks(message.content);
  const hasToolUse = blocks?.some(block => block.type === 'tool_use') ?? false;
  const hasToolResult = blocks?.some(block => block.type === 'tool_result') ?? false;
  const explicitKind = isPersistedSessionMessageKind(message.messageKind)
    ? message.messageKind
    : null;
  const hasExplicitPersistedKind = explicitKind !== null;
  let persistedKind: PersistedSessionMessageKind = explicitKind
    ?? inferSessionMessageKind(message.role, message.content, options.sessionMetadata);
  if (persistedKind === 'worker_internal' && options.treatSubAgentSessionAsInternal === false) {
    persistedKind = inferSessionMessageKind(message.role, message.content, null);
  }

  if (internalSession || persistedKind === 'worker_internal' || persistedKind === 'system_internal') {
    return {
      kind: 'internal', persistedKind, visibleText: '', isHumanTurn: false,
      isHumanVisible: false, hasToolUse, hasToolResult,
    };
  }

  // Structural protocol markers are a defense-in-depth override for a
  // malformed or manually-written kind. A tool payload can never become
  // dashboard-visible merely because its kind column was incorrect.
  if (persistedKind === 'tool_result' || (!hasExplicitPersistedKind && hasToolResult)) {
    return {
      kind: 'tool_result', persistedKind: 'tool_result', visibleText: '', isHumanTurn: false,
      isHumanVisible: false, hasToolUse, hasToolResult: true,
    };
  }
  if (persistedKind === 'assistant_internal'
    || persistedKind === 'assistant_protocol'
    || (!hasExplicitPersistedKind && hasToolUse)) {
    return {
      kind: 'assistant_protocol', persistedKind, visibleText: '', isHumanTurn: false,
      isHumanVisible: false, hasToolUse, hasToolResult,
    };
  }

  if (persistedKind === 'human_user' && message.role === 'user') {
    const preserveLiteralProtocolShapedText = hasExplicitPersistedKind
      && typeof message.content === 'string'
      && (hasToolResult || hasToolUse);
    const visibleText = blocks && !preserveLiteralProtocolShapedText
      ? visibleBlockText(blocks, 'user', false)
      : (typeof message.content === 'string' ? message.content.trim() : '');
    const hasVisibleImage = blocks?.some(block => block.type === 'image') ?? false;
    if (!visibleText && !hasVisibleImage) {
      return {
        kind: 'internal', persistedKind, visibleText: '', isHumanTurn: false,
        isHumanVisible: false, hasToolUse, hasToolResult,
      };
    }
    return {
      kind: 'human', persistedKind, visibleText, isHumanTurn: true,
      isHumanVisible: true, hasToolUse, hasToolResult,
    };
  }

  if (persistedKind !== 'assistant_final' || message.role !== 'assistant') {
    return {
      kind: 'internal', persistedKind, visibleText: '', isHumanTurn: false,
      isHumanVisible: false, hasToolUse, hasToolResult,
    };
  }
  const visibleText = blocks
    ? visibleBlockText(blocks, 'assistant', hasToolUse)
    : (typeof message.content === 'string' ? stripThinkTags(message.content).trim() : '');
  if (!visibleText) {
    return {
      kind: 'assistant_protocol', persistedKind, visibleText: '', isHumanTurn: false,
      isHumanVisible: false, hasToolUse, hasToolResult,
    };
  }
  return {
    kind: 'assistant_visible', persistedKind, visibleText, isHumanTurn: false,
    isHumanVisible: true, hasToolUse, hasToolResult,
  };
}

/** Return visible text for a genuine human or final assistant turn, else null. */
export function getHumanVisibleText(
  message: SessionMessageLike,
  options: SessionMessageViewOptions = {},
): string | null {
  const view = classifySessionMessage(message, options);
  return view.isHumanVisible ? view.visibleText : null;
}

/** Filter a transcript to genuine human turns and final assistant replies. */
export function filterHumanVisibleTranscript<T extends SessionMessageLike>(
  messages: readonly T[],
  options: SessionMessageViewOptions = {},
): T[] {
  return messages.filter(message => classifySessionMessage(message, options).isHumanVisible);
}

function compactVisibleMessage(message: Message, maxChars: number): Message | null {
  const view = classifySessionMessage(message, { treatSubAgentSessionAsInternal: false });
  if (!view.isHumanVisible) return null;
  if (view.visibleText) {
    const text = view.visibleText.length > maxChars
      ? `${view.visibleText.slice(0, maxChars)}…`
      : view.visibleText;
    return { role: message.role, content: text };
  }

  // Image-only genuine human turns are small and semantically meaningful.
  const blocks = parseSessionContentBlocks(message.content);
  const images = blocks?.filter(block => block.type === 'image') as ContentBlock[] | undefined;
  return images?.length ? { role: message.role, content: images } : null;
}

/**
 * Remove tool/reasoning protocol from completed turns while keeping the latest
 * genuine human turn and every following message byte-for-byte.  Preserving
 * that suffix is important because it can contain the active tool call/result
 * chain required by providers.  This function does not mutate its input.
 */
export function compactCompletedConversationHistory(
  messages: readonly Message[],
  options: CompactConversationOptions = {},
): Message[] {
  const maxCompletedTurns = Math.max(0, options.maxCompletedTurns ?? 8);
  const maxChars = Math.max(100, options.maxVisibleCharsPerMessage ?? 2_000);
  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (classifySessionMessage(messages[index], { treatSubAgentSessionAsInternal: false }).isHumanTurn) {
      currentTurnStart = index;
      break;
    }
  }

  const completedEnd = currentTurnStart >= 0 ? currentTurnStart : messages.length;
  const completed: Message[] = [];
  let humanTurns = 0;
  for (let index = completedEnd - 1; index >= 0; index--) {
    const view = classifySessionMessage(messages[index], { treatSubAgentSessionAsInternal: false });
    if (!view.isHumanVisible) continue;
    if (view.isHumanTurn) {
      humanTurns++;
      if (humanTurns > maxCompletedTurns) break;
    }
    const compacted = compactVisibleMessage(messages[index], maxChars);
    if (compacted) completed.unshift(compacted);
  }
  while (completed[0]?.role === 'assistant') completed.shift();

  const activeSuffix = currentTurnStart >= 0 ? messages.slice(currentTurnStart) : [];
  return [...completed, ...activeSuffix];
}
