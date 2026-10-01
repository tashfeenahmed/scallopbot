/**
 * Matrix Channel using matrix-js-sdk
 *
 * Matrix is an open protocol that can bridge to many other platforms.
 * Works with any homeserver (matrix.org, self-hosted Synapse/Dendrite, ...).
 *
 * Required config:
 * - MATRIX_HOMESERVER_URL (e.g., https://matrix.org)
 * - MATRIX_ACCESS_TOKEN (the bot account's token; MATRIX_USER_ID is optional)
 *
 * Limitation: no end-to-end encryption support. The bot only reads
 * unencrypted rooms; encrypted messages are logged and skipped.
 *
 * Note: Requires optional dependency matrix-js-sdk
 */

import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { ChannelStatus } from './types.js';
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

const MAX_MESSAGE_LENGTH = 4000;
const INITIAL_SYNC_TIMEOUT_MS = 60_000;
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};

export interface MatrixChannelOptions {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
  homeserverUrl: string;
  accessToken?: string;
  userId?: string;
  password?: string;
  deviceId?: string;
  autoJoin?: boolean; // Auto-join rooms when invited (by an allowed user)
  allowedRooms?: string[]; // If set, only respond in these rooms
  /** Matrix user IDs allowed to talk to the bot. Empty/undefined = allow all */
  allowedUsers?: string[];
  /** Rehydrates sessions after a restart */
  db?: Pick<ScallopDatabase, 'findSessionByUserId'>;
  onUserMessage?: ChatUserMessageHook;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class MatrixChannel implements ProactiveChatChannel {
  public readonly name = 'matrix';

  private agent: Agent;
  private logger: Logger;
  private homeserverUrl: string;
  private accessToken?: string;
  private userId?: string;
  private password?: string;
  private deviceId?: string;
  private autoJoin: boolean;
  private allowedRooms: Set<string> | null;
  private allowedUsers: Set<string> | null;
  private onUserMessage?: ChatUserMessageHook;

  private client: any = null;
  private sessions: ChannelSessions;
  private turns = new KeyedSerialQueue();
  private running = false;
  private synced = false;
  private startedAt = 0;
  private warnedEncryptedRooms = new Set<string>();
  private status: ChannelStatus = {
    connected: false,
    authenticated: false,
  };

  constructor(options: MatrixChannelOptions) {
    this.agent = options.agent;
    this.logger = options.logger.child({ channel: 'matrix' });
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken || undefined;
    this.userId = options.userId || undefined;
    this.password = options.password;
    this.deviceId = options.deviceId;
    this.autoJoin = options.autoJoin ?? true;
    this.allowedRooms = options.allowedRooms?.length ? new Set(options.allowedRooms) : null;
    this.allowedUsers = options.allowedUsers?.length ? new Set(options.allowedUsers) : null;
    this.onUserMessage = options.onUserMessage;
    this.sessions = new ChannelSessions('matrix', options.sessionManager, options.db);
  }

  /** Proactive recipients are rooms (sessions are keyed by room). */
  isAllowedRecipient(roomId: string): boolean {
    return !this.allowedRooms || this.allowedRooms.has(roomId);
  }

  soleRecipient(): string | null {
    return soleEntry(this.allowedRooms);
  }

  private isAllowedSender(senderId: string): boolean {
    return !this.allowedUsers || this.allowedUsers.has(senderId);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.synced = false;
    this.startedAt = Date.now();
    this.logger.info({ homeserver: this.homeserverUrl }, 'Starting Matrix channel...');

    try {
      const depsLoaded = await loadMatrixDeps();
      if (!depsLoaded) {
        this.status.error = 'Matrix dependencies not installed. Run: npm install matrix-js-sdk';
        throw new Error(this.status.error);
      }

      // Login with password if no access token but have credentials
      if (!this.accessToken && this.userId && this.password) {
        const loginClient = sdk.createClient({ baseUrl: this.homeserverUrl });
        const loginResponse = await loginClient.login('m.login.password', {
          user: this.userId,
          password: this.password,
          device_id: this.deviceId,
        });
        this.accessToken = loginResponse.access_token;
        this.userId = loginResponse.user_id ?? this.userId;
        this.deviceId = loginResponse.device_id ?? this.deviceId;
        this.logger.info('Logged in to Matrix');
      }

      if (!this.accessToken) {
        throw new Error('Matrix access token (or user ID + password) is required');
      }

      // Resolve our own MXID when only a token was configured
      if (!this.userId) {
        const probe = sdk.createClient({ baseUrl: this.homeserverUrl, accessToken: this.accessToken });
        const whoami = await probe.whoami();
        this.userId = whoami.user_id;
        this.deviceId = this.deviceId ?? whoami.device_id;
      }

      this.client = sdk.createClient({
        baseUrl: this.homeserverUrl,
        accessToken: this.accessToken,
        userId: this.userId,
        deviceId: this.deviceId,
      });

      this.setupEventHandlers();

      // Listen before starting so the PREPARED state cannot be missed.
      const prepared = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for the initial Matrix sync')),
          INITIAL_SYNC_TIMEOUT_MS,
        );
        const onSync = (state: string) => {
          if (state === 'PREPARED') {
            clearTimeout(timer);
            this.client?.removeListener?.(ClientEvent.Sync, onSync);
            resolve();
          } else if (state === 'ERROR') {
            this.logger.warn('Matrix sync reported an error; retrying');
          }
        };
        this.client.on(ClientEvent.Sync, onSync);
      });

      await this.client.startClient({ initialSyncLimit: 10 });
      await prepared;

      this.synced = true;
      this.status.connected = true;
      this.status.authenticated = true;
      this.status.error = undefined;
      this.logger.info(
        { userId: this.userId, allowedUsers: this.allowedUsers?.size ?? 'all' },
        'Matrix channel started',
      );
    } catch (error) {
      const err = error as Error;
      this.status.error = err.message;
      this.running = false;
      this.client?.stopClient?.();
      this.client = null;
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // Handle room invites (only from allowed users when an allowlist is set)
    this.client.on(RoomMemberEvent.Membership, (event: any, member: any) => {
      if (member.membership !== 'invite' || member.userId !== this.client?.getUserId()) return;
      const inviter = event?.getSender?.();
      if (!this.autoJoin) return;
      if (this.allowedUsers && (!inviter || !this.allowedUsers.has(inviter))) {
        this.logger.info({ roomId: member.roomId, inviter }, 'Ignoring invite from user outside the Matrix allowlist');
        return;
      }
      this.logger.info({ roomId: member.roomId }, 'Auto-joining room');
      this.client?.joinRoom(member.roomId).catch((err: Error) => {
        this.logger.error({ roomId: member.roomId, error: err.message }, 'Failed to join room');
      });
    });

    this.client.on(RoomEvent.Timeline, async (event: any, room: any, toStartOfTimeline: boolean) => {
      await this.handleTimelineEvent(event, room, toStartOfTimeline);
    });

    this.client.on(ClientEvent.SyncUnexpectedError, (error: Error) => {
      this.logger.error({ error: error.message }, 'Matrix sync error');
      this.status.error = error.message;
    });
  }

  /** Exposed for tests: a RoomEvent.Timeline emission. */
  async handleTimelineEvent(event: any, room: any, toStartOfTimeline: boolean): Promise<void> {
    // Ignore back-pagination and everything replayed by the initial sync
    if (toStartOfTimeline || !this.synced || !room) return;
    if (typeof event.getTs === 'function' && event.getTs() < this.startedAt) return;

    // Ignore our own messages
    if (event.getSender() === this.client?.getUserId()) return;

    if (event.getType() === 'm.room.encrypted') {
      if (!this.warnedEncryptedRooms.has(room.roomId)) {
        this.warnedEncryptedRooms.add(room.roomId);
        this.logger.warn({ roomId: room.roomId }, 'Encrypted Matrix room is not supported; use an unencrypted room');
      }
      return;
    }

    if (event.getType() !== 'm.room.message') return;
    const content = event.getContent();
    if (content.msgtype !== 'm.text') return;

    await this.handleMessage(event, room);
  }

  private async handleMessage(event: any, room: any): Promise<void> {
    const roomId = room.roomId;
    const senderId = event.getSender();
    const content = event.getContent();
    const text = content.body;

    if (!senderId || !text) return;

    if (!this.isAllowedRecipient(roomId)) {
      this.logger.debug({ roomId }, 'Ignoring message from non-allowed room');
      return;
    }

    if (!this.isAllowedSender(senderId)) {
      this.logger.debug({ roomId, senderId }, 'Ignoring message from user outside the Matrix allowlist');
      return;
    }

    // Only respond to DMs or mentions in group chats
    const isDM = room.getJoinedMemberCount() === 2;
    const isMention = this.isBotMentioned(text);
    if (!isDM && !isMention) {
      return;
    }

    const cleanedText = isMention ? this.removeMention(text) : text;

    this.logger.info(
      { roomId, senderId, message: cleanedText.substring(0, 100), isDM, isMention },
      'Received message'
    );

    if (cleanedText.startsWith('!') || cleanedText.startsWith('/')) {
      await this.handleCommand(cleanedText, roomId);
      return;
    }

    await this.processMessage(cleanedText, senderId, roomId);
  }

  private isBotMentioned(text: string): boolean {
    const botUserId = this.client?.getUserId();
    if (!botUserId) return false;
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
        await this.sendRoomMessage(roomId, this.getHelpMessage());
        break;

      case 'reset':
      case 'new':
        // Sessions are keyed by room
        await this.handleReset(roomId);
        await this.sendRoomMessage(roomId, 'Started a new conversation. Your previous conversation is preserved.');
        break;

      case 'status':
        await this.sendRoomMessage(
          roomId,
          `Connected: ${this.status.connected}\nAuthenticated: ${this.status.authenticated}`
        );
        break;

      default:
        await this.sendRoomMessage(
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
- \`!reset\` - Preserve this conversation and start a new one
- \`!status\` - Check bot status`;
  }

  private async processMessage(text: string, senderId: string, roomId: string): Promise<void> {
    await this.turns.run(roomId, async () => {
      try {
        this.client?.sendTyping(roomId, true, 30000)?.catch?.(() => {});
        await notifyUserMessage(this.onUserMessage, this.sessions.prefixed(roomId), text, this.logger);

        const sessionId = await this.getOrCreateSession(roomId);
        const result = await this.agent.processMessage(sessionId, text);

        this.client?.sendTyping(roomId, false, 0)?.catch?.(() => {});
        await this.sendRoomMessage(roomId, renderAgentReply(result));

        this.logger.info(
          { roomId, senderId, responseLength: result.response.length, tokens: result.tokenUsage },
          'Sent response'
        );
      } catch (error) {
        const err = error as Error;
        this.logger.error({ roomId, senderId, error: err.message }, 'Failed to process message');
        await this.sendRoomMessage(roomId, 'Sorry, I encountered an error. Please try again.').catch(() => []);
      }
    });
  }

  private async sendRoomMessage(roomId: string, message: string): Promise<string[]> {
    if (!this.client) {
      throw new Error('Matrix not connected');
    }

    const eventIds: string[] = [];
    for (const chunk of splitText(message, MAX_MESSAGE_LENGTH)) {
      const res = await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: chunk,
        format: 'org.matrix.custom.html',
        formatted_body: this.markdownToHtml(chunk),
      });
      if (res?.event_id) eventIds.push(String(res.event_id));
    }
    return eventIds;
  }

  /** Proactive message to a room the bot already talks in. */
  async sendMessage(roomId: string, message: string): Promise<MessageDeliveryResult> {
    if (!this.running || !this.client) {
      this.logger.warn({ roomId }, 'Cannot send message - Matrix not running');
      return false;
    }
    if (roomId === 'default') {
      const sole = this.soleRecipient();
      if (!sole) return false;
      roomId = sole;
    }
    if (!this.isAllowedRecipient(roomId)) {
      this.logger.warn({ roomId }, 'Refusing proactive delivery outside the Matrix room allowlist');
      return false;
    }
    try {
      const messageIds = await this.sendRoomMessage(roomId, message);
      return { sent: true, channel: 'matrix', messageIds };
    } catch (error) {
      this.logger.error({ roomId, error: (error as Error).message }, 'Failed to send proactive message');
      return false;
    }
  }

  async sendFile(roomId: string, filePath: string, caption?: string): Promise<boolean> {
    if (!this.running || !this.client || !this.isAllowedRecipient(roomId)) return false;
    try {
      const data = await readFile(filePath);
      const name = basename(filePath);
      const mimetype = IMAGE_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      const upload = await this.client.uploadContent(data, { name, type: mimetype });
      await this.client.sendMessage(roomId, {
        msgtype: mimetype.startsWith('image/') ? 'm.image' : 'm.file',
        body: name,
        url: upload.content_uri,
        info: { mimetype, size: data.length },
      });
      if (caption) await this.sendRoomMessage(roomId, caption);
      return true;
    } catch (error) {
      this.logger.error({ roomId, filePath, error: (error as Error).message }, 'Failed to send file');
      return false;
    }
  }

  private markdownToHtml(text: string): string {
    // Simple markdown to HTML conversion on escaped text
    return escapeHtml(text)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br/>');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Matrix channel...');
    this.running = false;
    this.synced = false;

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
    return this.sessions.get(roomId);
  }

  async handleReset(roomId: string): Promise<void> {
    await this.sessions.reset(roomId);
  }
}
