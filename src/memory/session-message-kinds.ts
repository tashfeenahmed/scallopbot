/**
 * Durable message authorship/presentation semantics.
 *
 * Provider APIs overload `role: user` for tool results and `role: assistant`
 * for reasoning/tool-call protocol. Persisting this separate kind prevents a
 * later dashboard, summary, or analytics reader from having to guess again.
 * This module is intentionally dependency-free so both the database migration
 * and presentation layer can use it without a circular import.
 */

export const PERSISTED_SESSION_MESSAGE_KINDS = [
  'human_user',
  'assistant_final',
  'assistant_internal',
  'assistant_protocol',
  'tool_result',
  'worker_internal',
  'system_internal',
] as const;

export type PersistedSessionMessageKind = typeof PERSISTED_SESSION_MESSAGE_KINDS[number];

export function isPersistedSessionMessageKind(value: unknown): value is PersistedSessionMessageKind {
  return typeof value === 'string'
    && (PERSISTED_SESSION_MESSAGE_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseSessionContentBlocks(content: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(content)) return content.filter(isRecord);
  if (typeof content !== 'string' || !content.trimStart().startsWith('[')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : null;
  } catch {
    return null;
  }
}

/** True when a whole session is background protocol, not user conversation. */
export function isInternalSessionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata) return false;
  if (metadata.isSubAgent === true || metadata.internal === true || metadata.background === true) {
    return true;
  }
  const channelId = typeof metadata.channelId === 'string' ? metadata.channelId.toLowerCase() : '';
  const userId = typeof metadata.userId === 'string' ? metadata.userId.toLowerCase() : '';
  const source = typeof metadata.source === 'string' ? metadata.source.toLowerCase() : '';
  return channelId === 'subagent' || channelId === 'background'
    || userId.startsWith('subagent:') || userId.startsWith('background:')
    || source === 'scheduler' || source === 'worker' || source === 'gardener';
}

function isInternalControlText(text: string): boolean {
  return /^\s*\[(?:System:|Sub-agent\b|Previous conversation summary\b|Tool result\b)/i.test(text);
}

/**
 * Conservative fallback for legacy rows and the single write-time classifier
 * used by new rows. Explicit persisted kinds remain authoritative to readers;
 * this function is only needed when a row predates the column.
 */
export function inferSessionMessageKind(
  role: string,
  content: unknown,
  sessionMetadata?: Record<string, unknown> | null,
): PersistedSessionMessageKind {
  if (isInternalSessionMetadata(sessionMetadata)) return 'worker_internal';

  const blocks = parseSessionContentBlocks(content);
  const hasToolUse = blocks?.some(block => block.type === 'tool_use') ?? false;
  const hasToolResult = blocks?.some(block => block.type === 'tool_result') ?? false;
  const hasThinking = blocks?.some(block => block.type === 'thinking') ?? false;
  const hasVisibleBlock = blocks?.some(block => (
    block.type === 'image'
    || (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
  )) ?? false;

  if (hasToolResult) return 'tool_result';
  if (role === 'user') {
    const text = blocks
      ? blocks
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => String(block.text).trim())
          .filter(Boolean)
          .join('\n')
      : (typeof content === 'string' ? content.trim() : '');
    return text && isInternalControlText(text) ? 'system_internal' : 'human_user';
  }
  if (role === 'assistant') {
    if (hasToolUse) return 'assistant_protocol';
    if ((hasThinking && !hasVisibleBlock)
      || (typeof content === 'string' && /^\s*<think>[\s\S]*<\/think>\s*$/i.test(content))
      || (typeof content === 'string' && content.trim().length === 0)) {
      return 'assistant_internal';
    }
    return 'assistant_final';
  }
  return 'system_internal';
}
