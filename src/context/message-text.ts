/**
 * Small, dependency-free helpers for turning persisted/provider messages into
 * plain text. Shared by lean compaction (summariser input, anchors, stubs) and
 * the session_search FTS index (which is maintained from db.ts, so this module
 * must not import anything that imports the database).
 */

/** Max characters of a single tool result that is indexed for search. */
export const SEARCH_TOOL_OUTPUT_CHARS = 8_000;
/** Max characters indexed for one message overall. */
export const SEARCH_MESSAGE_CHARS = 16_000;

export type LooseBlock = Record<string, unknown>;

function isRecord(value: unknown): value is LooseBlock {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse stored content (string or JSON block array) into blocks, or null for plain text. */
export function contentBlocks(content: unknown): LooseBlock[] | null {
  if (Array.isArray(content)) return content.filter(isRecord);
  if (typeof content !== 'string' || !content.trimStart().startsWith('[')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : null;
  } catch {
    return null;
  }
}

function toolResultText(block: LooseBlock): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.75));
  const tail = Math.max(0, maxChars - head);
  return `${text.slice(0, head)}\n…[${text.length - maxChars} chars omitted]…\n${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * Text used for the session_search FTS index: visible text, tool calls as
 * `[tool name] {input}`, and tool output truncated to 8k chars. Reasoning
 * (`thinking`) is never indexed.
 */
export function searchableMessageText(content: unknown): string {
  const blocks = contentBlocks(content);
  if (!blocks) return typeof content === 'string' ? content.slice(0, SEARCH_MESSAGE_CHARS) : '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      let input = '';
      try { input = JSON.stringify(block.input ?? {}); } catch { input = ''; }
      parts.push(`[tool ${String(block.name ?? 'tool')}] ${input.slice(0, 2_000)}`);
    } else if (block.type === 'tool_result') {
      const text = toolResultText(block);
      parts.push(text.length > SEARCH_TOOL_OUTPUT_CHARS ? text.slice(0, SEARCH_TOOL_OUTPUT_CHARS) : text);
    } else if (block.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n').slice(0, SEARCH_MESSAGE_CHARS);
}

export { toolResultText };
