/**
 * Telegram Gateway Singleton
 *
 * Provides access to Telegram messaging from skill scripts.
 * Uses lazy singleton pattern matching BrowserSession.
 *
 * The singleton is wired to the TelegramChannel during Gateway initialization,
 * enabling skills running as subprocesses to send messages via the same bot instance.
 */

import type { TelegramChannel } from './telegram.js';

// Module-level singleton instance
let instance: TelegramGateway | null = null;

export class TelegramGateway {
  private channel: TelegramChannel | null = null;

  /**
   * Get or create the TelegramGateway instance
   */
  static getInstance(): TelegramGateway {
    if (!instance) {
      instance = new TelegramGateway();
    }
    return instance;
  }

  /**
   * Reset the singleton (for testing or cleanup)
   */
  static resetInstance(): void {
    if (instance) {
      instance.channel = null;
    }
    instance = null;
  }

  /**
   * Wire the gateway to an active TelegramChannel.
   * Called during Gateway initialization.
   */
  setChannel(channel: TelegramChannel): void {
    this.channel = channel;
  }

  /**
   * Check if the gateway is ready to send messages.
   */
  isAvailable(): boolean {
    return this.channel !== null;
  }

  /**
   * Send a text message to a Telegram chat.
   * @param chatId Telegram chat ID or user ID
   * @param message Message text (markdown supported)
   * @returns True if message sent successfully
   */
  async sendMessage(chatId: string | number, message: string): Promise<boolean> {
    if (!this.channel) {
      throw new Error('Telegram channel not initialized. Call setChannel() first.');
    }
    await this.channel.sendMessage(chatId, message);
    return true;
  }

  /**
   * Send a file to a Telegram chat.
   * @param chatId Telegram chat ID or user ID
   * @param filePath Path to the file to send
   * @param caption Optional caption for the file
   * @returns True if file sent successfully
   */
  async sendFile(chatId: string | number, filePath: string, caption?: string): Promise<boolean> {
    if (!this.channel) {
      throw new Error('Telegram channel not initialized. Call setChannel() first.');
    }
    return this.channel.sendFile(chatId, filePath, caption);
  }
}
