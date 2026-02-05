import { Bot, Context, InputFile } from 'grammy';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import { VoiceManager } from '../voice/index.js';
import { getPendingVoiceAttachments, cleanupVoiceAttachments } from '../voice/attachments.js';
import {
  BotConfigManager,
  DEFAULT_PERSONALITIES,
  AVAILABLE_MODELS,
} from './bot-config.js';

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL = 5000; // 5 seconds

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
  private voiceManager: VoiceManager | null = null;
  private voiceAvailable = false;
  private enableVoiceReply: boolean;
  private workspacePath: string;

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
      await ctx.reply('Stopping current task...');
      this.logger.info({ userId }, 'Stop requested by user');
    });

    // Handle regular messages
    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleMessage(ctx);
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleVoiceMessage(ctx);
    });

    // Handle audio messages
    this.bot.on('message:audio', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleVoiceMessage(ctx);
    });

    // Handle document/file messages
    this.bot.on('message:document', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handleDocumentMessage(ctx);
    });

    // Handle photo messages
    this.bot.on('message:photo', async (ctx) => {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      if (!this.isUserAllowed(userId)) {
        await this.sendUnauthorized(ctx);
        return;
      }

      await this.handlePhotoMessage(ctx);
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
    const personality = this.configManager.getPersonality(config.personalityId);
    const model = this.configManager.getModel(config.modelId);

    await ctx.reply(
      '<b>Your Settings</b>\n\n' +
      `<b>Bot Name:</b> ${config.botName}\n` +
      `<b>Personality:</b> ${personality?.name || config.personalityId}\n` +
      `<b>Model:</b> ${model?.name || config.modelId}\n\n` +
      'Use /setup to reconfigure these settings.',
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
      '/settings - View your configuration\n' +
      '/setup - Reconfigure the bot\n' +
      '/new - Start new conversation history\n\n' +
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

      case 'personality':
        return await this.handlePersonalityStep(ctx, userId, message);

      case 'custom_personality':
        return await this.handleCustomPersonalityStep(ctx, userId, message);

      case 'model':
        return await this.handleModelStep(ctx, userId, message);

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
      onboardingStep: 'personality',
    });

    // Show personality options
    let personalityList = `Great! I'm now <b>${botName}</b>.\n\n`;
    personalityList += "What personality should I have?\n\n";

    DEFAULT_PERSONALITIES.forEach((p, idx) => {
      personalityList += `<b>${idx + 1}.</b> ${p.name}\n   <i>${p.description}</i>\n\n`;
    });

    personalityList += `<b>${DEFAULT_PERSONALITIES.length + 1}.</b> Custom\n   <i>Describe your own personality</i>\n\n`;
    personalityList += "Reply with a number (1-5):";

    await ctx.reply(personalityList, { parse_mode: 'HTML' });
    return true;
  }

  private async handlePersonalityStep(ctx: Context, userId: string, message: string): Promise<boolean> {
    const choice = parseInt(message.trim(), 10);

    if (isNaN(choice) || choice < 1 || choice > DEFAULT_PERSONALITIES.length + 1) {
      await ctx.reply(`Please enter a number between 1 and ${DEFAULT_PERSONALITIES.length + 1}`);
      return true;
    }

    if (choice === DEFAULT_PERSONALITIES.length + 1) {
      // Custom personality
      await this.configManager.updateUserConfig(userId, {
        onboardingStep: 'custom_personality',
      });
      await ctx.reply(
        "Describe the personality you'd like me to have.\n\n" +
        "For example: \"Be a witty assistant who uses humor. Explain things simply and be encouraging.\""
      );
      return true;
    }

    const personality = DEFAULT_PERSONALITIES[choice - 1];
    await this.configManager.updateUserConfig(userId, {
      personalityId: personality.id,
      onboardingStep: 'model',
    });

    await this.showModelSelection(ctx, userId, personality.name);
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
      onboardingStep: 'model',
    });

    await this.showModelSelection(ctx, userId, 'Custom');
    return true;
  }

  private async showModelSelection(ctx: Context, userId: string, personalityName: string): Promise<void> {
    let modelList = `<b>${personalityName}</b> personality - got it!\n\n`;
    modelList += "Which AI model should I use?\n\n";

    AVAILABLE_MODELS.forEach((m, idx) => {
      const recommended = idx === 0 ? ' (Recommended)' : '';
      modelList += `<b>${idx + 1}.</b> ${m.name}${recommended}\n   <i>${m.description}</i>\n\n`;
    });

    modelList += `Reply with a number (1-${AVAILABLE_MODELS.length}):`;

    await ctx.reply(modelList, { parse_mode: 'HTML' });
  }

  private async handleModelStep(ctx: Context, userId: string, message: string): Promise<boolean> {
    const choice = parseInt(message.trim(), 10);

    if (isNaN(choice) || choice < 1 || choice > AVAILABLE_MODELS.length) {
      await ctx.reply(`Please enter a number between 1 and ${AVAILABLE_MODELS.length}`);
      return true;
    }

    const model = AVAILABLE_MODELS[choice - 1];
    await this.configManager.updateUserConfig(userId, {
      modelId: model.id,
      onboardingStep: 'complete',
      onboardingComplete: true,
    });

    // Show completion message
    const config = this.configManager.getUserConfig(userId);
    const personality = this.configManager.getPersonality(config.personalityId);

    await ctx.reply(
      `<b>Setup Complete!</b>\n\n` +
      `I'm now <b>${config.botName}</b>\n` +
      `Personality: <b>${personality?.name || 'Custom'}</b>\n` +
      `Model: <b>${model.name}</b>\n\n` +
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

    this.logger.info({ userId }, 'Received voice message');

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
      const transcription = await this.voiceManager.transcribe(audioBuffer);

      if (!transcription.text.trim()) {
        clearInterval(typingInterval);
        await ctx.reply('Could not understand the audio. Please try again.');
        return;
      }

      // Process transcribed text as regular message (don't echo transcription back)
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = async (_update: { type: string; message: string }) => {};

      const shouldStop = () => this.stopRequests.has(userId);
      const result = await this.agent.processMessage(sessionId, transcription.text, undefined, onProgress, shouldStop);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse);

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

    this.logger.info({ userId, fileName: document.file_name, mimeType: document.mime_type }, 'Received document');

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
      const safeName = (document.file_name || 'file').replace(/[^a-zA-Z0-9.-]/g, '_');
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
      const onProgress = async (_update: { type: string; message: string }) => {};

      const shouldStop = () => this.stopRequests.has(userId);
      const result = await this.agent.processMessage(sessionId, prompt, undefined, onProgress, shouldStop);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse);

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
   */
  private async handlePhotoMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id.toString();
    if (!userId) return;

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Get the largest photo (last in array)
    const photo = photos[photos.length - 1];

    this.logger.info({ userId, width: photo.width, height: photo.height }, 'Received photo');

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      // Download the photo
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status}`);
      }

      const photoBuffer = Buffer.from(await response.arrayBuffer());

      // Save to workspace
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');

      const receivedDir = join(this.workspacePath, 'received-files');
      await mkdir(receivedDir, { recursive: true });

      const timestamp = Date.now();
      const ext = file.file_path?.split('.').pop() || 'jpg';
      const savedPath = join(receivedDir, `${timestamp}_photo.${ext}`);

      await writeFile(savedPath, photoBuffer);
      this.logger.debug({ savedPath }, 'Photo saved');

      // Get caption or generate prompt
      const caption = ctx.message?.caption || '';
      const prompt = caption
        ? `The user sent a photo. Caption: "${caption}"\n\nPhoto saved at: ${savedPath}`
        : `The user sent a photo.\n\nPhoto saved at: ${savedPath}\n\nDescribe what you see in this image.`;

      // Process through agent
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = async (_update: { type: string; message: string }) => {};

      const shouldStop = () => this.stopRequests.has(userId);
      const result = await this.agent.processMessage(sessionId, prompt, undefined, onProgress, shouldStop);
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse);

      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch {
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        }
      }

      this.logger.info({ userId }, 'Processed photo message');
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error({ userId, error: (error as Error).message }, 'Failed to process photo');
      await ctx.reply('Sorry, I had trouble processing that photo. Please try again.');
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

    // Extract reply context if user is replying to a previous message
    const fullMessage = this.buildMessageWithReplyContext(ctx, messageText);

    this.logger.info({ userId, message: messageText.substring(0, 100), hasReply: fullMessage !== messageText }, 'Received message');

    const typingInterval = this.startTypingIndicator(ctx);

    try {
      const sessionId = await this.getOrCreateSession(userId);

      // Thinking stays enabled in the agent but is not surfaced to Telegram users
      const onProgress = async (_update: { type: string; message: string }) => {};

      // Check if user wants to stop
      const shouldStop = () => this.stopRequests.has(userId);

      const result = await this.agent.processMessage(sessionId, fullMessage, undefined, onProgress, shouldStop);

      // Clear stop request after processing
      this.stopRequests.delete(userId);

      clearInterval(typingInterval);

      const formattedResponse = formatMarkdownToHtml(result.response);
      const chunks = splitMessage(formattedResponse);

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
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Start the bot / Show welcome message' },
      { command: 'help', description: 'Show available commands' },
      { command: 'stop', description: 'Stop current task' },
      { command: 'settings', description: 'View your current settings' },
      { command: 'setup', description: 'Reconfigure bot (name, personality, model)' },
      { command: 'new', description: 'Start a new conversation' },
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

    await this.bot.stop();
    this.isRunning = false;
    this.logger.info('Telegram bot stopped');
  }

  /**
   * Send a proactive message to a user (not as a reply)
   * Used for reminders and scheduled notifications
   */
  async sendMessage(chatId: string | number, message: string): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn({ chatId }, 'Cannot send message - bot not running');
      return;
    }

    try {
      const htmlMessage = formatMarkdownToHtml(message);
      const chunks = splitMessage(htmlMessage);

      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      }

      this.logger.debug({ chatId, length: message.length }, 'Sent proactive message');
    } catch (error) {
      this.logger.error({ chatId, error: (error as Error).message }, 'Failed to send proactive message');
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
