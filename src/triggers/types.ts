/**
 * Trigger Source Interface
 *
 * Unified abstraction for sending messages/files to users across different channels.
 * Used for reminders, scheduled notifications, and proactive messaging.
 */

/**
 * TriggerSource represents a channel that can receive triggered messages.
 * Both TelegramChannel and ApiChannel implement this interface.
 */
export interface TriggerSource {
  /**
   * Send a text message to a user.
   * @param userId - The user identifier (format depends on channel)
   * @param message - The message content (may include markdown)
   * @returns true if message was sent successfully
   */
  sendMessage(userId: string, message: string): Promise<boolean>;

  /**
   * Send a file to a user.
   * @param userId - The user identifier
   * @param filePath - Path to the file to send
   * @param caption - Optional caption for the file
   * @returns true if file was sent successfully
   */
  sendFile(userId: string, filePath: string, caption?: string): Promise<boolean>;

  /**
   * Get the name of this trigger source for logging.
   * @returns Channel name (e.g., 'telegram', 'api')
   */
  getName(): string;
}

/**
 * Registry for active trigger sources.
 * Allows routing messages to the appropriate channel based on userId prefix.
 */
export type TriggerSourceRegistry = Map<string, TriggerSource>;

/**
 * Parse a prefixed userId to determine which trigger source to use.
 *
 * Format: "channel:userId" (e.g., "telegram:12345", "api:ws-abc123")
 * If no prefix, returns undefined for channel (use default routing).
 *
 * @param userId - The potentially prefixed user ID
 * @returns Object with channel name (or undefined) and the raw user ID
 */
export function parseUserIdPrefix(userId: string): { channel?: string; rawUserId: string } {
  const colonIndex = userId.indexOf(':');
  if (colonIndex > 0) {
    const channel = userId.substring(0, colonIndex);
    const rawUserId = userId.substring(colonIndex + 1);
    // Only recognize known channel prefixes
    if (channel === 'telegram' || channel === 'api') {
      return { channel, rawUserId };
    }
  }
  // No recognized prefix - return as-is
  return { rawUserId: userId };
}
