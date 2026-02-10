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
  source: 'inner_thoughts' | 'gap_scanner';
}

export interface ProactiveWebSocketOutput {
  type: 'proactive';
  content: string;
  category: string;
  urgency: 'low' | 'medium' | 'high';
  source: 'inner_thoughts' | 'gap_scanner';
}

// ============ Constants ============

/** Maximum message length before truncation (Telegram) */
const MAX_MESSAGE_LENGTH = 250;

/** Dismiss footer appended to Telegram messages */
const DISMISS_FOOTER = '\n\n_Reply to discuss, or ignore to dismiss._';

/** Icons for each gap type */
const GAP_TYPE_ICONS: Record<string, string> = {
  stale_goal: '\uD83C\uDFAF',            // 🎯
  approaching_deadline: '\u23F0',         // ⏰
  unresolved_thread: '\uD83D\uDCAC',     // 💬
  behavioral_anomaly: '\uD83D\uDCCA',    // 📊
};

/** Default icon when gap type is unknown */
const DEFAULT_ICON = '\uD83D\uDCA1';     // 💡

// ============ Functions ============

/**
 * Format a proactive message for Telegram.
 *
 * - Prepends a type-based icon
 * - Truncates message to 250 chars (appends "..." if truncated)
 * - Appends a dismiss footer
 * - Total output stays well under Telegram's 4096 char limit
 */
export function formatProactiveForTelegram(input: ProactiveFormatInput): string {
  const icon = GAP_TYPE_ICONS[input.gapType ?? ''] ?? DEFAULT_ICON;

  let message = input.message;
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH) + '...';
  }

  return `${icon} ${message}${DISMISS_FOOTER}`;
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
 */
export function formatProactiveMessage(
  channel: 'telegram' | 'api',
  input: ProactiveFormatInput,
): string | ProactiveWebSocketOutput {
  if (channel === 'telegram') {
    return formatProactiveForTelegram(input);
  }
  return formatProactiveForWebSocket(input);
}
