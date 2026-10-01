/**
 * Shared plumbing for the chat adapters (Discord, Slack, WhatsApp, Signal,
 * Matrix): channel-prefixed sessions that survive restarts, per-conversation
 * turn serialization, approval-aware reply text, and the proactive-delivery
 * contract the gateway registers as a trigger source.
 */

import type { Logger } from 'pino';
import type { AgentResult } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { MessageDeliveryResult } from '../triggers/types.js';
import type { Channel } from './types.js';

/** Engagement hook (same shape the gateway hands to Telegram and the API). */
export type ChatUserMessageHook = (prefixedUserId: string, userMessage?: string) => unknown;

/**
 * A chat channel the gateway can start, stop, and use for proactive delivery
 * (reminders, scheduled items, sub-agent results).
 */
export interface ProactiveChatChannel extends Channel {
  sendMessage(recipient: string, message: string): Promise<MessageDeliveryResult>;
  sendFile(recipient: string, filePath: string, caption?: string): Promise<boolean>;
  /** False when an allowlist is configured and the recipient is not on it. */
  isAllowedRecipient(recipient: string): boolean;
  /** The only allowlisted recipient, or null when there is not exactly one. */
  soleRecipient(): string | null;
}

/** Reply text for a finished turn; a pending approval is answered by "yes"/"no". */
export function renderAgentReply(result: Pick<AgentResult, 'response' | 'pendingApproval'>): string {
  const pending = result.pendingApproval;
  const response = result.response?.trim() ?? '';
  if (!pending) return response;
  const body = response || pending.question;
  return `${body}\n\n(Reply "yes" to allow or "no" to cancel.)`;
}

/**
 * Sessions keyed by `<channel>:<id>` so trigger routing (reminders, proactive
 * messages) can find the way back, rehydrated from the DB after a restart.
 */
export class ChannelSessions {
  private cache = new Map<string, string>();

  constructor(
    private readonly channelId: string,
    private readonly sessionManager: SessionManager,
    private readonly db?: Pick<ScallopDatabase, 'findSessionByUserId'>,
  ) {}

  prefixed(id: string): string {
    return `${this.channelId}:${id}`;
  }

  async get(id: string): Promise<string> {
    const cached = this.cache.get(id);
    if (cached && await this.sessionManager.getSession(cached)) return cached;

    const userId = this.prefixed(id);
    const existing = this.db?.findSessionByUserId(userId, this.channelId);
    if (existing && await this.sessionManager.getSession(existing.id)) {
      this.cache.set(id, existing.id);
      return existing.id;
    }

    const session = await this.sessionManager.createSession({ userId, channelId: this.channelId });
    this.cache.set(id, session.id);
    return session.id;
  }

  async reset(id: string): Promise<void> {
    const session = await this.sessionManager.startNewSession(
      { userId: this.prefixed(id), channelId: this.channelId },
      this.cache.get(id),
    );
    this.cache.set(id, session.id);
  }

  peek(id: string): string | undefined {
    return this.cache.get(id);
  }
}

/** Runs tasks one at a time per key, so one conversation never has two turns in flight. */
export class KeyedSerialQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Fire the engagement hook without letting analytics failures break chat. */
export async function notifyUserMessage(
  hook: ChatUserMessageHook | undefined,
  prefixedUserId: string,
  text: string,
  logger: Logger,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(prefixedUserId, text);
  } catch (error) {
    logger.warn({ prefixedUserId, error: (error as Error).message }, 'User-message engagement hook failed');
  }
}

/** Split text at paragraph, line, then word boundaries to fit a platform limit. */
export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) splitIndex = remaining.lastIndexOf(' ', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) splitIndex = maxLength;
    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }
  return chunks.filter(Boolean);
}

/** Exactly-one allowlist entry, used to resolve the `default` recipient. */
export function soleEntry(allowlist: ReadonlySet<string> | null): string | null {
  if (!allowlist || allowlist.size !== 1) return null;
  return allowlist.values().next().value ?? null;
}
