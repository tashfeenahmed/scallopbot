// Channel types and interfaces
export type {
  Channel,
  SendableChannel,
  VoiceChannel,
  BaseChannelConfig,
  IncomingMessage,
  OutgoingMessage,
  Attachment,
  ChannelStatus,
  ChannelFactory,
  ChannelRegistryEntry,
} from './types.js';

// Telegram
export {
  TelegramChannel,
  formatMarkdownToHtml,
  splitMessage,
  getStartMessage,
  type TelegramChannelOptions,
} from './telegram.js';

// CLI
export {
  CLIChannel,
  parseCommand,
  formatOutput,
  getHelpMessage as getCLIHelpMessage,
  getWelcomeMessage,
  type CLIChannelOptions,
  type CommandResult,
  type HandleResult,
} from './cli.js';

// Discord
export {
  DiscordChannel,
  formatMarkdownForDiscord,
  splitMessage as splitDiscordMessage,
  parseSlashCommand,
  buildSlashCommands,
  type DiscordChannelOptions,
  type ParsedSlashCommand,
  type SlashCommandDef,
} from './discord.js';

// WhatsApp
export { WhatsAppChannel, type WhatsAppChannelOptions } from './whatsapp.js';

// Slack
export { SlackChannel, type SlackChannelOptions } from './slack.js';

// Signal
export { SignalChannel, type SignalChannelOptions } from './signal.js';

// Matrix
export { MatrixChannel, type MatrixChannelOptions } from './matrix.js';

// API (REST/WebSocket)
export { ApiChannel, type ApiChannelConfig } from './api.js';

// Telegram Gateway (singleton for skill access)
export { TelegramGateway } from './telegram-gateway.js';
