/**
 * Discord Channel
 * Discord bot integration with slash commands and mentions
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Message,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { basename } from 'path';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { ChannelStatus } from './types.js';
import {
  ChannelSessions,
  KeyedSerialQueue,
  notifyUserMessage,
  renderAgentReply,
  soleEntry,
  type ChatUserMessageHook,
  type ProactiveChatChannel,
} from './chat-support.js';

const MAX_MESSAGE_LENGTH = 2000;

export interface DiscordChannelOptions {
  botToken: string;
  applicationId?: string;
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  /** Discord user IDs allowed to use the bot. Empty/undefined = allow all */
  allowedUsers?: string[];
  /** Rehydrates sessions after a restart */
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  onUserMessage?: ChatUserMessageHook;
}

export interface ParsedSlashCommand {
  command: string;
  message: string | null;
}

export interface SlashCommandDef {
  name: string;
  description: string;
  options?: Array<{
    name: string;
    description: string;
    type: number;
    required?: boolean;
  }>;
}

/**
 * Format markdown for Discord (mostly compatible, but some adjustments)
 */
export function formatMarkdownForDiscord(text: string): string {
  // Discord supports most markdown natively
  // Just return as-is for now
  return text;
}

/**
 * Split long messages for Discord's 2000 char limit
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at code block boundary first
    let splitIndex = remaining.lastIndexOf('\n```', MAX_MESSAGE_LENGTH);
    if (splitIndex > 0 && splitIndex > MAX_MESSAGE_LENGTH - 500) {
      splitIndex += 1; // Include the newline
    } else {
      // Try paragraph boundary
      splitIndex = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    }

    // Try line boundary
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    }

    // Try space
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }

    // Force split
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

/**
 * Parse a slash command interaction
 */
export function parseSlashCommand(
  interaction: ChatInputCommandInteraction
): ParsedSlashCommand {
  return {
    command: interaction.commandName,
    message: interaction.options.getString('message'),
  };
}

/**
 * Build slash command definitions
 */
export function buildSlashCommands(): SlashCommandDef[] {
  return [
    {
      name: 'ask',
      description: 'Ask ScallopBot a question',
      options: [
        {
          name: 'message',
          description: 'Your question or request',
          type: 3, // STRING type
          required: true,
        },
      ],
    },
    {
      name: 'reset',
      description: 'Clear your conversation history',
    },
    {
      name: 'help',
      description: 'Show help information',
    },
    {
      name: 'status',
      description: 'Show current session status',
    },
  ];
}

/**
 * Get help message
 */
function getHelpMessage(): string {
  return `**ScallopBot Help**

**Slash Commands:**
\`/ask <message>\` - Ask me a question
\`/reset\` - Preserve this conversation and start a new one
\`/help\` - Show this help message
\`/status\` - Show session status

**Mentions:**
You can also mention me in a channel to chat!

**Direct Messages:**
Send me a DM to chat privately.
`;
}

export class DiscordChannel implements ProactiveChatChannel {
  public readonly name = 'discord';

  private client: Client;
  private botToken: string;
  private applicationId?: string;
  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private sessions: ChannelSessions;
  private turns = new KeyedSerialQueue();
  private allowedUsers: Set<string> | null;
  private onUserMessage?: ChatUserMessageHook;
  private running = false;
  private status: ChannelStatus = { connected: false, authenticated: false };

  constructor(options: DiscordChannelOptions) {
    this.botToken = options.botToken;
    this.applicationId = options.applicationId;
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'discord' });
    this.sessions = new ChannelSessions('discord', options.sessionManager, options.db);
    this.allowedUsers = options.allowedUsers?.length ? new Set(options.allowedUsers) : null;
    this.onUserMessage = options.onUserMessage;

    // MessageContent is a privileged intent: enable it for the bot in the
    // Discord developer portal or guild mentions arrive with empty content.
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.once(Events.ClientReady, () => {
      this.status = { connected: true, authenticated: true };
      this.logger.info(
        { username: this.client.user?.tag, allowedUsers: this.allowedUsers?.size ?? 'all' },
        'Discord bot connected'
      );
      // Application commands need the application ID, known once ready.
      void this.registerCommands();
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      await this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      }
    });

    this.client.on(Events.Error, (error) => {
      this.status.error = error.message;
      this.logger.error({ error: error.message }, 'Discord client error');
    });
  }

  isAllowedRecipient(userId: string): boolean {
    return !this.allowedUsers || this.allowedUsers.has(userId);
  }

  soleRecipient(): string | null {
    return soleEntry(this.allowedUsers);
  }

  /**
   * Handle a message (mention or DM)
   */
  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    const isDM = !message.guild;
    const botUserId = this.client.user?.id;
    const isMention = !!botUserId
      && message.mentions.has(botUserId, { ignoreEveryone: true, ignoreRoles: true });

    if (!isDM && !isMention) {
      return;
    }

    const userId = message.author.id;
    if (!this.isAllowedRecipient(userId)) {
      this.logger.debug({ userId }, 'Ignoring message from user outside the Discord allowlist');
      return;
    }

    let content = message.content;
    if (isMention && botUserId) {
      content = content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim();
    }

    if (!content) {
      await message.reply('Hello! How can I help you?');
      return;
    }

    this.logger.info(
      { userId, isDM, message: content.substring(0, 100) },
      'Received message'
    );

    await this.turns.run(userId, async () => {
      // Show typing indicator (only for channels that support it)
      const channel = message.channel;
      if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping().catch(() => {});
      }
      // Declared outside the try so the finally below can always clear it;
      // a throw from session/agent processing must not leave it running.
      const typingInterval = setInterval(() => {
        if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
          channel.sendTyping().catch(() => {});
        }
      }, 5000);

      try {
        await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(userId), content, this.logger);
        const sessionId = await this.getOrCreateSession(userId);
        const result = await this.agent.processMessage(sessionId, content);

        const chunks = splitMessage(formatMarkdownForDiscord(renderAgentReply(result))).filter(Boolean);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }

        this.logger.info(
          { userId, responseLength: result.response.length },
          'Sent response'
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error({ userId, error: err.message }, 'Failed to process message');
        await message.reply('Sorry, I encountered an error. Please try again.').catch(() => {});
      } finally {
        clearInterval(typingInterval);
      }
    });
  }

  /**
   * Handle a slash command
   */
  async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const parsed = parseSlashCommand(interaction);

    this.logger.info(
      { userId, command: parsed.command },
      'Received slash command'
    );

    if (!this.isAllowedRecipient(userId)) {
      await interaction.reply({ content: 'You are not allowed to use this bot.', ephemeral: true });
      return;
    }

    try {
      switch (parsed.command) {
        case 'ask': {
          const text = parsed.message;
          if (!text) {
            await interaction.reply('Please provide a message.');
            return;
          }

          await interaction.deferReply();

          await this.turns.run(userId, async () => {
            await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(userId), text, this.logger);
            const sessionId = await this.getOrCreateSession(userId);
            const result = await this.agent.processMessage(sessionId, text);

            const chunks = splitMessage(formatMarkdownForDiscord(renderAgentReply(result))).filter(Boolean);
            await interaction.editReply(chunks[0] ?? '(no response)');
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp(chunks[i]);
            }
          });
          break;
        }

        case 'reset':
          await this.handleReset(userId);
          await interaction.reply('Started a new conversation. Your previous conversation is preserved.');
          break;

        case 'help':
          await interaction.reply(getHelpMessage());
          break;

        case 'status': {
          const sessionId = this.sessions.peek(userId);
          if (sessionId) {
            const session = await this.sessionManager.getSession(sessionId);
            await interaction.reply(
              `Session ID: \`${sessionId}\`\nMessages: ${session?.messages?.length ?? 0}`
            );
          } else {
            await interaction.reply('No active session.');
          }
          break;
        }

        default:
          await interaction.reply('Unknown command.');
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        { userId, command: parsed.command, error: err.message },
        'Failed to handle slash command'
      );

      const errorMessage = 'Sorry, I encountered an error. Please try again.';
      if (interaction.deferred) {
        await interaction.editReply(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }

  /**
   * Get or create the session for a user (stored as `discord:<userId>`)
   */
  async getOrCreateSession(userId: string): Promise<string> {
    return this.sessions.get(userId);
  }

  /**
   * Preserve the current session and start a fresh one
   */
  async handleReset(userId: string): Promise<void> {
    await this.sessions.reset(userId);
  }

  /**
   * Register slash commands
   */
  async registerCommands(): Promise<void> {
    const appId = this.applicationId || this.client.application?.id;

    if (!appId) {
      this.logger.warn('No application ID available, skipping command registration');
      return;
    }

    const rest = new REST().setToken(this.botToken);
    const commands = buildSlashCommands().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      options: cmd.options,
    })) as RESTPostAPIChatInputApplicationCommandsJSONBody[];

    try {
      this.logger.info('Registering slash commands...');
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      this.logger.info('Slash commands registered');
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message },
        'Failed to register slash commands'
      );
    }
  }

  /**
   * Proactive message to a user's DMs (reminders, scheduled items).
   */
  async sendMessage(userId: string, message: string): Promise<MessageDeliveryResult> {
    if (!this.running) {
      this.logger.warn({ userId }, 'Cannot send message - Discord not running');
      return false;
    }
    if (userId === 'default') {
      const sole = this.soleRecipient();
      if (!sole) return false;
      userId = sole;
    }
    if (!this.isAllowedRecipient(userId)) {
      this.logger.warn({ userId }, 'Refusing proactive delivery outside the Discord allowlist');
      return false;
    }

    try {
      const user = await this.client.users.fetch(userId);
      const messageIds: string[] = [];
      for (const chunk of splitMessage(formatMarkdownForDiscord(message)).filter(Boolean)) {
        const sent = await user.send(chunk);
        messageIds.push(String(sent.id));
      }
      return { sent: true, channel: 'discord', messageIds };
    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  async sendFile(userId: string, filePath: string, caption?: string): Promise<boolean> {
    if (!this.running || !this.isAllowedRecipient(userId)) return false;
    try {
      const user = await this.client.users.fetch(userId);
      await user.send({
        content: caption ? caption.slice(0, MAX_MESSAGE_LENGTH) : undefined,
        files: [{ attachment: filePath, name: basename(filePath) }],
      });
      return true;
    } catch (error) {
      this.logger.error({ userId, filePath, error: (error as Error).message }, 'Failed to send file');
      return false;
    }
  }

  /**
   * Start the Discord bot. Slash commands register once the client is ready.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.logger.info('Starting Discord bot...');
    await this.client.login(this.botToken);
    this.running = true;
  }

  /**
   * Stop the Discord bot
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Discord bot...');
    await this.client.destroy();
    this.running = false;
    this.status.connected = false;
    this.logger.info('Discord bot stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }
}
