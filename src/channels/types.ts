/**
 * Channel types and interfaces
 *
 * All channel implementations should follow these interfaces
 * for consistent behavior across messaging platforms.
 */

import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';

/**
 * Base configuration for all channels
 */
export interface BaseChannelConfig {
  agent: Agent;
  sessionManager: SessionManager;
  logger: Logger;
}

/**
 * Message received from a channel
 */
export interface IncomingMessage {
  id: string;
  userId: string;
  channelId: string;
  content: string;
  timestamp: Date;
  replyTo?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Attachment types
 */
export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'file' | 'voice';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
  size?: number;
}

/**
 * Message to send through a channel
 */
export interface OutgoingMessage {
  content: string;
  replyTo?: string;
  attachments?: Attachment[];
  format?: 'text' | 'markdown' | 'html';
}

/**
 * Channel status
 */
export interface ChannelStatus {
  connected: boolean;
  authenticated: boolean;
  error?: string;
  lastActivity?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Channel interface that all implementations must follow
 */
export interface Channel {
  /** Unique channel identifier */
  readonly name: string;

  /** Start the channel (connect, authenticate, etc.) */
  start(): Promise<void>;

  /** Stop the channel gracefully */
  stop(): Promise<void>;

  /** Check if channel is running */
  isRunning(): boolean;

  /** Get channel status */
  getStatus(): ChannelStatus;

  /** Get or create session for a user */
  getOrCreateSession(userId: string): Promise<string>;

  /** Handle session reset for a user */
  handleReset(userId: string): Promise<void>;
}

/**
 * Channel that supports sending messages programmatically
 */
export interface SendableChannel extends Channel {
  /** Send a message to a user/chat */
  sendMessage(chatId: string, message: OutgoingMessage): Promise<void>;
}

/**
 * Channel that supports voice messages
 */
export interface VoiceChannel extends Channel {
  /** Check if voice is supported */
  supportsVoice(): boolean;

  /** Handle incoming voice message - signature varies by channel */
  handleVoiceMessage?(...args: unknown[]): Promise<string>;
}

/**
 * Channel factory function type
 */
export type ChannelFactory<T extends BaseChannelConfig> = (config: T) => Channel;

/**
 * Channel registry entry
 */
export interface ChannelRegistryEntry {
  name: string;
  factory: ChannelFactory<any>;
  configSchema?: Record<string, unknown>;
}
