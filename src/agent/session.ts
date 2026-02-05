import { nanoid } from 'nanoid';
import type { Message, TokenUsage } from '../providers/types.js';
import type { ScallopDatabase } from '../memory/db.js';

export interface SessionMetadata {
  userId?: string;
  channelId?: string;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: SessionMetadata;
  tokenUsage?: TokenUsage;
}

export class SessionManager {
  private db: ScallopDatabase;
  private cache: Map<string, Session> = new Map();

  constructor(db: ScallopDatabase) {
    this.db = db;
  }

  async createSession(metadata?: SessionMetadata): Promise<Session> {
    const id = nanoid();
    const now = Date.now();

    this.db.createSession(id, metadata as Record<string, unknown> | undefined);

    const session: Session = {
      id,
      messages: [],
      createdAt: new Date(now),
      updatedAt: new Date(now),
      metadata,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    };

    this.cache.set(id, session);
    return session;
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Serialize content: store as JSON string for ContentBlock[]
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);

    this.db.addSessionMessage(sessionId, message.role, content);

    session.messages.push(message);
    session.updatedAt = new Date();
    this.cache.set(sessionId, session);
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId);
    }

    const row = this.db.getSession(sessionId);
    if (!row) return undefined;

    const messageRows = this.db.getSessionMessages(sessionId);
    const messages: Message[] = messageRows.map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: this.deserializeContent(r.content),
    }));

    const session: Session = {
      id: row.id,
      messages,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      metadata: row.metadata as SessionMetadata | undefined,
      tokenUsage: {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      },
    };

    this.cache.set(sessionId, session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = this.db.deleteSession(sessionId);
    this.cache.delete(sessionId);
    return result;
  }

  async listSessions(): Promise<{ id: string; createdAt: Date }[]> {
    const rows = this.db.listSessions();
    return rows.map((r) => ({ id: r.id, createdAt: new Date(r.createdAt) }));
  }

  async updateMetadata(sessionId: string, metadata: Partial<SessionMetadata>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.db.updateSessionMetadata(sessionId, metadata as Record<string, unknown>);

    session.metadata = { ...session.metadata, ...metadata };
    session.updatedAt = new Date();
    this.cache.set(sessionId, session);
  }

  async recordTokenUsage(sessionId: string, usage: TokenUsage): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.db.updateSessionTokenUsage(sessionId, usage.inputTokens, usage.outputTokens);

    if (!session.tokenUsage) {
      session.tokenUsage = { inputTokens: 0, outputTokens: 0 };
    }
    session.tokenUsage.inputTokens += usage.inputTokens;
    session.tokenUsage.outputTokens += usage.outputTokens;
    session.updatedAt = new Date();
    this.cache.set(sessionId, session);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Deserialize content from SQLite storage.
   * If it's valid JSON array, parse it as ContentBlock[]; otherwise return as string.
   */
  private deserializeContent(content: string): string | Message['content'] {
    if (content.startsWith('[')) {
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }
    return content;
  }
}
