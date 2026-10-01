/**
 * WhatsApp Channel using Baileys (WhatsApp Web API)
 *
 * Uses @whiskeysockets/baileys for the WhatsApp Web multi-device protocol.
 * No Business API needed: the bot links to a regular WhatsApp account as a
 * linked device, so it ONLY answers numbers on the allowlist.
 *
 * First run needs linking: set the account's own number to get a pairing
 * code in the log (WhatsApp > Linked devices > Link with phone number), or
 * scan the QR (printed when the optional `qrcode-terminal` package is
 * installed, otherwise logged as raw QR data). The session is persisted in
 * the auth directory so later starts reconnect silently.
 *
 * Note: Requires optional dependency @whiskeysockets/baileys
 */

import { basename, extname, join } from 'path';
import { mkdir } from 'fs/promises';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { ChannelStatus, VoiceChannel } from './types.js';
import { VoiceManager } from '../voice/index.js';
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
    makeWASocket = baileys.default ?? baileys.makeWASocket;
    DisconnectReason = baileys.DisconnectReason;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    downloadMediaMessage = baileys.downloadMediaMessage;
    return true;
  } catch {
    return false;
  }
}

const PHONE_JID_SUFFIX = '@s.whatsapp.net';
const MAX_MESSAGE_LENGTH = 4096;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export interface WhatsAppChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  authDir?: string; // Directory to store auth state
  enableVoice?: boolean;
  allowedNumbers?: string[]; // If set, only respond to these numbers
  /** Linked account's own number; when set and unpaired, a pairing code is logged */
  phoneNumber?: string;
  /** Shared voice manager (otherwise one is built from env) */
  voiceManager?: VoiceManager;
  /** Rehydrates sessions after a restart */
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  onUserMessage?: ChatUserMessageHook;
}

export class WhatsAppChannel implements ProactiveChatChannel, VoiceChannel {
  public readonly name = 'whatsapp';

  private agent: Agent;
  private logger: Logger;
  private authDir: string;
  private enableVoice: boolean;
  private allowedNumbers: Set<string> | null;
  private phoneNumber: string | null;
  private onUserMessage?: ChatUserMessageHook;

  private socket: any = null;
  private sessions: ChannelSessions;
  private turns = new KeyedSerialQueue();
  private running = false;
  private pairingRequested = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_DELAY = 3000;
  private voiceManager: VoiceManager | null = null;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: WhatsAppChannelOptions) {
    this.agent = options.agent;
    this.logger = options.logger.child({ channel: 'whatsapp' });
    this.authDir = options.authDir || join(process.cwd(), '.whatsapp-auth');
    this.enableVoice = options.enableVoice ?? true;
    this.allowedNumbers = options.allowedNumbers?.length
      ? new Set(options.allowedNumbers.map(n => this.normalizeNumber(n)))
      : null;
    this.phoneNumber = options.phoneNumber ? this.normalizeNumber(options.phoneNumber) : null;
    this.onUserMessage = options.onUserMessage;
    this.sessions = new ChannelSessions('whatsapp', options.sessionManager, options.db);

    if (this.enableVoice) {
      void this.initVoice(options.voiceManager);
    }
  }

  private async initVoice(shared?: VoiceManager): Promise<void> {
    try {
      const manager = shared ?? VoiceManager.fromEnv(this.logger);
      const status = await manager.isAvailable();
      if (!status.stt) {
        this.logger.warn('Voice transcription not available');
        return;
      }
      this.voiceManager = manager;
    } catch (error) {
      this.logger.debug({ error: (error as Error).message }, 'Voice init failed');
    }
  }

  private normalizeNumber(number: string): string {
    // Digits only, country code first (no +)
    return number.replace(/\D/g, '');
  }

  isAllowedRecipient(number: string): boolean {
    return !this.allowedNumbers || this.allowedNumbers.has(this.normalizeNumber(number));
  }

  soleRecipient(): string | null {
    return soleEntry(this.allowedNumbers);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.logger.info('Starting WhatsApp channel...');

    // Load optional dependencies
    const depsLoaded = await loadBaileysDeps();
    if (!depsLoaded) {
      this.status.error = 'WhatsApp dependencies not installed. Run: npm install @whiskeysockets/baileys @hapi/boom';
      throw new Error(this.status.error);
    }

    // Ensure auth directory exists
    await mkdir(this.authDir, { recursive: true });

    this.running = true;
    await this.connect();
    this.logger.info(
      { allowedNumbers: this.allowedNumbers?.size ?? 'all' },
      'WhatsApp channel started',
    );
  }

  /** Open (or re-open) the socket. Reconnects call this, not start(). */
  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // Baileys logs a lot at info; keep only its warnings.
    const baileysLogger = this.logger.child({ module: 'baileys' }, { level: 'warn' });
    const socket = makeWASocket({
      auth: state,
      logger: baileysLogger as any,
      browser: ['ScallopBot', 'Chrome', '120.0.0'],
    });
    this.socket = socket;

    socket.ev.on('connection.update', async (update: any) => {
      if (this.socket !== socket) return; // stale socket from before a reconnect
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status.authenticated = false;
        await this.showLinkingPrompt(socket, qr, state);
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;

        this.logger.info({ reason, loggedOut }, 'Connection closed');
        this.status.connected = false;

        if (loggedOut) {
          this.status.authenticated = false;
          this.status.error = `Logged out from WhatsApp; delete ${this.authDir} and link again`;
          this.logger.error(this.status.error);
          return;
        }
        if (this.running) this.scheduleReconnect();
      } else if (connection === 'open') {
        this.logger.info('WhatsApp connected');
        this.status.connected = true;
        this.status.authenticated = true;
        this.status.error = undefined;
        this.reconnectAttempts = 0;
      }
    });

    // Save credentials when updated
    socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    socket.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        await this.handleMessage(msg);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= WhatsAppChannel.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached, giving up');
      this.status.error = 'Max reconnect attempts reached';
      return;
    }
    // The first close after linking is a routine "restart required"; reconnect fast.
    const delay = this.reconnectAttempts === 0
      ? 1000
      : Math.min(WhatsAppChannel.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts), 300_000);
    this.reconnectAttempts++;
    this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.connect().catch((error) => {
        this.logger.error({ error: (error as Error).message }, 'WhatsApp reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async showLinkingPrompt(socket: any, qr: string, state: any): Promise<void> {
    if (this.phoneNumber && !state?.creds?.registered) {
      if (this.pairingRequested) return;
      this.pairingRequested = true;
      try {
        const code = await socket.requestPairingCode(this.phoneNumber);
        this.logger.warn(
          { pairingCode: code },
          'WhatsApp pairing code: open WhatsApp > Linked devices > Link with phone number and enter it',
        );
        return;
      } catch (error) {
        this.logger.warn({ error: (error as Error).message }, 'Pairing code request failed; falling back to QR');
      }
    }

    const qrcode = await safeImport('qrcode-terminal');
    const generate = qrcode?.generate ?? qrcode?.default?.generate;
    if (typeof generate === 'function') {
      this.logger.warn('Scan this QR code with WhatsApp > Linked devices > Link a device');
      generate(qr, { small: true });
    } else {
      this.logger.warn(
        { qr },
        'Scan the QR with WhatsApp > Linked devices (install qrcode-terminal to render it, or set WHATSAPP_PHONE_NUMBER for a pairing code)',
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping WhatsApp channel...');
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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

  /**
   * The sender's phone number. WhatsApp increasingly addresses chats by LID
   * (`...@lid`); Baileys then carries the phone JID in remoteJidAlt.
   */
  private senderNumber(key: any): string | null {
    const candidates = [key?.remoteJid, key?.remoteJidAlt, key?.senderPn];
    const phoneJid = candidates.find(
      (jid): jid is string => typeof jid === 'string' && jid.endsWith(PHONE_JID_SUFFIX),
    );
    return phoneJid ? this.normalizeNumber(phoneJid.slice(0, -PHONE_JID_SUFFIX.length).split(':')[0]) : null;
  }

  /** Exposed for tests: one Baileys `messages.upsert` entry. */
  async handleMessage(msg: any): Promise<void> {
    // Skip if not a user message
    if (!msg?.message || msg.key?.fromMe) {
      return;
    }

    const jid: string | undefined = msg.key.remoteJid;
    if (!jid) return;

    // One-to-one chats only: no groups, broadcasts, or status updates.
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
      return;
    }

    const userId = this.senderNumber(msg.key);
    if (!userId) {
      this.logger.debug({ jid }, 'Ignoring message without a resolvable phone number');
      return;
    }

    if (!this.isAllowedRecipient(userId)) {
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
      await this.handleVoiceMessage(msg, userId, jid);
      return;
    }

    if (!textContent) {
      return;
    }

    this.logger.info({ userId, message: textContent.substring(0, 100) }, 'Received message');

    // Handle commands
    if (textContent.startsWith('/')) {
      await this.handleCommand(textContent, userId, jid);
      return;
    }

    await this.processMessage(textContent, userId, jid);
  }

  private async handleCommand(text: string, userId: string, jid: string): Promise<void> {
    const [command] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'start':
      case 'help':
        await this.sendText(jid, this.getHelpMessage());
        break;

      case 'reset':
      case 'new':
        await this.handleReset(userId);
        await this.sendText(jid, 'Started a new conversation. Your previous conversation is preserved.');
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
/reset - Preserve this conversation and start a new one
/status - Check bot status

${this.supportsVoice() ? '_Voice messages are supported!_' : ''}`;
  }

  private async processMessage(text: string, userId: string, jid: string): Promise<void> {
    await this.turns.run(userId, async () => {
      try {
        await this.socket?.sendPresenceUpdate('composing', jid).catch(() => {});
        await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(userId), text, this.logger);

        const sessionId = await this.getOrCreateSession(userId);
        const result = await this.agent.processMessage(sessionId, text);

        await this.socket?.sendPresenceUpdate('paused', jid).catch(() => {});
        await this.sendText(jid, renderAgentReply(result));

        this.logger.info(
          { userId, responseLength: result.response.length, tokens: result.tokenUsage },
          'Sent response'
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error({ userId, error: err.message }, 'Failed to process message');
        await this.sendText(jid, 'Sorry, I encountered an error. Please try again.').catch(() => {});
      }
    });
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

      const result = await this.voiceManager.transcribe(buffer);

      if (!result.text.trim()) {
        await this.sendText(jid, "I couldn't understand the audio. Please try again.");
        return '';
      }

      await this.sendText(jid, `🎤 _"${result.text}"_`);
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
    return this.sessions.get(this.normalizeNumber(userId));
  }

  async handleReset(userId: string): Promise<void> {
    await this.sessions.reset(this.normalizeNumber(userId));
  }

  /** Proactive message to an allowlisted number (reminders, scheduled items). */
  async sendMessage(number: string, message: string): Promise<MessageDeliveryResult> {
    if (!this.running || !this.socket) {
      this.logger.warn({ number }, 'Cannot send message - WhatsApp not connected');
      return false;
    }
    if (number === 'default') {
      const sole = this.soleRecipient();
      if (!sole) return false;
      number = sole;
    }
    if (!this.isAllowedRecipient(number)) {
      this.logger.warn({ number }, 'Refusing proactive delivery outside the WhatsApp allowlist');
      return false;
    }

    try {
      const messageIds = await this.sendText(`${this.normalizeNumber(number)}${PHONE_JID_SUFFIX}`, message);
      return { sent: true, channel: 'whatsapp', messageIds };
    } catch (error) {
      this.logger.error({ number, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  async sendFile(number: string, filePath: string, caption?: string): Promise<boolean> {
    if (!this.running || !this.socket || !this.isAllowedRecipient(number)) return false;
    const jid = `${this.normalizeNumber(number)}${PHONE_JID_SUFFIX}`;
    try {
      const isImage = IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
      await this.socket.sendMessage(
        jid,
        isImage
          ? { image: { url: filePath }, caption }
          : { document: { url: filePath }, fileName: basename(filePath), mimetype: 'application/octet-stream', caption },
      );
      return true;
    } catch (error) {
      this.logger.error({ number, filePath, error: (error as Error).message }, 'Failed to send file');
      return false;
    }
  }

  private async sendText(jid: string, text: string): Promise<string[]> {
    if (!this.socket) {
      throw new Error('WhatsApp not connected');
    }

    const messageIds: string[] = [];
    for (const chunk of splitText(text, MAX_MESSAGE_LENGTH)) {
      const sent = await this.socket.sendMessage(jid, { text: chunk });
      if (sent?.key?.id) messageIds.push(String(sent.key.id));
    }
    return messageIds;
  }
}
