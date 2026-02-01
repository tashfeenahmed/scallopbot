export {
  TelegramChannel,
  formatMarkdownToHtml,
  splitMessage,
  getStartMessage,
  type TelegramChannelOptions,
} from './telegram.js';

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
