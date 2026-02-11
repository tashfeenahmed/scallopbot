/**
 * WhatsApp Channel using Baileys (WhatsApp Web API)
 *
 * Uses @whiskeysockets/baileys for WhatsApp Web protocol.
 * No Business API needed - works with regular WhatsApp accounts.
 *
 * First run requires QR code scan to authenticate.
 * Session is persisted to avoid re-authentication.
 *
 * Note: Requires optional dependency @whiskeysockets/baileys
 */

import { join } from 'path';
import { mkdir } from 'fs/promises';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Channel, ChannelStatus, VoiceChannel } from './types.js';
import { VoiceManager } from '../voice/index.js';
import { safeImport } from '../utils/dynamic-import.js';

// Dynamic import types for optional dependency
let makeWASocket: any;
let DisconnectReason: any;
let useMultiFileAuthState: any;
let downloadMediaMessage: any;

// Try to load optional dependencies
async function loadBaileysDeps(): Promise<boolean> {
  try {
    // Use safe import utility with whitelist validation
    const baileys = await safeImport('@whiskeysockets/baileys');
    if (!baileys) return false;
    makeWASocket = baileys.default;
    DisconnectReason = baileys.DisconnectReason;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    downloadMediaMessage = baileys.downloadMediaMessage;
    return true;
  } catch {
    return false;
  }
}

export interface WhatsAppChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  authDir?: string; // Directory to store auth state
  enableVoice?: boolean;
  allowedNumbers?: string[]; // If set, only respond to these numbers
}

export class WhatsAppChannel implements Channel, VoiceChannel {
  public readonly name = 'whatsapp';

  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private authDir: string;
  private enableVoice: boolean;
  private allowedNumbers: Set<string> | null;

  private socket: any = null;
  private userSessions: Map<string, string> = new Map();
  private running = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_DELAY = 3000;
  private voiceManager: VoiceManager | null = null;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: WhatsAppChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'whatsapp' });
    this.authDir = options.authDir || join(process.cwd(), '.whatsapp-auth');
    this.enableVoice = options.enableVoice ?? true;
    this.allowedNumbers = options.allowedNumbers
      ? new Set(options.allowedNumbers.map(n => this.normalizeNumber(n)))
      : null;

    if (this.enableVoice) {
      this.initVoice();
    }
  }

  private async initVoice(): Promise<void> {
    try {
      this.voiceManager = VoiceManager.fromEnv(this.logger);
      const status = await this.voiceManager.isAvailable();
      if (!status.stt) {
        this.logger.warn('Voice transcription not available');
        this.voiceManager = null;
      }
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Voice init failed');
    }
  }

  private normalizeNumber(number: string): string {
    // Remove all non-digits and ensure it starts with country code
    return number.replace(/\D/g, '');
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info('Starting WhatsApp channel...');

    // Load optional dependencies
    const depsLoaded = await loadBaileysDeps();
    if (!depsLoaded) {
      this.status.error = 'WhatsApp dependencies not installed. Run: npm install @whiskeysockets/baileys @hapi/boom';
      this.running = false;
      throw new Error(this.status.error);
    }

    // Ensure auth directory exists
    await mkdir(this.authDir, { recursive: true });

    // Load or create auth state
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // Create socket
    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: true, // Show QR code in terminal for first-time auth
      logger: this.logger as any,
      browser: ['ScallopBot', 'Chrome', '120.0.0'],
    });

    // Handle connection updates
    this.socket.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.info('Scan QR code with WhatsApp to authenticate');
        this.status.authenticated = false;
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        this.logger.info({ reason, shouldReconnect }, 'Connection closed');
        this.status.connected = false;

        if (shouldReconnect && this.running) {
          if (this.reconnectAttempts >= WhatsAppChannel.MAX_RECONNECT_ATTEMPTS) {
            this.logger.error({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached, giving up');
            this.status.error = 'Max reconnect attempts reached';
            this.running = false;
            return;
          }
          const delay = Math.min(
            WhatsAppChannel.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
            300_000,
          );
          this.reconnectAttempts++;
          this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');
          setTimeout(() => this.start(), delay);
        } else if (reason === DisconnectReason.loggedOut) {
          this.status.authenticated = false;
          this.status.error = 'Logged out from WhatsApp';
        }
      } else if (connection === 'open') {
        this.logger.info('WhatsApp connected');
        this.status.connected = true;
        this.status.authenticated = true;
        this.status.error = undefined;
        this.reconnectAttempts = 0;
      }
    });

    // Save credentials when updated
    this.socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    this.socket.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        await this.handleMessage(msg);
      }
    });

    this.logger.info('WhatsApp channel started');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping WhatsApp channel...');
    this.running = false;

    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }

    this.status.connected = false;
    this.logger.info('WhatsApp channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): ChannelStatus {
    return { ...this.status, lastActivity: new Date() };
  }

  supportsVoice(): boolean {
    return this.enableVoice && this.voiceManager !== null;
  }

  private async handleMessage(msg: any): Promise<void> {
    // Skip if not a user message
    if (!msg.message || msg.key.fromMe) {
      return;
    }

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Extract user ID (phone number)
    const userId = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

    // Check if number is allowed (if whitelist is set)
    if (this.allowedNumbers && !this.allowedNumbers.has(userId)) {
      this.logger.debug({ userId }, 'Ignoring message from non-allowed number');
      return;
    }

    // Determine message type and extract content
    const message = msg.message;
    let textContent: string | null = null;

    if (message.conversation) {
      textContent = message.conversation;
    } else if (message.extendedTextMessage?.text) {
      textContent = message.extendedTextMessage.text;
    } else if (message.audioMessage && this.supportsVoice()) {
      // Handle voice message
      await this.handleVoiceMessage(msg, userId, jid);
      return;
    }

    if (!textContent) {
      return;
    }

    this.logger.info({ userId, message: textContent.substring(0, 100) }, 'Received message');

    // Handle commands
    if (textContent.startsWith('/')) {
      await this.handleCommand(textContent, jid);
      return;
    }

    // Process through agent
    await this.processMessage(textContent, userId, jid);
  }

  private async handleCommand(text: string, jid: string): Promise<void> {
    const [command, ..._args] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'start':
      case 'help':
        await this.sendText(jid, this.getHelpMessage());
        break;

      case 'reset':
        const userId = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        await this.handleReset(userId);
        await this.sendText(jid, 'Conversation cleared. Starting fresh!');
        break;

      case 'status':
        await this.sendText(jid, `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`);
        break;

      default:
        await this.sendText(jid, `Unknown command: /${command}\nType /help for available commands.`);
    }
  }

  private getHelpMessage(): string {
    return `*ScallopBot on WhatsApp*

I'm your personal AI assistant. Just send me a message!

*Commands:*
/help - Show this message
/reset - Clear conversation history
/status - Check bot status

${this.supportsVoice() ? '_Voice messages are supported!_' : ''}`;
  }

  private async processMessage(text: string, userId: string, jid: string): Promise<void> {
    try {
      // Show typing indicator
      await this.socket?.sendPresenceUpdate('composing', jid);

      // Get or create session
      const sessionId = await this.getOrCreateSession(userId);

      // Process through agent
      const result = await this.agent.processMessage(sessionId, text);

      // Clear typing indicator
      await this.socket?.sendPresenceUpdate('paused', jid);

      // Send response
      await this.sendText(jid, result.response);

      this.logger.info(
        { userId, responseLength: result.response.length, tokens: result.tokenUsage },
        'Sent response'
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process message');
      await this.sendText(jid, 'Sorry, I encountered an error. Please try again.');
    }
  }

  async handleVoiceMessage(
    msg: any,
    userId: string,
    jid: string
  ): Promise<string> {
    if (!this.voiceManager) {
      await this.sendText(jid, 'Voice messages are not supported.');
      return '';
    }

    try {
      this.logger.info({ userId }, 'Processing voice message');

      // Download voice message
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.logger as any,
          reuploadRequest: this.socket!.updateMediaMessage,
        }
      );

      if (!buffer || !(buffer instanceof Buffer)) {
        throw new Error('Failed to download voice message');
      }

      // Transcribe
      const result = await this.voiceManager.transcribe(buffer);

      if (!result.text.trim()) {
        await this.sendText(jid, "I couldn't understand the audio. Please try again.");
        return '';
      }

      // Show transcription
      await this.sendText(jid, `🎤 _"${result.text}"_`);

      // Process the transcribed text
      await this.processMessage(result.text, userId, jid);

      return result.text;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process voice message');
      await this.sendText(jid, 'Failed to process voice message. Please send a text message.');
      return '';
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

    const session = await this.sessionManager.createSession({
      userId,
      channelId: 'whatsapp',
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

  private async sendText(jid: string, text: string): Promise<void> {
    if (!this.socket) {
      throw new Error('WhatsApp not connected');
    }

    // WhatsApp has a message length limit, split if needed
    const MAX_LENGTH = 4096;
    const chunks = this.splitMessage(text, MAX_LENGTH);

    for (const chunk of chunks) {
      await this.socket.sendMessage(jid, { text: chunk });
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf('\n', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex).trim());
      remaining = remaining.substring(splitIndex).trim();
    }

    return chunks;
  }
}
