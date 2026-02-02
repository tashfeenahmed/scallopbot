/**
 * Matrix Channel using matrix-js-sdk
 *
 * Uses matrix-js-sdk for the Matrix protocol.
 * Matrix is an open protocol that can bridge to many other platforms.
 *
 * Supported homeservers:
 * - matrix.org (public)
 * - element.io
 * - Self-hosted Synapse/Dendrite
 *
 * Required config:
 * - MATRIX_HOMESERVER_URL (e.g., https://matrix.org)
 * - MATRIX_ACCESS_TOKEN (or MATRIX_USER_ID + MATRIX_PASSWORD)
 *
 * Note: Requires optional dependency matrix-js-sdk
 */

import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Channel, ChannelStatus } from './types.js';
import { safeImport } from '../utils/dynamic-import.js';

// Dynamic import for optional dependency
let sdk: any;
let ClientEvent: any;
let RoomEvent: any;
let RoomMemberEvent: any;

async function loadMatrixDeps(): Promise<boolean> {
  try {
    // Use safe import utility with whitelist validation
    sdk = await safeImport('matrix-js-sdk');
    if (!sdk) return false;
    ClientEvent = sdk.ClientEvent;
    RoomEvent = sdk.RoomEvent;
    RoomMemberEvent = sdk.RoomMemberEvent;
    return true;
  } catch {
    return false;
  }
}

export interface MatrixChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  homeserverUrl: string;
  accessToken?: string;
  userId?: string;
  password?: string;
  deviceId?: string;
  autoJoin?: boolean; // Auto-join rooms when invited
  allowedRooms?: string[]; // If set, only respond in these rooms
}

export class MatrixChannel implements Channel {
  public readonly name = 'matrix';

  private agent: Agent;
  private sessionManager: SessionManager;
  private logger: Logger;
  private homeserverUrl: string;
  private accessToken?: string;
  private userId?: string;
  private password?: string;
  private deviceId?: string;
  private autoJoin: boolean;
  private allowedRooms: Set<string> | null;

  private client: any = null;
  private userSessions: Map<string, string> = new Map();
  private running = false;
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: MatrixChannelOptions) {
    this.agent = options.agent;
    this.sessionManager = options.sessionManager;
    this.logger = options.logger.child({ channel: 'matrix' });
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.password = options.password;
    this.deviceId = options.deviceId;
    this.autoJoin = options.autoJoin ?? true;
    this.allowedRooms = options.allowedRooms
      ? new Set(options.allowedRooms)
      : null;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info({ homeserver: this.homeserverUrl }, 'Starting Matrix channel...');

    try {
      // Load optional dependencies
      const depsLoaded = await loadMatrixDeps();
      if (!depsLoaded) {
        this.status.error = 'Matrix dependencies not installed. Run: npm install matrix-js-sdk';
        this.running = false;
        throw new Error(this.status.error);
      }

      // Create client
      this.client = sdk.createClient({
        baseUrl: this.homeserverUrl,
        accessToken: this.accessToken,
        userId: this.userId,
        deviceId: this.deviceId,
      });

      // Login if no access token but have credentials
      if (!this.accessToken && this.userId && this.password) {
        const loginResponse = await this.client.login('m.login.password', {
          user: this.userId,
          password: this.password,
          device_id: this.deviceId,
        });
        this.accessToken = loginResponse.access_token;
        this.logger.info('Logged in to Matrix');
      }

      // Setup event handlers
      this.setupEventHandlers();

      // Start syncing
      await this.client.startClient({ initialSyncLimit: 10 });

      // Wait for initial sync
      await new Promise<void>((resolve) => {
        this.client!.once(ClientEvent.Sync, (state: string) => {
          if (state === 'PREPARED') {
            resolve();
          }
        });
      });

      this.status.connected = true;
      this.status.authenticated = true;
      this.status.error = undefined;
      this.logger.info('Matrix channel started');
    } catch (error) {
      const err = error as Error;
      this.status.error = err.message;
      this.running = false;
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // Handle room invites
    this.client.on(RoomMemberEvent.Membership, (event: any, member: any) => {
      if (member.membership === 'invite' && member.userId === this.client?.getUserId()) {
        if (this.autoJoin) {
          this.logger.info({ roomId: member.roomId }, 'Auto-joining room');
          this.client?.joinRoom(member.roomId).catch((err: Error) => {
            this.logger.error({ roomId: member.roomId, error: err.message }, 'Failed to join room');
          });
        }
      }
    });

    // Handle messages
    this.client.on(RoomEvent.Timeline, async (event: any, room: any, toStartOfTimeline: boolean) => {
      // Ignore old messages during initial sync
      if (toStartOfTimeline) return;

      // Only process text messages
      if (event.getType() !== 'm.room.message') return;

      const content = event.getContent();
      if (content.msgtype !== 'm.text') return;

      // Ignore our own messages
      if (event.getSender() === this.client?.getUserId()) return;

      await this.handleMessage(event, room!);
    });

    // Handle sync errors
    this.client.on(ClientEvent.SyncUnexpectedError, (error: Error) => {
      this.logger.error({ error: error.message }, 'Matrix sync error');
      this.status.error = error.message;
    });
  }

  private async handleMessage(event: any, room: any): Promise<void> {
    const roomId = room.roomId;
    const senderId = event.getSender();
    const content = event.getContent();
    const text = content.body;

    if (!senderId || !text) return;

    // Check if room is allowed
    if (this.allowedRooms && !this.allowedRooms.has(roomId)) {
      this.logger.debug({ roomId }, 'Ignoring message from non-allowed room');
      return;
    }

    // Check if this is a DM or mention
    const isDM = room.getJoinedMemberCount() === 2;
    const isMention = this.isBotMentioned(text);

    // Only respond to DMs or mentions in group chats
    if (!isDM && !isMention) {
      return;
    }

    // Clean up mention from text
    const cleanedText = isMention ? this.removeMention(text) : text;

    this.logger.info(
      { roomId, senderId, message: cleanedText.substring(0, 100), isDM, isMention },
      'Received message'
    );

    // Handle commands
    if (cleanedText.startsWith('!') || cleanedText.startsWith('/')) {
      await this.handleCommand(cleanedText, roomId);
      return;
    }

    // Process through agent
    await this.processMessage(cleanedText, senderId, roomId);
  }

  private isBotMentioned(text: string): boolean {
    const botUserId = this.client?.getUserId();
    if (!botUserId) return false;

    // Check for direct mention like @bot:matrix.org or display name
    return text.includes(botUserId) || text.toLowerCase().includes('scallopbot');
  }

  private removeMention(text: string): string {
    const botUserId = this.client?.getUserId();
    if (!botUserId) return text;

    return text
      .replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
      .replace(/scallopbot/gi, '')
      .replace(/^\s*[:,]?\s*/, '')
      .trim();
  }

  private async handleCommand(text: string, roomId: string): Promise<void> {
    const [command] = text.slice(1).split(' ');

    switch (command.toLowerCase()) {
      case 'help':
        await this.sendMessage(roomId, this.getHelpMessage());
        break;

      case 'reset':
        // For Matrix, we key sessions by room for simplicity
        await this.handleReset(roomId);
        await this.sendMessage(roomId, 'Conversation cleared. Starting fresh!');
        break;

      case 'status':
        await this.sendMessage(
          roomId,
          `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
        );
        break;

      default:
        await this.sendMessage(
          roomId,
          `Unknown command: ${text.charAt(0)}${command}\nType !help for available commands.`
        );
    }
  }

  private getHelpMessage(): string {
    return `**ScallopBot on Matrix**

I'm your personal AI assistant. In DMs, just send me a message. In group chats, mention me!

**Commands:**
- \`!help\` - Show this message
- \`!reset\` - Clear conversation history
- \`!status\` - Check bot status

Matrix bridges to many platforms, so you can reach me from anywhere!`;
  }

  private async processMessage(
    text: string,
    senderId: string,
    roomId: string
  ): Promise<void> {
    try {
      // Show typing indicator
      this.client?.sendTyping(roomId, true, 30000);

      // Get or create session (keyed by room for group context)
      const sessionId = await this.getOrCreateSession(roomId);

      // Process through agent
      const result = await this.agent.processMessage(sessionId, text);

      // Stop typing indicator
      this.client?.sendTyping(roomId, false, 0);

      // Send response with markdown formatting
      await this.sendMessage(roomId, result.response, true);

      this.logger.info(
        { roomId, senderId, responseLength: result.response.length, tokens: result.tokenUsage },
        'Sent response'
      );
    } catch (error) {
      const err = error as Error;
      this.logger.error({ roomId, senderId, error: err.message }, 'Failed to process message');
      await this.sendMessage(roomId, 'Sorry, I encountered an error. Please try again.');
    }
  }

  private async sendMessage(
    roomId: string,
    message: string,
    markdown: boolean = true
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Matrix not connected');
    }

    // Matrix has a message size limit, but it's generous (65535 bytes)
    // Still split very long messages for better UX
    const MAX_LENGTH = 4000;
    const chunks = this.splitMessage(message, MAX_LENGTH);

    for (const chunk of chunks) {
      if (markdown) {
        // Send as formatted message with markdown
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: chunk,
          format: 'org.matrix.custom.html',
          formatted_body: this.markdownToHtml(chunk),
        });
      } else {
        await this.client.sendTextMessage(roomId, chunk);
      }
    }
  }

  private markdownToHtml(text: string): string {
    // Simple markdown to HTML conversion
    return text
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Line breaks
      .replace(/\n/g, '<br/>');
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

    this.logger.info('Stopping Matrix channel...');
    this.running = false;

    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }

    this.status.connected = false;
    this.logger.info('Matrix channel stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): ChannelStatus {
    return { ...this.status, lastActivity: new Date() };
  }

  async getOrCreateSession(roomId: string): Promise<string> {
    const cached = this.userSessions.get(roomId);
    if (cached) {
      const session = await this.sessionManager.getSession(cached);
      if (session) {
        return cached;
      }
    }

    const session = await this.sessionManager.createSession({
      userId: roomId, // Use roomId as userId for Matrix (room-based sessions)
      channelId: 'matrix',
    });

    this.userSessions.set(roomId, session.id);
    return session.id;
  }

  async handleReset(roomId: string): Promise<void> {
    const sessionId = this.userSessions.get(roomId);
    if (sessionId) {
      await this.sessionManager.deleteSession(sessionId);
      this.userSessions.delete(roomId);
    }
  }
}
