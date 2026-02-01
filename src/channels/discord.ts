/**
 * Discord Channel
 * Discord bot integration with slash commands and mentions
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type Message,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';

const MAX_MESSAGE_LENGTH = 2000;

export interface DiscordChannelOptions {
  botToken: string;
  applicationId?: string;
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
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
      description: 'Ask LeanBot a question',
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
  return `**LeanBot Help**

**Slash Commands:**
\`/ask <message>\` - Ask me a question
\`/reset\` - Clear your conversation history
\`/help\` - Show this help message
\`/status\` - Show session status

**Mentions:**
You can also mention me in a channel to chat!

**Direct Messages:**
Send me a DM to chat privately.
`;
}

export class DiscordChannel {
  private client: Client;
  private botToken: string;
  private applicationId?: string;
  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  public userSessions: Map<string, string> = new Map();
  private isRunning = false;
  private botUserId?: string;

  constructor(options: DiscordChannelOptions) {
    this.botToken = options.botToken;
    this.applicationId = options.applicationId;
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'discord' });

    // Create Discord client
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
    // Ready event
    this.client.once('ready', () => {
      this.botUserId = this.client.user?.id;
      this.logger.info(
        { username: this.client.user?.tag },
        'Discord bot connected'
      );
    });

    // Message event (for mentions and DMs)
    this.client.on('messageCreate', async (message: Message) => {
      await this.handleMessage(message);
    });

    // Slash command event
    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      }
    });

    // Error handler
    this.client.on('error', (error) => {
      this.logger.error({ error: error.message }, 'Discord client error');
    });
  }

  /**
   * Handle a message (mention or DM)
   */
  async handleMessage(message: Message): Promise<void> {
    // Ignore bots
    if (message.author.bot) {
      return;
    }

    // Check if this is a DM or a mention
    const isDM = !message.guild;
    const isMention =
      this.botUserId && message.mentions.has(this.botUserId);

    if (!isDM && !isMention) {
      return;
    }

    const userId = message.author.id;
    let content = message.content;

    // Remove mention from content
    if (isMention && this.botUserId) {
      content = content.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }

    if (!content) {
      await message.reply('Hello! How can I help you?');
      return;
    }

    this.logger.info(
      { userId, isDM, message: content.substring(0, 100) },
      'Received message'
    );

    try {
      // Show typing indicator
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 5000);

      // Get or create session
      const sessionId = await this.getOrCreateSession(userId);

      // Process through agent
      const result = await this.agent.processMessage(sessionId, content);

      clearInterval(typingInterval);

      // Format and send response
      const formatted = formatMarkdownForDiscord(result.response);
      const chunks = splitMessage(formatted);

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
      await message.reply('Sorry, I encountered an error. Please try again.');
    }
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

    try {
      switch (parsed.command) {
        case 'ask': {
          if (!parsed.message) {
            await interaction.reply('Please provide a message.');
            return;
          }

          await interaction.deferReply();

          const sessionId = await this.getOrCreateSession(userId);
          const result = await this.agent.processMessage(sessionId, parsed.message);

          const formatted = formatMarkdownForDiscord(result.response);
          const chunks = splitMessage(formatted);

          await interaction.editReply(chunks[0]);

          // Send additional chunks as follow-ups
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
          break;
        }

        case 'reset':
          await this.handleReset(userId);
          await interaction.reply('Conversation history cleared. Starting fresh!');
          break;

        case 'help':
          await interaction.reply(getHelpMessage());
          break;

        case 'status': {
          const sessionId = this.userSessions.get(userId);
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
        await interaction.editReply(errorMessage);
      } else {
        await interaction.reply(errorMessage);
      }
    }
  }

  /**
   * Get or create session for user
   */
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
      channelId: 'discord',
    });

    this.userSessions.set(userId, session.id);
    return session.id;
  }

  /**
   * Reset session for user
   */
  async handleReset(userId: string): Promise<void> {
    const sessionId = this.userSessions.get(userId);
    if (sessionId) {
      await this.sessionManager.deleteSession(sessionId);
      this.userSessions.delete(userId);
    }
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
   * Start the Discord bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.logger.info('Starting Discord bot...');

    await this.client.login(this.botToken);
    this.isRunning = true;

    // Register slash commands after login
    await this.registerCommands();
  }

  /**
   * Stop the Discord bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Discord bot...');
    await this.client.destroy();
    this.isRunning = false;
    this.logger.info('Discord bot stopped');
  }
}
