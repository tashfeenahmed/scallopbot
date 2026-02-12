/**
 * Signal Channel using signal-cli
 *
 * Uses signal-cli (Java CLI) as a bridge to Signal.
 * Requires signal-cli to be installed and registered with a phone number.
 *
 * Setup:
 * 1. Install signal-cli: brew install signal-cli (or download from GitHub)
 * 2. Register: signal-cli -a +1234567890 register
 * 3. Verify: signal-cli -a +1234567890 verify CODE
 * 4. Configure SIGNAL_PHONE_NUMBER in .env
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Channel, ChannelStatus, VoiceChannel } from './types.js';
import { VoiceManager } from '../voice/index.js';

export interface SignalChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  phoneNumber: string; // Bot's registered Signal number
  signalCliPath?: string; // Path to signal-cli binary
  configPath?: string; // Path to signal-cli config directory
  enableVoice?: boolean;
  allowedNumbers?: string[]; // If set, only respond to these numbers
}

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message: string;
      attachments?: SignalAttachment[];
    };
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

export class SignalChannel implements Channel, VoiceChannel {
  public readonly name = 'signal';

  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private phoneNumber: string;
  private signalCliPath: string;
  private configPath: string | undefined;
  private enableVoice: boolean;
  private allowedNumbers: Set<string> | null;

  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private userSessions: Map<string, string> = new Map();
  private running = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly BASE_RECONNECT_DELAY = 5000;
  private voiceManager: VoiceManager | null = null;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: SignalChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'signal' });
    this.phoneNumber = options.phoneNumber;
    this.signalCliPath = options.signalCliPath || 'signal-cli';
    this.configPath = options.configPath;
    this.enableVoice = options.enableVoice ?? true;
    this.allowedNumbers = options.allowedNumbers
      ? new Set(options.allowedNumbers.map((n) => this.normalizeNumber(n)))
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
    // Remove all non-digits except leading +
    const cleaned = number.replace(/[^\d+]/g, '');
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info('Starting Signal channel...');

    // Check if signal-cli is available
    const isAvailable = await this.checkSignalCli();
    if (!isAvailable) {
      this.status.error = 'signal-cli not found. Please install it first.';
      this.running = false;
      throw new Error(this.status.error);
    }

    // Start signal-cli in JSON-RPC mode
    const args = ['-a', this.phoneNumber, 'jsonRpc'];
    if (this.configPath) {
      args.unshift('--config', this.configPath);
    }

    this.process = spawn(this.signalCliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (error) => {
      this.logger.error({ error: error.message }, 'signal-cli process error');
      this.status.error = error.message;
      this.status.connected = false;
    });

    this.process.on('close', (code) => {
      this.logger.info({ code }, 'signal-cli process closed');
      this.status.connected = false;
      if (this.running) {
        if (this.reconnectAttempts >= SignalChannel.MAX_RECONNECT_ATTEMPTS) {
          this.logger.error({ attempts: this.reconnectAttempts }, 'Max reconnect attempts reached, giving up');
          this.status.error = 'Max reconnect attempts reached';
          this.running = false;
          return;
        }
        const delay = Math.min(
          SignalChannel.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
          300_000,
        );
        this.reconnectAttempts++;
        this.logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');
        setTimeout(() => this.start(), delay);
      }
    });

    // Parse JSON-RPC messages from stdout
    if (this.process.stdout) {
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.readline.on('line', (line) => {
        this.handleLine(line);
      });
    }

    this.process.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        this.logger.debug({ stderr: msg }, 'signal-cli stderr');
      }
    });

    // Give it time to connect
    await new Promise((resolve) => setTimeout(resolve, 2000));

    this.status.connected = true;
    this.status.authenticated = true;
    this.reconnectAttempts = 0;
    this.logger.info('Signal channel started');
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

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let data: { jsonrpc?: string; method?: string; params?: SignalMessage };
    try {
      data = JSON.parse(line);
    } catch {
      // Not JSON, might be status message
      this.logger.debug({ line: line.slice(0, 200) }, 'Non-JSON line from signal-cli');
      return;
    }

    // Handle JSON-RPC responses
    if (data.jsonrpc === '2.0' && data.method === 'receive' && data.params) {
      this.handleMessage(data.params);
    }
  }

  private async handleMessage(message: SignalMessage): Promise<void> {
    const envelope = message.envelope;

    // Skip receipt and typing messages
    if (envelope.receiptMessage || envelope.typingMessage) {
      return;
    }

    // Get the message content
    const dataMessage = envelope.dataMessage;
    if (!dataMessage?.message) {
      return;
    }

    const userId = envelope.sourceNumber || envelope.source;
    const text = dataMessage.message;

    // Check if number is allowed
    if (this.allowedNumbers && !this.allowedNumbers.has(this.normalizeNumber(userId))) {
      this.logger.debug({ userId }, 'Ignoring message from non-allowed number');
      return;
    }

    this.logger.info({ userId, message: text.substring(0, 100) }, 'Received message');

    // Handle voice attachments
    if (dataMessage.attachments?.length && this.supportsVoice()) {
      const voiceAttachment = dataMessage.attachments.find(
        (a) => a.contentType.startsWith('audio/')
      );
      if (voiceAttachment) {
        await this.handleVoiceMessage(voiceAttachment, userId);
        return;
      }
    }

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(text, userId);
      return;
    }

    // Process through agent
    await this.processMessage(text, userId);
  }

  private async handleCommand(text: string, userId: string): Promise<void> {
    const [command] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'start':
      case 'help':
        await this.sendMessage(userId, this.getHelpMessage());
        break;

      case 'reset':
        await this.handleReset(userId);
        await this.sendMessage(userId, 'Conversation cleared. Starting fresh!');
        break;

      case 'status':
        await this.sendMessage(
          userId,
          `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
        );
        break;

      default:
        await this.sendMessage(
          userId,
          `Unknown command: /${command}\nType /help for available commands.`
        );
    }
  }

  private getHelpMessage(): string {
    return `*ScallopBot on Signal*

I'm your personal AI assistant. Just send me a message!

*Commands:*
/help - Show this message
/reset - Clear conversation history
/status - Check bot status

${this.supportsVoice() ? 'Voice messages are supported!' : ''}`;
  }

  private async processMessage(text: string, userId: string): Promise<void> {
    try {
      // Get or create session
      const sessionId = await this.getOrCreateSession(userId);

      // Process through agent
      const result = await this.agent.processMessage(sessionId, text);

      // Send response
      await this.sendMessage(userId, result.response);

      this.logger.info(
        { userId, responseLength: result.response.length, tokens: result.tokenUsage },
        'Sent response'
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process message');
      await this.sendMessage(userId, 'Sorry, I encountered an error. Please try again.');
    }
  }

  private async sendMessage(recipient: string, message: string): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error('Signal not connected');
    }

    // Signal has character limits, split long messages
    const MAX_LENGTH = 2000;
    const chunks = this.splitMessage(message, MAX_LENGTH);

    for (const chunk of chunks) {
      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'send',
        id: Date.now(),
        params: {
          recipient: [recipient],
          message: chunk,
        },
      };

      this.process.stdin.write(JSON.stringify(rpcRequest) + '\n');
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

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Signal channel...');
    this.running = false;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

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

  async handleVoiceMessage(
    attachment: SignalAttachment,
    userId: string
  ): Promise<string> {
    if (!this.voiceManager) {
      await this.sendMessage(userId, 'Voice messages are not supported.');
      return '';
    }

    try {
      this.logger.info({ userId, attachmentId: attachment.id }, 'Processing voice message');

      // Note: signal-cli stores attachments in its data directory
      // We would need to read the file from there
      // For now, return a message about the limitation
      await this.sendMessage(
        userId,
        'Voice message received. Voice processing for Signal requires additional setup.'
      );

      return '';
    } catch (error) {
      const err = error as Error;
      this.logger.error({ userId, error: err.message }, 'Failed to process voice message');
      await this.sendMessage(
        userId,
        'Failed to process voice message. Please send a text message.'
      );
      return '';
    }
  }

  async getOrCreateSession(userId: string): Promise<string> {
    const normalizedId = this.normalizeNumber(userId);
    const cached = this.userSessions.get(normalizedId);
    if (cached) {
      const session = await this.sessionManager.getSession(cached);
      if (session) {
        return cached;
      }
    }

    const session = await this.sessionManager.createSession({
      userId: normalizedId,
      channelId: 'signal',
    });

    this.userSessions.set(normalizedId, session.id);
    return session.id;
  }

  async handleReset(userId: string): Promise<void> {
    const normalizedId = this.normalizeNumber(userId);
    const sessionId = this.userSessions.get(normalizedId);
    if (sessionId) {
      await this.sessionManager.deleteSession(sessionId);
      this.userSessions.delete(normalizedId);
    }
  }
}
