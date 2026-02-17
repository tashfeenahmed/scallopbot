import { Bot, Context, InputFile } from 'grammy';
import type { Logger } from 'pino';
import type { Agent, ProgressCallback } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { Attachment } from './types.js';
import { VoiceManager } from '../voice/index.js';
import { getPendingVoiceAttachments, cleanupVoiceAttachments } from '../voice/attachments.js';
import { BotConfigManager } from './bot-config.js';
import { resolveTimezone } from '../utils/country-timezone.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider } from '../providers/types.js';

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL = 5000; // 5 seconds
const MAX_QUEUE_SIZE = 10;

interface QueuedMessage {
  type: 'text' | 'voice' | 'document' | 'photo';
  execute: () => Promise<void>;
}

export interface TelegramChannelOptions {
  botToken: string;
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  workspacePath: string;
  db: ScallopDatabase;
  allowedUsers?: string[]; // Empty = allow all
  enableVoiceReply?: boolean;
  voiceManager?: VoiceManager; // Optional shared voice manager
  providerRegistry?: ProviderRegistry; // For /model command
  /** Called when a user sends a message (for engagement detection) */
  onUserMessage?: (prefixedUserId: string) => void;
}

export function formatMarkdownToHtml(text: string): string {
  // First escape HTML entities
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Convert code blocks first (before other formatting)
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre>${code.trim()}</pre>`;
  });

  // Convert inline code
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Convert bold (** or __)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Convert italic (* or _) - be careful not to match inside code blocks
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');

  return result;
}

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

    // Try to split at paragraph boundary
    let splitIndex = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);

    // If no paragraph, try line boundary
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    }

    // If no line boundary, try space
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }

    // Force split if no good boundary found
    if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
      splitIndex = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

export class TelegramChannel {
  private bot: Bot;
  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private configManager: BotConfigManager;
  private allowedUsers: Set<string>;
  public userSessions: Map<string, string> = new Map();
  private isRunning = false;
  private stopRequests: Set<string> = new Set(); // Track users who want to stop processing
  private activeProcessing: Set<string> = new Set(); // Track users with in-flight agent calls
  private userQueues: Map<string, QueuedMessage[]> = new Map(); // Per-user message queue
  private verboseUsers: Set<string> = new Set(); // Track users who want debug output
  private voiceManager: VoiceManager | null = null;
  private voiceAvailable = false;
  private enableVoiceReply: boolean;
  private workspacePath: string;
  private db: ScallopDatabase;
  private providerRegistry: ProviderRegistry | null = null;
  private onUserMessage?: (prefixedUserId: string) => void;
  // Buffer for collecting media group photos (multiple photos sent at once)
  private mediaGroupBuffer: Map<string, {
    photos: Array<{ buffer: Buffer; mimeType: string }>;
    caption?: string;
    userId: string;
    chatId: number;
    timer: NodeJS.Timeout;
  }> = new Map();

  constructor(options: TelegramChannelOptions) {
    this.bot = new Bot(options.botToken);
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'telegram' });
    this.configManager = new BotConfigManager(options.db);
    this.workspacePath = options.workspacePath;
    this.allowedUsers = new Set(options.allowedUsers || []);
    this.enableVoiceReply = options.enableVoiceReply ?? false;
    this.voiceManager = options.voiceManager || null;
    this.db = options.db;
    this.providerRegistry = options.providerRegistry || null;
    this.onUserMessage = options.onUserMessage;

    this.setupHandlers();
    this.initVoice();
  }

  private async initVoice(): Promise<void> {
    try {
      // Use provided voice manager or create new one
      if (!this.voiceManager) {
        this.voiceManager = VoiceManager.fromEnv(this.logger);
      }
      const status = await this.voiceManager.isAvailable();
      this.voiceAvailable = status.stt;

      if (this.enableVoiceReply && !status.tts) {
        this.logger.warn('TTS not available - voice replies will be disabled');
        this.enableVoiceReply = false;
      }

      if (this.voiceAvailable) {
        this.logger.info(
          { stt: status.stt, tts: status.tts, voiceReply: this.enableVoiceReply },
          'Voice support enabled for Telegram'
        );
      }
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Voice init failed');
      this.voiceAvailable = false;
      this.enableVoiceReply = false;
    }
  }

  /**
   * Check if a user is allowed to use the bot
   */
  private isUserAllowed(userId: string): boolean {
    // If no whitelist configured, allow everyone
    if (this.allowedUsers.size === 0) {
      return true;
    }
    return this.allowedUsers.has(userId);
  }

  /**
   * Send unauthorized message
   */
  private async sendUnauthorized(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString() || 'unknown';
    this.logger.warn({ userId }, 'Unauthorized access attempt');
    await ctx.reply(
      'Sorry, you are not authorized to use this bot.\n\n' +
      `Your user ID is: <code>${userId}</code>\n\n` +
      'Please contact the administrator to request access.',
      { parse_mode: 'HTML' }
    );
  }

  private setupHandlers(): void {
    // /start command - triggers onboarding or shows welcome
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleStart(ctx, userId);
    });

    // /new command - start a new chat
    this.bot.command('new', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleReset(userId);
      await ctx.reply('Starting a new conversation!');
    });

    // /settings command
    this.bot.command('settings', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleSettings(ctx, userId);
    });

    // /help command
    this.bot.command('help', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleHelp(ctx, userId);
    });

    // /setup command - restart onboarding
    this.bot.command('setup', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.configManager.resetUserConfig(userId);
      await this.handleStart(ctx, userId);
    });

    // /stop command - stop current processing
    this.bot.command('stop', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.stopRequests.add(userId);
      const wasActive = this.activeProcessing.has(userId);
      const queue = this.userQueues.get(userId);
      const queuedCount = queue?.length || 0;
      this.userQueues.delete(userId);

      if (wasActive) {
        const queueMsg = queuedCount > 0 ? ` Cleared ${queuedCount} queued message${queuedCount > 1 ? 's' : ''}.` : '';
        await ctx.reply(`Stopping current task...${queueMsg}`);
      } else {
        await ctx.reply('Nothing running right now.');
      }
      this.logger.info({ userId, wasActive, queuedCleared: queuedCount }, 'Stop requested by user');
    });

    // /verbose command - toggle debug output
    this.bot.command('verbose', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      if (this.verboseUsers.has(userId)) {
        this.verboseUsers.delete(userId);
        await ctx.reply('Verbose mode OFF');
      } else {
        this.verboseUsers.add(userId);
        await ctx.reply('Verbose mode ON — you\'ll see memory lookups, tool calls, and thinking.');
      }
    });

    // /usage command - show token usage and costs
    this.bot.command('usage', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleUsage(ctx);
    });

    // /model command - switch AI model/provider
    this.bot.command('model', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleModel(ctx, userId);
    });

    // Handle regular messages
    // NOTE: Handlers use fire-and-forget (no await) so Grammy's update loop
    // stays unblocked and can process /stop commands while the agent is running.
    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.handleMessage(ctx).catch((err) => {
        this.logger.error({ userId, error: (err as Error).message }, 'Unhandled error in message handler');
      });
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.handleVoiceMessage(ctx).catch((err) => {
        this.logger.error({ userId, error: (err as Error).message }, 'Unhandled error in voice handler');
      });
    });

    // Handle audio messages
    this.bot.on('message:audio', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.handleVoiceMessage(ctx).catch((err) => {
        this.logger.error({ userId, error: (err as Error).message }, 'Unhandled error in audio handler');
      });
    });

    // Handle document/file messages
    this.bot.on('message:document', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.handleDocumentMessage(ctx).catch((err) => {
        this.logger.error({ userId, error: (err as Error).message }, 'Unhandled error in document handler');
      });
    });

    // Handle photo messages
    this.bot.on('message:photo', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      this.handlePhotoMessage(ctx).catch((err) => {
        this.logger.error({ userId, error: (err as Error).message }, 'Unhandled error in photo handler');
      });
    });

    // Error handler
    this.bot.catch((err) => {
      this.logger.error({ error: err.message }, 'Bot error');
    });
  }

  /**
   * Handle /start command - show onboarding or welcome
   */
  private async handleStart(ctx: Context, userId: string): Promise<void> {
    const config = this.configManager.getUserConfig(userId);

    if (config.onboardingComplete) {
      // Already onboarded, show welcome
      const botName = config.botName;
      await ctx.reply(
        `Welcome back! I'm <b>${botName}</b>, your personal AI assistant.\n\n` +
        'How can I help you today?\n\n' +
        'Commands:\n' +
        '/help - Show all commands\n' +
        '/settings - View your settings\n' +
        '/setup - Reconfigure me\n' +
        '/new - Start new conversation',
        { parse_mode: 'HTML' }
      );
    } else {
      // Start onboarding
      await this.startOnboarding(ctx, userId);
    }
  }

  /**
   * Start the onboarding wizard
   */
  private async startOnboarding(ctx: Context, userId: string): Promise<void> {
    await this.configManager.updateUserConfig(userId, {
      onboardingStep: 'name',
      onboardingComplete: false,
    });

    await ctx.reply(
      "Welcome! Let's get you set up.\n\n" +
      "First, what would you like to call me? (e.g., Jarvis, Friday, Max, or any name you like)"
    );
  }

  /**
   * Handle /settings command
   */
  private async handleSettings(ctx: Context, userId: string): Promise<void> {
    const config = this.configManager.getUserConfig(userId);
    const personalityPreview = config.customPersonality
      ? config.customPersonality.substring(0, 100) + (config.customPersonality.length > 100 ? '...' : '')
      : 'Default';

    const modelLabel = config.modelId === 'auto'
      ? 'auto (smart routing)'
      : TelegramChannel.PROVIDER_LABELS[config.modelId] || config.modelId;

    await ctx.reply(
      '<b>Your Settings</b>\n\n' +
      `<b>Bot Name:</b> ${config.botName}\n` +
      `<b>Model:</b> ${modelLabel}\n` +
      `<b>Personality:</b> ${personalityPreview}\n` +
      `<b>Timezone:</b> ${config.timezone}\n\n` +
      'Use /setup to reconfigure, /model to switch AI provider.',
      { parse_mode: 'HTML' }
    );
  }

  /**
   * Handle /help command
   */
  private async handleHelp(ctx: Context, userId: string): Promise<void> {
    const config = this.configManager.getUserConfig(userId);
    const botName = config.botName;

    await ctx.reply(
      `<b>${botName} - Help</b>\n\n` +
      '<b>Commands:</b>\n' +
      '/start - Welcome message\n' +
      '/help - Show this help\n' +
      '/model - Switch AI model/provider\n' +
      '/usage - View token usage and costs\n' +
      '/settings - View your configuration\n' +
      '/setup - Reconfigure the bot\n' +
      '/new - Start new conversation history\n' +
      '/verbose - Toggle debug output\n\n' +
      '<b>What I can do:</b>\n' +
      '- Read and write files on the server\n' +
      '- Execute shell commands\n' +
      '- Answer questions and help with tasks\n' +
      '- Process voice messages (if enabled)\n' +
      '- Remember our conversation context\n\n' +
      'Just send me a message and I\'ll do my best to help!',
      { parse_mode: 'HTML' }
    );
  }

  /**
   * Handle /usage command - show token usage and costs
   */
  private async handleUsage(ctx: Context): Promise<void> {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // Get all usage records
    const allRecords = this.db.getCostUsageSince(0);
    const todayRecords = allRecords.filter(r => r.timestamp >= todayStart.getTime());
    const monthRecords = allRecords.filter(r => r.timestamp >= monthStart.getTime());

    // Calculate totals
    const todayTokens = todayRecords.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
    const todayCost = todayRecords.reduce((sum, r) => sum + r.cost, 0);
    const monthTokens = monthRecords.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
    const monthCost = monthRecords.reduce((sum, r) => sum + r.cost, 0);
    const totalTokens = allRecords.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
    const totalCost = allRecords.reduce((sum, r) => sum + r.cost, 0);

    // Get model breakdown for this month
    const modelUsage = new Map<string, { tokens: number; cost: number }>();
    for (const r of monthRecords) {
      const existing = modelUsage.get(r.model) || { tokens: 0, cost: 0 };
      existing.tokens += r.inputTokens + r.outputTokens;
      existing.cost += r.cost;
      modelUsage.set(r.model, existing);
    }

    // Format model breakdown
    let modelBreakdown = '';
    const sortedModels = [...modelUsage.entries()].sort((a, b) => b[1].cost - a[1].cost);
    for (const [model, usage] of sortedModels.slice(0, 5)) {
      const shortName = model.length > 20 ? model.substring(0, 18) + '..' : model;
      modelBreakdown += `  ${shortName}: ${this.formatTokens(usage.tokens)} ($${usage.cost.toFixed(4)})\n`;
    }

    const message =
      `<b>Usage Statistics</b>\n\n` +
      `<b>Today:</b>\n` +
      `  Tokens: ${this.formatTokens(todayTokens)}\n` +
      `  Cost: $${todayCost.toFixed(4)}\n\n` +
      `<b>This Month:</b>\n` +
      `  Tokens: ${this.formatTokens(monthTokens)}\n` +
      `  Cost: $${monthCost.toFixed(4)}\n\n` +
      `<b>All Time:</b>\n` +
      `  Tokens: ${this.formatTokens(totalTokens)}\n` +
      `  Cost: $${totalCost.toFixed(4)}\n` +
      `  Requests: ${allRecords.length.toLocaleString()}\n\n` +
      (modelBreakdown ? `<b>This Month by Model:</b>\n${modelBreakdown}` : '');

    await ctx.reply(message, { parse_mode: 'HTML' });
  }

  /** Display name for each provider */
  private static PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic (Claude)',
    openai: 'OpenAI (GPT)',
    groq: 'Groq',
    moonshot: 'Moonshot (Kimi)',
    xai: 'xAI (Grok)',
    ollama: 'Ollama (local)',
    openrouter: 'OpenRouter',
  };

  /**
   * Handle /model command — show or switch AI provider
   */
  private async handleModel(ctx: Context, userId: string): Promise<void> {
    if (!this.providerRegistry) {
      await ctx.reply('Model switching is not available.');
      return;
    }

    const config = this.configManager.getUserConfig(userId);
    // Filter out ollama (typically used for embeddings only, not chat)
    const available = this.providerRegistry.getAvailableProviders()
      .filter(p => p.name !== 'ollama');

    if (available.length === 0) {
      await ctx.reply('No AI providers are configured.');
      return;
    }

    // Check if user passed an argument: /model <name|number>
    const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim() || '';

    if (!args) {
      // Show current model and list available options
      const current = config.modelId === 'auto'
        ? 'auto (smart routing)'
        : TelegramChannel.PROVIDER_LABELS[config.modelId] || config.modelId;

      let list = '';
      available.forEach((p, i) => {
        const label = TelegramChannel.PROVIDER_LABELS[p.name] || p.name;
        const marker = config.modelId === p.name ? ' ✓' : '';
        list += `  <b>${i + 1}.</b> <code>${p.name}</code> — ${label}${marker}\n`;
      });
      const autoMarker = config.modelId === 'auto' ? ' ✓' : '';
      list += `  <b>${available.length + 1}.</b> <code>auto</code> — Smart routing (picks by complexity)${autoMarker}\n`;

      await ctx.reply(
        `<b>Current model:</b> ${current}\n\n` +
        `<b>Available:</b>\n${list}\n` +
        `Reply <code>/model &lt;number or name&gt;</code> to switch.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Parse selection — number or name
    let selectedName: string;
    const num = parseInt(args, 10);

    if (!isNaN(num) && num >= 1 && num <= available.length + 1) {
      // Numeric selection
      if (num === available.length + 1) {
        selectedName = 'auto';
      } else {
        selectedName = available[num - 1].name;
      }
    } else {
      // Name selection
      selectedName = args.toLowerCase();
    }

    // Validate
    if (selectedName !== 'auto' && !available.some(p => p.name === selectedName)) {
      await ctx.reply(
        `Unknown model "<code>${args}</code>". Use /model to see available options.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Save preference
    await this.configManager.updateUserConfig(userId, { modelId: selectedName });

    const label = selectedName === 'auto'
      ? 'auto (smart routing)'
      : TelegramChannel.PROVIDER_LABELS[selectedName] || selectedName;

    await ctx.reply(`Switched to <b>${label}</b>`, { parse_mode: 'HTML' });
    this.logger.info({ userId, model: selectedName }, 'User switched model');
  }

  /**
   * Resolve the user's model preference to a provider (or undefined for auto/router)
   */
  private getProviderForUser(userId: string): LLMProvider | undefined {
    if (!this.providerRegistry) return undefined;
    const config = this.configManager.getUserConfig(userId);
    if (config.modelId === 'auto') return undefined;
    return this.providerRegistry.getProvider(config.modelId);
  }

  /**
   * Format token count with K/M suffix
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      return (tokens / 1_000_000).toFixed(2) + 'M';
    } else if (tokens >= 1_000) {
      return (tokens / 1_000).toFixed(1) + 'K';
    }
    return tokens.toString();
  }

  /**
   * Handle onboarding flow responses
   */
  private async handleOnboardingResponse(ctx: Context, userId: string, message: string): Promise<boolean> {
    const config = this.configManager.getUserConfig(userId);

    if (config.onboardingComplete) {
      return false; // Not in onboarding
    }

    const step = config.onboardingStep || 'welcome';

    switch (step) {
      case 'name':
        return await this.handleNameStep(ctx, userId, message);

      case 'custom_personality':
        return await this.handleCustomPersonalityStep(ctx, userId, message);

      case 'timezone':
        return await this.handleTimezoneStep(ctx, userId, message);

      default:
        return false;
    }
  }

  private async handleNameStep(ctx: Context, userId: string, message: string): Promise<boolean> {
    const botName = message.trim().substring(0, 50); // Limit name length

    if (!botName) {
      await ctx.reply("Please enter a name for me (e.g., Jarvis, Friday, Max)");
      return true;
    }

    await this.configManager.updateUserConfig(userId, {
      botName,
      onboardingStep: 'custom_personality',
    });

    await ctx.reply(
      `Great! I'm now <b>${botName}</b>.\n\n` +
      "Now describe the personality you'd like me to have. For example:\n\n" +
      '<i>"Be a witty assistant who uses humor. Explain things simply and be encouraging."</i>\n\n' +
      '<i>"Be professional and concise. Focus on actionable answers."</i>\n\n' +
      '<i>"Be a creative and playful assistant. Use casual language."</i>\n\n' +
      "Write your own personality description:",
      { parse_mode: 'HTML' }
    );
    return true;
  }

  private async handleCustomPersonalityStep(ctx: Context, userId: string, message: string): Promise<boolean> {
    const customPrompt = message.trim();

    if (customPrompt.length < 10) {
      await ctx.reply("Please provide a more detailed description (at least 10 characters)");
      return true;
    }

    await this.configManager.updateUserConfig(userId, {
      personalityId: 'custom',
      customPersonality: customPrompt,
      onboardingStep: 'timezone',
    });

    await ctx.reply(
      "Personality set!\n\n" +
      "What country are you in? For example:\n\n" +
      "<code>Ireland</code>\n" +
      "<code>Japan</code>\n" +
      "<code>USA</code>\n" +
      "<code>Germany</code>\n\n" +
      "This ensures reminders and scheduled messages arrive at the right time.\n\n" +
      "<i>You can also enter an IANA timezone directly (e.g. Europe/Dublin).</i>",
      { parse_mode: 'HTML' }
    );
    return true;
  }

  private async handleTimezoneStep(ctx: Context, userId: string, message: string): Promise<boolean> {
    const result = resolveTimezone(message);

    if (!result) {
      await ctx.reply(
        "I couldn't recognise that country or timezone. Please enter your country name, e.g.:\n\n" +
        "<code>Ireland</code>\n" +
        "<code>Japan</code>\n" +
        "<code>USA</code>\n" +
        "<code>Germany</code>\n\n" +
        "Or an IANA timezone like <code>Europe/Dublin</code>",
        { parse_mode: 'HTML' }
      );
      return true;
    }

    await this.configManager.updateUserConfig(userId, {
      timezone: result.timezone,
      onboardingStep: 'complete',
      onboardingComplete: true,
    });

    const config = this.configManager.getUserConfig(userId);

    const countryNote = result.source === 'country'
      ? `\n<i>(Mapped from "${message.trim()}" → ${config.timezone})</i>\n`
      : '';

    await ctx.reply(
      `<b>Setup Complete!</b>\n\n` +
      `I'm now <b>${config.botName}</b>\n` +
      `Timezone: <b>${config.timezone}</b>${countryNote}\n\n` +
      `You can change these anytime with /setup\n\n` +
      `How can I help you today?`,
      { parse_mode: 'HTML' }
    );

    return true;
  }

  /**
   * Handle incoming voice messages
   */
  private async handleVoiceMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString();
    if (!userId) return;

    if (!this.voiceAvailable || !this.voiceManager) {
      await ctx.reply('Voice messages are not supported. Please send a text message.');
      return;
    }

    if (this.activeProcessing.has(userId)) {
      this.enqueue(userId, { type: 'voice', execute: () => this.processVoiceCore(ctx) });
      return;
    }

    this.activeProcessing.add(userId);
    try {
      await this.processVoiceCore(ctx);
    } finally {
      await this.drainQueue(userId);
    }
  }

  private async processVoiceCore(ctx: Context): Promise<void> {
    const userId = ctx.from!.id.toString();

    this.logger.info({ userId }, 'Received voice message');

    // Notify engagement detector (proactive feedback loop)
    if (this.onUserMessage) {
      this.onUserMessage(`telegram:${userId}`);
    }

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const voice = ctx.message?.voice || ctx.message?.audio;
      if (!voice) {
        throw new Error('No voice data in message');
      }

      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.status}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const transcription = await this.voiceManager!.transcribe(audioBuffer);

      if (!transcription.text.trim()) {
        clearInterval(typingInterval);
        await ctx.reply('Could not understand the audio. Please try again.');
        return;
      }

      // Process transcribed text as regular message (don't echo transcription back)
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = this.buildOnProgress(userId, ctx);

      const shouldStop = () => this.stopRequests.has(userId);
      const providerOverride = this.getProviderForUser(userId);
      const result = await this.agent.processMessage(sessionId, transcription.text, undefined, onProgress, shouldStop, providerOverride);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse).filter(c => c.trim());

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        }
      }

      // Voice replies are now contextual - the agent can use the voice_reply tool
      // when it determines a voice response is appropriate, rather than automatically
      // replying with voice just because the user sent a voice message.
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process voice message');
      await ctx.reply('Sorry, I had trouble processing your voice message. Please try again or send a text message.');
    }
  }

  /**
   * Handle incoming document/file messages
   */
  private async handleDocumentMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString();
    if (!userId) return;

    const document = ctx.message?.document;
    if (!document) return;

    if (this.activeProcessing.has(userId)) {
      this.enqueue(userId, { type: 'document', execute: () => this.processDocumentCore(ctx) });
      return;
    }

    this.activeProcessing.add(userId);
    try {
      await this.processDocumentCore(ctx);
    } finally {
      await this.drainQueue(userId);
    }
  }

  private async processDocumentCore(ctx: Context): Promise<void> {
    const userId = ctx.from!.id.toString();
    const document = ctx.message!.document!;

    this.logger.info({ userId, fileName: document.file_name, mimeType: document.mime_type }, 'Received document');

    // Notify engagement detector (proactive feedback loop)
    if (this.onUserMessage) {
      this.onUserMessage(`telegram:${userId}`);
    }

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      // Download the file
      const file = await ctx.api.getFile(document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`);
      }

      const fileBuffer = Buffer.from(await response.arrayBuffer());

      // Save to workspace
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');

      const receivedDir = join(this.workspacePath, 'received-files');
      await mkdir(receivedDir, { recursive: true });

      const timestamp = Date.now();
      const { basename } = await import('path');
      const safeName = basename(document.file_name || 'file').replace(/[^a-zA-Z0-9.-]/g, '_');
      const savedPath = join(receivedDir, `${timestamp}_${safeName}`);

      await writeFile(savedPath, fileBuffer);
      this.logger.debug({ savedPath }, 'Document saved');

      // Get caption or generate prompt
      const caption = ctx.message?.caption || '';
      const prompt = caption
        ? `The user sent a file (${document.file_name || 'document'}). Caption: "${caption}"\n\nFile saved at: ${savedPath}`
        : `The user sent a file (${document.file_name || 'document'}).\n\nFile saved at: ${savedPath}\n\nAnalyze this file and summarize what it contains.`;

      // Process through agent with attachment info
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = this.buildOnProgress(userId, ctx);

      const shouldStop = () => this.stopRequests.has(userId);
      const providerOverride = this.getProviderForUser(userId);
      const result = await this.agent.processMessage(sessionId, prompt, undefined, onProgress, shouldStop, providerOverride);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse).filter(c => c.trim());

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        }
      }

      this.logger.info({ userId, fileName: document.file_name }, 'Processed document message');
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process document');
      await ctx.reply('Sorry, I had trouble processing that file. Please try again.');
    }
  }

  /**
   * Handle incoming photo messages
   * Supports single photos and media groups (multiple photos sent together)
   */
  private async handlePhotoMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Get the largest photo (last in array)
    const photo = photos[photos.length - 1];
    const mediaGroupId = ctx.message?.media_group_id;
    const caption = ctx.message?.caption || '';

    this.logger.info({ userId, width: photo.width, height: photo.height, mediaGroupId }, 'Received photo');

    // Notify engagement detector (proactive feedback loop)
    if (this.onUserMessage) {
      this.onUserMessage(`telegram:${userId}`);
    }

    try {
      // Download the photo
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status}`);
      }

      const photoBuffer = Buffer.from(await response.arrayBuffer());
      const ext = file.file_path?.split('.').pop() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';

      // If part of a media group, buffer it
      if (mediaGroupId) {
        const existing = this.mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          // Add to existing buffer
          existing.photos.push({ buffer: photoBuffer, mimeType });
          if (caption && !existing.caption) {
            existing.caption = caption;
          }
        } else {
          // Create new buffer with a timer to process after delay
          const timer = setTimeout(() => {
            this.processMediaGroup(mediaGroupId, ctx);
          }, 500); // Wait 500ms for more photos in the group

          this.mediaGroupBuffer.set(mediaGroupId, {
            photos: [{ buffer: photoBuffer, mimeType }],
            caption: caption || undefined,
            userId,
            chatId,
            timer,
          });
        }
        return; // Wait for more photos or timer
      }

      // Single photo - process immediately
      await this.processPhotos(ctx, userId, [{ buffer: photoBuffer, mimeType }], caption);

    } catch (error) {
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process photo');
      await ctx.reply('Sorry, I had trouble processing that photo. Please try again.');
    }
  }

  /**
   * Process a media group (multiple photos sent together)
   */
  private async processMediaGroup(mediaGroupId: string, ctx: Context): Promise<void> {
    const group = this.mediaGroupBuffer.get(mediaGroupId);
    if (!group) return;

    // Clean up
    clearTimeout(group.timer);
    this.mediaGroupBuffer.delete(mediaGroupId);

    this.logger.info({ mediaGroupId, photoCount: group.photos.length }, 'Processing media group');

    await this.processPhotos(ctx, group.userId, group.photos, group.caption);
  }

  /**
   * Process one or more photos and send to agent
   */
  private async processPhotos(
    ctx: Context,
    userId: string,
    photos: Array<{ buffer: Buffer; mimeType: string }>,
    caption?: string
  ): Promise<void> {
    if (this.activeProcessing.has(userId)) {
      this.enqueue(userId, { type: 'photo', execute: () => this.processPhotosCore(ctx, userId, photos, caption) });
      return;
    }

    this.activeProcessing.add(userId);
    try {
      await this.processPhotosCore(ctx, userId, photos, caption);
    } finally {
      await this.drainQueue(userId);
    }
  }

  private async processPhotosCore(
    ctx: Context,
    userId: string,
    photos: Array<{ buffer: Buffer; mimeType: string }>,
    caption?: string
  ): Promise<void> {
    const typingInterval = this.startTypingIndicator(ctx);

    try {
      // Create attachments for all photos
      const attachments: Attachment[] = photos.map((photo, index) => ({
        type: 'image' as const,
        data: photo.buffer,
        mimeType: photo.mimeType,
        filename: `photo_${index + 1}.${photo.mimeType.split('/')[1] || 'jpg'}`,
        size: photo.buffer.length,
      }));

      // Build prompt
      const photoCount = photos.length;
      const photoWord = photoCount === 1 ? 'photo' : `${photoCount} photos`;
      const prompt = caption
        ? `The user sent ${photoWord}. Caption: "${caption}"`
        : `The user sent ${photoWord}. Describe what you see.`;

      // Process through agent WITH attachments
      const sessionId = await this.getOrCreateSession(userId);

      const onProgress = this.buildOnProgress(userId, ctx);
      const shouldStop = () => this.stopRequests.has(userId);
      const providerOverride = this.getProviderForUser(userId);

      const result = await this.agent.processMessage(sessionId, prompt, attachments, onProgress, shouldStop, providerOverride);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse).filter(c => c.trim());

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        }
      }

      this.logger.info({ userId, photoCount }, 'Processed photo message with vision');
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process photos');
      await ctx.reply('Sorry, I had trouble processing that photo. Please try again.');
    }
  }

  /**
   * Enqueue a message for a user. Returns the queue position (1-based) or -1 if full.
   */
  private enqueue(userId: string, msg: QueuedMessage): number {
    let queue = this.userQueues.get(userId);
    if (!queue) {
      queue = [];
      this.userQueues.set(userId, queue);
    }
    if (queue.length >= MAX_QUEUE_SIZE) {
      this.logger.warn({ userId, queueSize: queue.length }, 'Message queue full, dropping message');
      return -1;
    }
    queue.push(msg);
    this.logger.debug({ userId, type: msg.type, queueSize: queue.length }, 'Message queued');
    return queue.length;
  }

  /**
   * Drain queued messages for a user sequentially, then release the processing lock.
   */
  private async drainQueue(userId: string): Promise<void> {
    try {
      while (true) {
        if (this.stopRequests.has(userId)) {
          this.userQueues.delete(userId);
          break;
        }
        const queue = this.userQueues.get(userId);
        if (!queue || queue.length === 0) break;

        const next = queue.shift()!;
        if (queue.length === 0) this.userQueues.delete(userId);

        try {
          await next.execute();
        } catch (error) {
          this.logger.error({ userId, type: next.type, error: (error as Error).message }, 'Queued message processing failed');
        }
      }
    } finally {
      this.activeProcessing.delete(userId);
    }
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString();
    const messageText = ctx.message?.text;

    if (!userId || !messageText) {
      return;
    }

    // Check if in onboarding flow
    const handled = await this.handleOnboardingResponse(ctx, userId, messageText);
    if (handled) {
      return;
    }

    if (this.activeProcessing.has(userId)) {
      this.enqueue(userId, { type: 'text', execute: () => this.processTextCore(ctx) });
      return;
    }

    this.activeProcessing.add(userId);
    try {
      await this.processTextCore(ctx);
    } finally {
      await this.drainQueue(userId);
    }
  }

  private async processTextCore(ctx: Context): Promise<void> {
    const userId = ctx.from!.id.toString();
    const messageText = ctx.message!.text!;

    // Extract reply context if user is replying to a previous message
    const fullMessage = this.buildMessageWithReplyContext(ctx, messageText);

    this.logger.info({ userId, message: messageText.substring(0, 100), hasReply: fullMessage !== messageText }, 'Received message');

    // Notify engagement detector (proactive feedback loop)
    if (this.onUserMessage) {
      this.onUserMessage(`telegram:${userId}`);
    }

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = this.buildOnProgress(userId, ctx);

      // Check if user wants to stop
      const shouldStop = () => this.stopRequests.has(userId);
      const providerOverride = this.getProviderForUser(userId);

      const result = await this.agent.processMessage(sessionId, fullMessage, undefined, onProgress, shouldStop, providerOverride);

      // Clear stop request after processing
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse).filter(c => c.trim());

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch (parseError) {
          this.logger.warn({ error: (parseError as Error).message }, 'HTML parse failed, sending plain text');
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        }
      }

      // Check for pending voice attachments from voice_reply tool
      await this.sendPendingVoiceAttachments(ctx, sessionId);

      this.logger.info(
        { userId, responseLength: result.response.length, tokens: result.tokenUsage },
        'Sent response'
      );
    } catch (error) {
      clearInterval(typingInterval);
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process message');
      await ctx.reply('Sorry, I encountered an error processing your message. Please try again.');
    }
  }

  /**
   * Build message text with reply context when user replies to a previous message.
   * Prepends the quoted message so the agent has full context.
   */
  private buildMessageWithReplyContext(ctx: Context, messageText: string): string {
    const reply = ctx.message?.reply_to_message;
    if (!reply) return messageText;

    // Extract text from the replied-to message
    const replyText = reply.text || reply.caption || '';
    if (!replyText) return messageText;

    // Identify who sent the replied-to message
    const isBot = reply.from?.is_bot && reply.from?.id === this.bot.botInfo?.id;
    const sender = isBot ? 'You (assistant)' : (reply.from?.first_name || 'User');

    return `[Replying to ${sender}: "${replyText}"]\n\n${messageText}`;
  }

  /**
   * Build an onProgress callback for the given user.
   * When verbose mode is off, returns a no-op. When on, sends formatted debug messages.
   */
  private buildOnProgress(userId: string, ctx: Context): ProgressCallback {
    if (!this.verboseUsers.has(userId)) {
      return async () => {};
    }

    return async (update) => {
      let text = '';
      const truncate = (s: string, max = 500) => s.length > max ? s.slice(0, max) + '…' : s;

      switch (update.type) {
        case 'memory': {
          text = `🧠 Memory: ${update.message}`;
          if (update.items && update.items.length > 0) {
            const itemList = update.items
              .slice(0, 10)
              .map(i => `  • [${i.type}] ${truncate(i.content, 80)}`)
              .join('\n');
            text += '\n' + itemList;
          }
          break;
        }
        case 'tool_start':
          text = `🔧 tool:${update.toolName}\n${truncate(update.message)}`;
          break;
        case 'tool_complete':
          text = `✅ tool:${update.toolName}\n${truncate(update.message)}`;
          break;
        case 'tool_error':
          text = `❌ tool:${update.toolName}\n${truncate(update.message)}`;
          break;
        case 'thinking':
          text = `💭 Thinking...\n${truncate(update.message)}`;
          break;
        case 'planning':
          text = `📋 Planning...\n${truncate(update.message)}`;
          break;
        default:
          return;
      }

      try {
        // Escape HTML entities and wrap in <code> block for monospace rendering
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        await ctx.reply(`<code>${escaped}</code>`, { parse_mode: 'HTML', disable_notification: true });
      } catch {
        // Silently ignore send failures for debug messages
      }
    };
  }

  private startTypingIndicator(ctx: Context): NodeJS.Timeout {
    ctx.replyWithChatAction('typing').catch(() => {});
    return setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, TYPING_INTERVAL);
  }

  /**
   * Send any pending voice attachments created by the voice_reply tool
   */
  private async sendPendingVoiceAttachments(ctx: Context, sessionId: string): Promise<void> {
    const attachments = getPendingVoiceAttachments(sessionId);
    if (attachments.length === 0) {
      return;
    }

    this.logger.info({ count: attachments.length }, 'Sending pending voice attachments');

    try {
      const { readFile } = await import('fs/promises');

      for (const filePath of attachments) {
        try {
          const audioBuffer = await readFile(filePath);
          await ctx.replyWithVoice(new InputFile(audioBuffer, 'voice.ogg'));
          this.logger.debug({ file: filePath }, 'Sent voice attachment');
        } catch (error) {
          this.logger.error({ file: filePath, error: (error as Error).message }, 'Failed to send voice attachment');
        }
      }
    } finally {
      // Clean up temp files
      await cleanupVoiceAttachments(attachments);
    }
  }

  async getOrCreateSession(userId: string): Promise<string> {
    const cached = this.userSessions.get(userId);
    if (cached) {
      const session = await this.sessionManager.getSession(cached);
      if (session) {
        return cached;
      }
    }

    // Prefix userId with channel for trigger routing (reminders, etc.)
    const session = await this.sessionManager.createSession({
      userId: `telegram:${userId}`,
      channelId: 'telegram',
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

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Load bot configurations
    await this.configManager.load();

    this.logger.info('Starting Telegram bot...');
    this.isRunning = true;

    // Register bot commands with Telegram (makes them show in menu)
    // Note: /start is intentionally omitted - it still works but doesn't clutter the menu
    await this.bot.api.setMyCommands([
      { command: 'help', description: 'Show available commands' },
      { command: 'model', description: 'Switch AI model/provider' },
      { command: 'usage', description: 'View token usage and costs' },
      { command: 'stop', description: 'Stop current task' },
      { command: 'settings', description: 'View your current settings' },
      { command: 'setup', description: 'Reconfigure bot (name, personality, timezone)' },
      { command: 'new', description: 'Start a new conversation' },
      { command: 'verbose', description: 'Toggle debug output (memory, tools, thinking)' },
    ]);

    // bot.start() runs grammy's long-polling loop and NEVER resolves.
    // Fire-and-forget so gateway.start() can continue registering trigger sources.
    this.bot.start({
      onStart: (botInfo) => {
        this.logger.info(
          {
            username: botInfo.username,
            allowedUsers: this.allowedUsers.size || 'all',
          },
          'Telegram bot started'
        );
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Telegram bot...');

    // Save configurations
    await this.configManager.saveNow();

    this.userQueues.clear();
    await this.bot.stop();
    this.isRunning = false;
    this.logger.info('Telegram bot stopped');
  }

  /**
   * Send a proactive message to a user (not as a reply)
   * Used for reminders and scheduled notifications
   */
  async sendMessage(chatId: string | number, message: string): Promise<boolean> {
    if (!this.isRunning) {
      this.logger.warn({ chatId }, 'Cannot send message - bot not running');
      return false;
    }

    // Single-user bot safety net: resolve 'default' to the configured allowed user
    if (chatId === 'default' && this.allowedUsers.size > 0) {
      chatId = this.allowedUsers.values().next().value!;
      this.logger.debug({ resolvedChatId: chatId }, 'Resolved default chatId to allowed user');
    }

    try {
      const htmlMessage = formatMarkdownToHtml(message);
      const chunks = splitMessage(htmlMessage);

      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }

      this.logger.debug({ chatId, length: message.length }, 'Sent proactive message');
      return true;
    } catch (error) {
      this.logger.error({ chatId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  /**
   * Send a file/document to a user
   */
  async sendFile(chatId: string | number, filePath: string, caption?: string): Promise<boolean> {
    if (!this.isRunning) {
      this.logger.warn({ chatId }, 'Cannot send file - bot not running');
      return false;
    }

    try {
      const file = new InputFile(filePath);
      await this.bot.api.sendDocument(chatId, file, {
        caption: caption ? formatMarkdownToHtml(caption) : undefined,
        parse_mode: caption ? 'HTML' : undefined,
      });
      this.logger.info({ chatId, filePath }, 'File sent successfully');
      return true;
    } catch (error) {
      this.logger.error({ chatId, filePath, error: (error as Error).message }, 'Failed to send file');
      return false;
    }
  }

  /**
   * Get the bot instance for advanced operations
   */
  getBotApi() {
    return this.bot.api;
  }
}

// Export for backwards compatibility and testing
export function getStartMessage(): string {
  return `Welcome to ScallopBot!

I'm your personal AI assistant. I can help you with:
- Reading and writing files
- Executing commands
- General questions and tasks

Just send me a message and I'll do my best to help!

Commands:
/start - Show this message
/help - All commands
/settings - Your configuration
/setup - Reconfigure me
/new - Start new conversation history`;
}
