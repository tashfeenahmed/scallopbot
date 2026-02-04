/**
 * Message Send Tool
 * Allows the agent to send text messages to the user immediately during execution.
 * This enables natural, human-like texting where the agent can send multiple
 * short messages instead of one long response.
 */

import type { Tool, ToolContext, ToolResult, ToolCategory } from './types.js';
import type { ToolDefinition } from '../providers/types.js';

export type MessageSendCallback = (userId: string, message: string) => Promise<boolean>;

// Global callback for sending messages
let messageSendCallback: MessageSendCallback | null = null;

/**
 * Initialize the message send tool with a callback
 */
export function initializeMessageSend(callback: MessageSendCallback): void {
  messageSendCallback = callback;
}

export class MessageSendTool implements Tool {
  name = 'send_message';
  category = 'comms' as ToolCategory;
  description = 'Send a text message to the user immediately. Use this to send messages one at a time, like texting. Call multiple times to send multiple messages.';

  definition: ToolDefinition = {
    name: 'send_message',
    description: 'Send a text message to the user right now. Use this for conversational, human-like messaging. ' +
      'You can call this multiple times to send multiple short messages instead of one long response. ' +
      'Great for: asking follow-up questions, giving updates, or having a natural back-and-forth.',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message text to send. Keep it short and conversational, like a text message.',
        },
      },
      required: ['message'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const message = input.message as string;

    if (!message || message.trim().length === 0) {
      return {
        success: false,
        output: 'Missing required parameter: message',
      };
    }

    if (!messageSendCallback) {
      return {
        success: false,
        output: 'Message sending not available - no channel configured',
      };
    }

    if (!context.userId) {
      return {
        success: false,
        output: 'Cannot send message - user ID not available',
      };
    }

    try {
      const success = await messageSendCallback(context.userId, message.trim());

      if (success) {
        return {
          success: true,
          output: 'Message sent',
        };
      } else {
        return {
          success: false,
          output: 'Failed to send message - check logs for details',
        };
      }
    } catch (error) {
      return {
        success: false,
        output: `Error sending message: ${(error as Error).message}`,
      };
    }
  }
}
