/**
 * Slack Channel using Bolt framework
 *
 * Uses @slack/bolt in Socket Mode (no public URL needed): a bot token
 * (xoxb-...) plus an app-level token (xapp-..., scope connections:write).
 *
 * Required Slack App setup:
 * - Socket Mode enabled
 * - Bot scopes: chat:write, app_mentions:read, im:history, im:read, im:write,
 *   files:write (for sending files)
 * - Event subscriptions: app_mention, message.im
 * - App Home: "Allow users to send Slash commands and messages from the messages tab"
 * - Optional slash command: /scallopbot
 *
 * Note: Requires optional dependency @slack/bolt
 */

import { basename } from 'path';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { ChannelStatus } from './types.js';
import { safeImport } from '../utils/dynamic-import.js';
import {
  ChannelSessions,
  KeyedSerialQueue,
  notifyUserMessage,
  renderAgentReply,
  soleEntry,
  splitText,
  type ChatUserMessageHook,
  type ProactiveChatChannel,
} from './chat-support.js';

// Slack rejects text over 40k chars; stay well under for readability.
const MAX_MESSAGE_LENGTH = 3900;

// Dynamic import for optional dependency
let App: any;
let LogLevel: any;

async function loadSlackDeps(): Promise<boolean> {
  try {
    // Use safe import utility with whitelist validation
    const bolt = await safeImport('@slack/bolt');
    if (!bolt) return false;
    App = bolt.App;
    LogLevel = bolt.LogLevel;
    return true;
  } catch {
    return false;
  }
}

export interface SlackChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  botToken: string;
  appToken?: string; // For socket mode
  signingSecret?: string; // For HTTP mode
  socketMode?: boolean;
  port?: number; // For HTTP mode
  /** Slack member IDs (U...) allowed to use the bot. Empty/undefined = allow all */
  allowedUsers?: string[];
  /** Rehydrates sessions after a restart */
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  onUserMessage?: ChatUserMessageHook;
}

type Say = (msg: string | Record<string, unknown>) => Promise<unknown>;

export class SlackChannel implements ProactiveChatChannel {
  public readonly name = 'slack';

  private agent: Agent;
  private logger: Logger;
  private app: any = null;
  private socketMode: boolean;
  private port: number;
  private botToken: string;
  private appToken?: string;
  private signingSecret?: string;
  private allowedUsers: Set<string> | null;
  private onUserMessage?: ChatUserMessageHook;

  private sessions: ChannelSessions;
  private turns = new KeyedSerialQueue();
  private running = false;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: SlackChannelOptions) {
    this.agent = options.agent;
    this.logger = options.logger.child({ channel: 'slack' });
    this.socketMode = options.socketMode ?? true;
    this.port = options.port ?? 3000;
    this.botToken = options.botToken;
    this.appToken = options.appToken;
    this.signingSecret = options.signingSecret;
    this.allowedUsers = options.allowedUsers?.length ? new Set(options.allowedUsers) : null;
    this.onUserMessage = options.onUserMessage;
    this.sessions = new ChannelSessions('slack', options.sessionManager, options.db);
  }

  isAllowedRecipient(userId: string): boolean {
    return !this.allowedUsers || this.allowedUsers.has(userId);
  }

  soleRecipient(): string | null {
    return soleEntry(this.allowedUsers);
  }

  private setupEventHandlers(): void {
    // Direct messages only. Channel messages reach us as app_mention below;
    // handling them here too would answer every mention twice.
    this.app.message(async ({ message, say }: { message: any; say: Say }) => {
      await this.handleDirectMessage(message, say);
    });

    this.app.event('app_mention', async ({ event, say }: { event: any; say: Say }) => {
      await this.handleMention(event, say);
    });

    // Handle app home opened
    this.app.event('app_home_opened', async ({ event, client }: { event: any; client: any }) => {
      try {
        await client.views.publish({
          user_id: event.user,
          view: {
            type: 'home',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*Welcome to ScallopBot!* :robot_face:\n\nI\'m your AI assistant. You can chat with me directly or mention me in any channel.',
                },
              },
              { type: 'divider' },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*Commands (in a DM):*\n• `reset` - Preserve this conversation and start a new one\n• `help` - Show this help message\n• `status` - Check bot status',
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error({ error }, 'Failed to publish app home');
      }
    });

    // Optional slash command (must also be created in the Slack app config)
    this.app.command('/scallopbot', async ({ command, ack, respond }: { command: any; ack: any; respond: any }) => {
      await ack();

      if (!this.isAllowedRecipient(command.user_id)) {
        await respond('You are not allowed to use this bot.');
        return;
      }

      const subcommand = command.text.trim().split(' ')[0]?.toLowerCase();
      switch (subcommand) {
        case 'reset':
          await this.handleReset(command.user_id);
          await respond('Started a new conversation. Your previous conversation is preserved.');
          break;

        case 'status':
          await respond(`Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`);
          break;

        default:
          await respond(this.helpText());
      }
    });
  }

  /** Exposed for tests: a Slack `message` event payload. */
  async handleDirectMessage(message: any, say: Say): Promise<void> {
    // Skip edits, joins, and anything posted by a bot (including ourselves).
    if (message.subtype || message.bot_id) return;
    if (message.channel_type !== 'im') return;
    if (!message.text || !message.user) return;

    const userId: string = message.user;
    if (!this.isAllowedRecipient(userId)) {
      this.logger.debug({ userId }, 'Ignoring message from user outside the Slack allowlist');
      return;
    }

    const text: string = message.text.trim();
    this.logger.info({ userId, message: text.substring(0, 100) }, 'Received message');

    // Slack swallows "/..." as slash commands, so DM commands are bare words.
    const command = text.replace(/^[/!]/, '').toLowerCase();
    if (command === 'help' || command === 'reset' || command === 'new' || command === 'status') {
      await this.handleCommand(command, userId, say);
      return;
    }

    await this.processMessage(text, userId, say);
  }

  /** Exposed for tests: a Slack `app_mention` event payload. */
  async handleMention(event: any, say: Say): Promise<void> {
    if (event.bot_id || !event.user) return;
    const userId: string = event.user;
    if (!this.isAllowedRecipient(userId)) {
      this.logger.debug({ userId }, 'Ignoring mention from user outside the Slack allowlist');
      return;
    }

    const text = String(event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!text) {
      await say('Hi! How can I help you? Just mention me with your question.');
      return;
    }

    this.logger.info({ userId, message: text.substring(0, 100), channelId: event.channel }, 'Received mention');
    await this.processMessage(text, userId, say);
  }

  private helpText(): string {
    return '*ScallopBot Help*\n\nIn a DM:\n• `help` - Show this message\n• `reset` - Preserve this conversation and start a new one\n• `status` - Check bot status\n\nOr just send me a message, or mention me in a channel.';
  }

  private async handleCommand(command: string, userId: string, say: Say): Promise<void> {
    switch (command) {
      case 'reset':
      case 'new':
        await this.handleReset(userId);
        await say('Started a new conversation. Your previous conversation is preserved.');
        break;
      case 'status':
        await say(`Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`);
        break;
      default:
        await say(this.helpText());
    }
  }

  private async processMessage(text: string, userId: string, say: Say): Promise<void> {
    await this.turns.run(userId, async () => {
      try {
        await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(userId), text, this.logger);
        const sessionId = await this.getOrCreateSession(userId);
        const result = await this.agent.processMessage(sessionId, text);

        for (const chunk of splitText(this.formatForSlack(renderAgentReply(result)), MAX_MESSAGE_LENGTH)) {
          await say(chunk);
        }

        this.logger.info(
          { userId, responseLength: result.response.length, tokens: result.tokenUsage },
          'Sent response'
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error({ userId, error: err.message }, 'Failed to process message');
        await say('Sorry, I encountered an error. Please try again.').catch(() => {});
      }
    });
  }

  private formatForSlack(text: string): string {
    // Slack uses its own markdown variant (mrkdwn)
    return text
      // Bold: **text** -> *text*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Links: [text](url) -> <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  }

  /**
   * Proactive message to a user. Posting with a user ID as the channel lands
   * in the bot's DM with that user.
   */
  async sendMessage(userId: string, message: string): Promise<MessageDeliveryResult> {
    if (!this.running || !this.app) {
      this.logger.warn({ userId }, 'Cannot send message - Slack not running');
      return false;
    }
    if (userId === 'default') {
      const sole = this.soleRecipient();
      if (!sole) return false;
      userId = sole;
    }
    if (!this.isAllowedRecipient(userId)) {
      this.logger.warn({ userId }, 'Refusing proactive delivery outside the Slack allowlist');
      return false;
    }

    try {
      const messageIds: string[] = [];
      for (const chunk of splitText(this.formatForSlack(message), MAX_MESSAGE_LENGTH)) {
        const res = await this.app.client.chat.postMessage({ channel: userId, text: chunk });
        if (res?.ts) messageIds.push(String(res.ts));
      }
      return { sent: true, channel: 'slack', messageIds };
    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  async sendFile(userId: string, filePath: string, caption?: string): Promise<boolean> {
    if (!this.running || !this.app || !this.isAllowedRecipient(userId)) return false;
    try {
      const dm = await this.app.client.conversations.open({ users: userId });
      await this.app.client.files.uploadV2({
        channel_id: dm.channel.id,
        file: filePath,
        filename: basename(filePath),
        initial_comment: caption,
      });
      return true;
    } catch (error) {
      this.logger.error({ userId, filePath, error: (error as Error).message }, 'Failed to send file');
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info(
      { socketMode: this.socketMode, port: this.socketMode ? undefined : this.port },
      'Starting Slack channel...'
    );

    try {
      // Load optional dependencies
      const depsLoaded = await loadSlackDeps();
      if (!depsLoaded) {
        this.status.error = 'Slack dependencies not installed. Run: npm install @slack/bolt';
        this.running = false;
        throw new Error(this.status.error);
      }

      // Initialize Bolt app
      this.app = new App({
        token: this.botToken,
        appToken: this.appToken,
        signingSecret: this.signingSecret,
        socketMode: this.socketMode,
        port: this.port,
        logLevel: LogLevel.INFO,
      });

      this.setupEventHandlers();

      await this.app.start();
      this.status.connected = true;
      this.status.authenticated = true;
      this.status.error = undefined;
      this.logger.info({ allowedUsers: this.allowedUsers?.size ?? 'all' }, 'Slack channel started');
    } catch (error) {
      const err = error as Error;
      this.status.error = err.message;
      this.running = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Slack channel...');
    this.running = false;

    await this.app?.stop();

    this.status.connected = false;
    this.logger.info('Slack channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): ChannelStatus {
    return { ...this.status, lastActivity: new Date() };
  }

  async getOrCreateSession(userId: string): Promise<string> {
    return this.sessions.get(userId);
  }

  async handleReset(userId: string): Promise<void> {
    await this.sessions.reset(userId);
  }
}
