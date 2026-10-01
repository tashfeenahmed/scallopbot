/**
 * Signal Channel using signal-cli
 *
 * Uses signal-cli (Java CLI) in JSON-RPC mode as a bridge to Signal.
 * Requires signal-cli to be installed and registered with a phone number.
 *
 * Setup:
 * 1. Install signal-cli: brew install signal-cli (or download from GitHub)
 * 2. Register: signal-cli -a +1234567890 register
 * 3. Verify: signal-cli -a +1234567890 verify CODE
 * 4. Configure SIGNAL_PHONE_NUMBER (and SIGNAL_ALLOWED_NUMBERS) in .env
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface, type Interface } from 'readline';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { ChannelStatus, VoiceChannel } from './types.js';
import { VoiceManager } from '../voice/index.js';
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

const MAX_MESSAGE_LENGTH = 2000;
const RPC_TIMEOUT_MS = 30_000;

export interface SignalChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  phoneNumber: string; // Bot's registered Signal number
  signalCliPath?: string; // Path to signal-cli binary
  configPath?: string; // Path to signal-cli config directory
  enableVoice?: boolean;
  allowedNumbers?: string[]; // If set, only respond to these numbers
  /** Shared voice manager (otherwise one is built from env) */
  voiceManager?: VoiceManager;
  /** Rehydrates sessions after a restart */
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  onUserMessage?: ChatUserMessageHook;
}

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message?: string | null;
      attachments?: SignalAttachment[];
      groupInfo?: unknown;
      groupV2?: unknown;
    };
    syncMessage?: unknown;
    receiptMessage?: {
      type: string;
      timestamps: number[];
    };
    typingMessage?: {
      action: string;
      timestamp: number;
    };
  };
}

interface SignalAttachment {
  contentType: string;
  filename?: string;
  id: string;
  size: number;
}

interface PendingRpc {
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

export class SignalChannel implements ProactiveChatChannel, VoiceChannel {
  public readonly name = 'signal';

  private agent: Agent;
  private logger: Logger;
  private phoneNumber: string;
  private signalCliPath: string;
  private configPath: string | undefined;
  private enableVoice: boolean;
  private allowedNumbers: Set<string> | null;
  private onUserMessage?: ChatUserMessageHook;

  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private sessions: ChannelSessions;
  private turns = new KeyedSerialQueue();
  private pendingRpc = new Map<number, PendingRpc>();
  private nextRpcId = 1;
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_DELAY = 5000;
  private voiceManager: VoiceManager | null = null;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: SignalChannelOptions) {
    this.agent = options.agent;
    this.logger = options.logger.child({ channel: 'signal' });
    this.phoneNumber = options.phoneNumber;
    this.signalCliPath = options.signalCliPath || 'signal-cli';
    this.configPath = options.configPath || undefined;
    this.enableVoice = options.enableVoice ?? true;
    this.allowedNumbers = options.allowedNumbers?.length
      ? new Set(options.allowedNumbers.map((n) => this.normalizeNumber(n)))
      : null;
    this.onUserMessage = options.onUserMessage;
    this.sessions = new ChannelSessions('signal', options.sessionManager, options.db);

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
    // Remove all non-digits except leading +
    const cleaned = number.replace(/[^\d+]/g, '');
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
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

    this.logger.info('Starting Signal channel...');

    const isAvailable = await this.checkSignalCli();
    if (!isAvailable) {
      this.status.error = `signal-cli not found (${this.signalCliPath}). Please install it first.`;
      throw new Error(this.status.error);
    }

    this.running = true;
    this.spawnProcess();

    // Give signal-cli time to connect
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (this.process) {
      this.status.connected = true;
      this.status.authenticated = true;
    }
    this.logger.info({ allowedNumbers: this.allowedNumbers?.size ?? 'all' }, 'Signal channel started');
  }

  /** Spawn signal-cli in JSON-RPC mode. Restarts call this, not start(). */
  private spawnProcess(): void {
    const args = ['-a', this.phoneNumber, 'jsonRpc'];
    if (this.configPath) {
      args.unshift('--config', this.configPath);
    }

    const proc = spawn(this.signalCliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;

    proc.on('error', (error) => {
      this.logger.error({ error: error.message }, 'signal-cli process error');
      this.status.error = error.message;
      this.status.connected = false;
    });

    proc.on('close', (code) => {
      if (this.process !== proc) return;
      this.logger.info({ code }, 'signal-cli process closed');
      this.process = null;
      this.status.connected = false;
      this.failPendingRpc();
      if (this.running) this.scheduleRestart();
    });

    if (proc.stdout) {
      this.readline = createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });

      this.readline.on('line', (line) => {
        this.handleLine(line);
      });
    }

    proc.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        this.logger.debug({ stderr: msg }, 'signal-cli stderr');
      }
    });
  }

  private scheduleRestart(): void {
    if (this.reconnectAttempts >= SignalChannel.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached, giving up');
      this.status.error = 'Max reconnect attempts reached';
      return;
    }
    const delay = Math.min(
      SignalChannel.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      300_000,
    );
    this.reconnectAttempts++;
    this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Restarting signal-cli...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.spawnProcess();
      this.status.connected = true;
    }, delay);
  }

  private async checkSignalCli(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [this.signalCliPath]);
      proc.on('close', (code) => {
        resolve(code === 0);
      });
      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /** Exposed for tests: one line of signal-cli JSON-RPC output. */
  handleLine(line: string): void {
    if (!line.trim()) return;

    let data: {
      jsonrpc?: string;
      method?: string;
      params?: SignalMessage;
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      data = JSON.parse(line);
    } catch {
      this.logger.debug({ line: line.slice(0, 200) }, 'Non-JSON line from signal-cli');
      return;
    }

    if (data.jsonrpc !== '2.0') return;

    // Response to one of our requests
    if (typeof data.id === 'number' && !data.method) {
      const pending = this.pendingRpc.get(data.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(data.id);
        if (data.error) this.logger.warn({ error: data.error.message }, 'signal-cli request failed');
        pending.resolve(!data.error);
      }
      return;
    }

    if (data.method === 'receive' && data.params) {
      this.reconnectAttempts = 0;
      void this.handleMessage(data.params).catch((error) => {
        this.logger.error({ error: (error as Error).message }, 'Failed to handle Signal message');
      });
    }
  }

  private async handleMessage(message: SignalMessage): Promise<void> {
    const envelope = message.envelope;

    if (envelope.receiptMessage || envelope.typingMessage || envelope.syncMessage) {
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;
    // Direct messages only; replying privately to a group message would leak context.
    if (dataMessage.groupInfo || dataMessage.groupV2) return;

    const sender = envelope.sourceNumber || envelope.source;
    if (!sender) return;
    const userId = this.normalizeNumber(sender);

    if (!this.isAllowedRecipient(userId)) {
      this.logger.debug({ userId }, 'Ignoring message from non-allowed number');
      return;
    }

    const text = dataMessage.message?.trim() ?? '';

    // Voice notes arrive as an audio attachment with no text body.
    const voiceAttachment = dataMessage.attachments?.find((a) => a.contentType?.startsWith('audio/'));
    if (voiceAttachment && !text) {
      await this.handleVoiceMessage(voiceAttachment, userId);
      return;
    }

    if (!text) return;

    this.logger.info({ userId, message: text.substring(0, 100) }, 'Received message');

    if (text.startsWith('/')) {
      await this.handleCommand(text, userId);
      return;
    }

    await this.processMessage(text, userId);
  }

  private async handleCommand(text: string, userId: string): Promise<void> {
    const [command] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'start':
      case 'help':
        await this.sendText(userId, this.getHelpMessage());
        break;

      case 'reset':
      case 'new':
        await this.handleReset(userId);
        await this.sendText(userId, 'Started a new conversation. Your previous conversation is preserved.');
        break;

      case 'status':
        await this.sendText(
          userId,
          `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
        );
        break;

      default:
        await this.sendText(
          userId,
          `Unknown command: /${command}\nType /help for available commands.`
        );
    }
  }

  private getHelpMessage(): string {
    return `ScallopBot on Signal

I'm your personal AI assistant. Just send me a message!

Commands:
/help - Show this message
/reset - Preserve this conversation and start a new one
/status - Check bot status

${this.supportsVoice() ? 'Voice messages are supported!' : ''}`;
  }

  private async processMessage(text: string, userId: string): Promise<void> {
    await this.turns.run(userId, async () => {
      try {
        await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(userId), text, this.logger);
        const sessionId = await this.getOrCreateSession(userId);
        const result = await this.agent.processMessage(sessionId, text);

        await this.sendText(userId, renderAgentReply(result));

        this.logger.info(
          { userId, responseLength: result.response.length, tokens: result.tokenUsage },
          'Sent response'
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error({ userId, error: err.message }, 'Failed to process message');
        await this.sendText(userId, 'Sorry, I encountered an error. Please try again.').catch(() => false);
      }
    });
  }

  /** Send one JSON-RPC request and wait for signal-cli's response. */
  private rpc(method: string, params: Record<string, unknown>): Promise<boolean> {
    const stdin = this.process?.stdin;
    if (!stdin) return Promise.resolve(false);

    const id = this.nextRpcId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        this.logger.warn({ method }, 'signal-cli request timed out');
        resolve(false);
      }, RPC_TIMEOUT_MS);
      this.pendingRpc.set(id, { resolve, timer });
      stdin.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
    });
  }

  private failPendingRpc(): void {
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingRpc.clear();
  }

  private async sendText(recipient: string, message: string): Promise<boolean> {
    let ok = true;
    for (const chunk of splitText(message, MAX_MESSAGE_LENGTH)) {
      ok = (await this.rpc('send', { recipient: [recipient], message: chunk })) && ok;
    }
    return ok;
  }

  /** Proactive message to an allowlisted number (reminders, scheduled items). */
  async sendMessage(number: string, message: string): Promise<MessageDeliveryResult> {
    if (!this.running || !this.process) {
      this.logger.warn({ number }, 'Cannot send message - Signal not running');
      return false;
    }
    if (number === 'default') {
      const sole = this.soleRecipient();
      if (!sole) return false;
      number = sole;
    }
    if (!this.isAllowedRecipient(number)) {
      this.logger.warn({ number }, 'Refusing proactive delivery outside the Signal allowlist');
      return false;
    }
    return this.sendText(this.normalizeNumber(number), message);
  }

  async sendFile(number: string, filePath: string, caption?: string): Promise<boolean> {
    if (!this.running || !this.process || !this.isAllowedRecipient(number)) return false;
    return this.rpc('send', {
      recipient: [this.normalizeNumber(number)],
      message: caption ?? '',
      attachments: [filePath],
    });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Signal channel...');
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process) {
      const proc = this.process;
      this.process = null;
      proc.kill('SIGTERM');
    }
    this.failPendingRpc();

    this.status.connected = false;
    this.logger.info('Signal channel stopped');
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

  /** signal-cli stores received attachments under <data dir>/attachments/<id>. */
  private attachmentPath(id: string): string {
    const dataDir = this.configPath
      ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'signal-cli');
    return join(dataDir, 'attachments', id);
  }

  async handleVoiceMessage(
    attachment: SignalAttachment,
    userId: string
  ): Promise<string> {
    if (!this.voiceManager) {
      await this.sendText(userId, 'Voice messages are not supported. Please send a text message.');
      return '';
    }

    try {
      this.logger.info({ userId, attachmentId: attachment.id }, 'Processing voice message');

      const audio = await readFile(this.attachmentPath(attachment.id));
      const result = await this.voiceManager.transcribe(audio);
      const text = result.text.trim();

      if (!text) {
        await this.sendText(userId, "I couldn't understand the audio. Please try again.");
        return '';
      }

      await this.processMessage(text, userId);
      return text;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process voice message');
      await this.sendText(userId, 'Failed to process voice message. Please send a text message.');
      return '';
    }
  }

  async getOrCreateSession(userId: string): Promise<string> {
    return this.sessions.get(this.normalizeNumber(userId));
  }

  async handleReset(userId: string): Promise<void> {
    await this.sessions.reset(this.normalizeNumber(userId));
  }
}
