/**
 * Slack Channel using Bolt framework
 *
 * Uses @slack/bolt for Slack's Events API and Web API.
 * Supports both socket mode (no public URL needed) and HTTP mode.
 *
 * Required Slack App permissions:
 * - chat:write
 * - app_mentions:read
 * - im:history
 * - im:read
 * - im:write
 *
 * Note: Requires optional dependency @slack/bolt
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Channel, ChannelStatus } from './types.js';

// Dynamic import for optional dependency
let App: any;
let LogLevel: any;

async function loadSlackDeps(): Promise<boolean> {
  try {
    // Use eval to prevent TypeScript from trying to resolve the module
    const bolt = await (eval('import("@slack/bolt")') as Promise<any>);
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
}

export class SlackChannel implements Channel {
  public readonly name = 'slack';

  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private app: any = null;
  private socketMode: boolean;
  private port: number;
  private botToken: string;
  private appToken?: string;
  private signingSecret?: string;

  private userSessions: Map<string, string> = new Map();
  private running = false;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: SlackChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'slack' });
    this.socketMode = options.socketMode ?? true;
    this.port = options.port ?? 3000;
    this.botToken = options.botToken;
    this.appToken = options.appToken;
    this.signingSecret = options.signingSecret;
  }

  private setupEventHandlers(): void {
    // Handle direct messages
    this.app.message(async ({ message, say }: { message: any; say: any }) => {
      // Skip bot messages and message changes
      if (message.subtype) return;
      if (!('text' in message) || !message.text) return;
      if (!('user' in message) || !message.user) return;

      const userId = message.user;
      const text = message.text;
      const channelId = message.channel;

      this.logger.info(
        { userId, message: text.substring(0, 100), channelId },
        'Received message'
      );

      // Handle commands
      if (text.startsWith('/')) {
        await this.handleCommand(text, say);
        return;
      }

      // Process through agent
      await this.processMessage(text, userId, say);
    });

    // Handle app mentions in channels
    this.app.event('app_mention', async ({ event, say }: { event: any; say: any }) => {
      const userId = event.user;
      // Remove the bot mention from the text
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!text) {
        await say("Hi! How can I help you? Just mention me with your question.");
        return;
      }

      this.logger.info(
        { userId, message: text.substring(0, 100), channelId: event.channel },
        'Received mention'
      );

      await this.processMessage(text, userId, say);
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
                  text: '*Welcome to LeanBot!* :robot_face:\n\nI\'m your AI assistant. You can chat with me directly or mention me in any channel.',
                },
              },
              {
                type: 'divider',
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*Commands:*\n• `/reset` - Clear conversation history\n• `/help` - Show this help message\n• `/status` - Check bot status',
                },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*How to use:*\n1. Send me a direct message\n2. Or mention me in any channel: `@LeanBot your question`',
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error({ error }, 'Failed to publish app home');
      }
    });

    // Handle slash commands
    this.app.command('/leanbot', async ({ command, ack, respond }: { command: any; ack: any; respond: any }) => {
      await ack();

      const args = command.text.trim().split(' ');
      const subcommand = args[0]?.toLowerCase();

      switch (subcommand) {
        case 'reset':
          await this.handleReset(command.user_id);
          await respond('Conversation cleared. Starting fresh!');
          break;

        case 'status':
          await respond(
            `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
          );
          break;

        case 'help':
        default:
          await respond({
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: '*LeanBot Help*\n\n`/leanbot help` - Show this message\n`/leanbot reset` - Clear conversation history\n`/leanbot status` - Check bot status\n\nOr just send me a message!',
                },
              },
            ],
          });
      }
    });
  }

  private async handleCommand(
    text: string,
    say: (msg: string) => Promise<void>
  ): Promise<void> {
    const [command] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'help':
        await say(
          '*LeanBot Help*\n\n• `/help` - Show this message\n• `/reset` - Clear conversation history\n• `/status` - Check bot status\n\nOr just send me a message!'
        );
        break;

      case 'status':
        await say(
          `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
        );
        break;

      default:
        await say(
          `Unknown command: \`/${command}\`\nType \`/help\` for available commands.`
        );
    }
  }

  private async processMessage(
    text: string,
    userId: string,
    say: (msg: string | object) => Promise<void>
  ): Promise<void> {
    try {
      // Get or create session
      const sessionId = await this.getOrCreateSession(userId);

      // Process through agent
      const result = await this.agent.processMessage(sessionId, text);

      // Format response for Slack (convert markdown if needed)
      const response = this.formatForSlack(result.response);

      // Send response
      await say(response);

      this.logger.info(
        { userId, responseLength: result.response.length, tokens: result.tokenUsage },
        'Sent response'
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process message');
      await say('Sorry, I encountered an error. Please try again.');
    }
  }

  private formatForSlack(text: string): string {
    // Slack uses its own markdown variant (mrkdwn)
    // Convert common markdown to Slack format
    return text
      // Bold: **text** -> *text*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Italic: _text_ stays the same
      // Code blocks stay the same (```)
      // Inline code stays the same (`)
      // Links: [text](url) -> <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
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
      this.logger.info('Slack channel started');
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

    await this.app.stop();

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
    const cached = this.userSessions.get(userId);
    if (cached) {
      const session = await this.sessionManager.getSession(cached);
      if (session) {
        return cached;
      }
    }

    const session = await this.sessionManager.createSession({
      userId,
      channelId: 'slack',
    });

    this.userSessions.set(userId, session.id);
    return session.id;
  }

  async handleReset(userId: string): Promise<void> {
    const sessionId = this.userSessions.get(userId);
    if (sessionId) {
      await this.sessionManager.deleteSession(sessionId);
      this.userSessions.delete(userId);
    }
  }
}
