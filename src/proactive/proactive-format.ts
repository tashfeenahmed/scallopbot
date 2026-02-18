/**
 * Per-channel proactive message formatting.
 *
 * Pure functions that format proactive messages for different channels:
 * - Telegram: icon + truncated message + dismiss footer
 * - WebSocket (API): structured JSON object
 *
 * Decoupled from channel implementations — does NOT import from channels/.
 */

// ============ Types ============

export interface ProactiveFormatInput {
  message: string;
  gapType: string | undefined;
  urgency: 'low' | 'medium' | 'high';
  source: 'inner_thoughts' | 'gap_scanner' | 'task_result';
}

export interface ProactiveWebSocketOutput {
  type: 'proactive';
  content: string;
  category: string;
  urgency: 'low' | 'medium' | 'high';
  source: 'inner_thoughts' | 'gap_scanner' | 'task_result';
}

// ============ Functions ============

/**
 * Format a proactive message for Telegram.
 *
 * Passes through the message as-is — no icons, truncation, or footers.
 * The conversational tone is set at extraction time in the fact-extractor prompt.
 */
export function formatProactiveForTelegram(input: ProactiveFormatInput): string {
  return input.message;
}

/**
 * Format a proactive message for WebSocket (API) channel.
 *
 * Returns a structured object with type, content, category, urgency, and source.
 */
export function formatProactiveForWebSocket(input: ProactiveFormatInput): ProactiveWebSocketOutput {
  return {
    type: 'proactive',
    content: input.message,
    category: input.gapType || 'general',
    urgency: input.urgency,
    source: input.source,
  };
}

/**
 * Route proactive message formatting to the appropriate channel formatter.
 * Always returns a string — Telegram gets the message as-is,
 * WebSocket gets a JSON-serialized structured object.
 */
export function formatProactiveMessage(
  channel: 'telegram' | 'api',
  input: ProactiveFormatInput,
): string {
  if (channel === 'telegram') {
    return formatProactiveForTelegram(input);
  }
  return JSON.stringify(formatProactiveForWebSocket(input));
}
