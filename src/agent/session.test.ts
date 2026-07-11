import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { Message } from '../providers/types.js';
import { ScallopDatabase } from '../memory/db.js';
import { classifySessionMessage } from '../memory/session-message-view.js';

describe('SessionManager', () => {
  let dbPath: string;
  let db: ScallopDatabase;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `scallopbot-session-test-${Date.now()}.db`);
    db = new ScallopDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    // Clean up SQLite files
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  describe('createSession', () => {
    it('should create a new session with unique ID', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();

      expect(session.id).toBeDefined();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeDefined();
    });

    it('should create session with metadata', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession({ userId: 'user123' });

      expect(session.metadata?.userId).toBe('user123');
    });

    it('should persist session to SQLite', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      const row = db.getSession(session.id);

      expect(row).toBeDefined();
      expect(row!.id).toBe(session.id);
    });
  });

  describe('addMessage', () => {
    it('should add message to session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      const message: Message = { role: 'user', content: 'Hello' };

      await manager.addMessage(session.id, message);

      const loaded = await manager.getSession(session.id);
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Hello');
    });

    it('should store messages in SQLite', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();

      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Second' });

      const rows = db.getSessionMessages(session.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].content).toBe('First');
      expect(rows[1].content).toBe('Second');
    });

    it('keeps human JSON-shaped text visible while classifying structured tool results', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);
      const session = await manager.createSession({ userId: 'api:user1', channelId: 'api' });
      const literal = JSON.stringify([
        { type: 'tool_result', tool_use_id: 'not-a-real-call', content: 'literal user text' },
      ]);

      await manager.addMessage(session.id, { role: 'user', content: literal });
      await manager.addMessage(session.id, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'real-call', content: 'private result' }],
      });

      const rows = db.getSessionMessages(session.id);
      expect(rows.map(row => row.messageKind)).toEqual(['human_user', 'tool_result']);
      expect(classifySessionMessage(rows[0])).toMatchObject({
        isHumanTurn: true,
        isHumanVisible: true,
        visibleText: literal,
      });
      expect(classifySessionMessage(rows[1]).isHumanVisible).toBe(false);
    });

    it('should throw error for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      await expect(
        manager.addMessage('nonexistent', { role: 'user', content: 'test' })
      ).rejects.toThrow();
    });
  });

  describe('getSession', () => {
    it('should retrieve existing session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const created = await manager.createSession();
      await manager.addMessage(created.id, { role: 'user', content: 'Test' });

      const retrieved = await manager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.messages).toHaveLength(1);
    });

    it('should return undefined for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.getSession('nonexistent');

      expect(session).toBeUndefined();
    });

    it('should preserve message history across restarts', async () => {
      const { SessionManager } = await import('./session.js');

      // First manager instance
      const manager1 = new SessionManager(db);
      const session = await manager1.createSession();
      await manager1.addMessage(session.id, { role: 'user', content: 'Before restart' });

      // Simulate restart with new manager instance (same db)
      const manager2 = new SessionManager(db);
      const loaded = await manager2.getSession(session.id);

      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Before restart');
    });
  });

  describe('deleteSession', () => {
    it('should hide a confirmed-forgotten session but retain its tombstone', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      await manager.addMessage(session.id, { role: 'user', content: 'private' });
      await manager.deleteSession(session.id, { confirmed: true });

      const row = db.getSession(session.id);
      expect(row?.transcriptDeletedAt).not.toBeNull();
      expect(db.getSessionMessages(session.id)).toEqual([]);
      expect(db.getSessionLifecycleEvents(session.id)).toMatchObject([
        { action: 'forgotten', messageCount: 1 },
      ]);
    });

    it('should return true when session is deleted', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      const result = await manager.deleteSession(session.id, { confirmed: true });

      expect(result).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const result = await manager.deleteSession('nonexistent', { confirmed: true });

      expect(result).toBe(false);
    });

    it('should reject destructive deletion without explicit confirmation', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);
      const session = await manager.createSession();

      await expect(manager.deleteSession(session.id)).rejects.toThrow('explicit confirmation');
      expect(await manager.getSession(session.id)).toBeDefined();
    });

    it('should retain a durable summary after confirmed transcript deletion', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);
      const session = await manager.createSession({ userId: 'user123' });
      await manager.addMessage(session.id, { role: 'user', content: 'Please remember this outcome' });
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user123',
        summary: 'The user asked to remember an outcome.',
        topics: ['outcome'],
        messageCount: 1,
        durationMs: 0,
        embedding: null,
      });

      await manager.deleteSession(session.id, { confirmed: true });

      expect(db.getSessionSummary(session.id)?.summary).toContain('remember an outcome');
    });

    it('idempotently forgets both hot and cold transcript copies after retention pruning', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);
      const session = await manager.createSession({ userId: 'user123' });
      await manager.addMessage(session.id, { role: 'user', content: 'Remove every transcript copy' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'I will remove it after confirmation.' });
      db.addSessionSummary({
        sessionId: session.id,
        userId: 'user123',
        summary: 'A durable summary that must survive forgetting.',
        topics: ['retention'],
        messageCount: 2,
        durationMs: 0,
        embedding: null,
      }, {
        verifier: 'session_summarizer',
        verificationVersion: 1,
      });
      await manager.archiveSession(session.id, 'closed', 'test');
      db.raw('UPDATE sessions SET updated_at = ? WHERE id = ? RETURNING id', [
        Date.now() - 31 * 24 * 60 * 60 * 1000,
        session.id,
      ]);
      expect(db.pruneOldSessions(30)).toBe(1);
      expect(db.getSessionMessages(session.id)).toEqual([]);
      expect(db.getArchivedSessionMessages(session.id)).toHaveLength(2);

      await expect(manager.deleteSession(session.id, { confirmed: true })).resolves.toBe(true);
      await expect(manager.deleteSession(session.id, { confirmed: true })).resolves.toBe(true);

      expect(db.getSessionMessages(session.id)).toEqual([]);
      expect(db.getArchivedSessionMessages(session.id)).toEqual([]);
      expect(db.getSessionSummary(session.id)?.summary).toContain('must survive');
      expect(db.getSessionLifecycleEvents(session.id).map(event => event.action)).toEqual([
        'archived',
        'transcript_pruned',
        'forgotten',
      ]);
      expect(db.getSessionLifecycleEvents(session.id).at(-1)?.messageCount).toBe(2);
    });
  });

  describe('startNewSession', () => {
    it('archives history and force-creates a different active session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);
      const old = await manager.createSession({ userId: 'telegram:user123', channelId: 'telegram' });
      await manager.addMessage(old.id, { role: 'user', content: 'Keep this history' });
      const worker = await manager.createSession({
        userId: 'telegram:user123',
        channelId: 'telegram',
        isSubAgent: true,
        parentSessionId: old.id,
      });

      const fresh = await manager.startNewSession({
        userId: 'telegram:user123',
        channelId: 'telegram',
        id: old.id,
      }, old.id);

      expect(fresh.id).not.toBe(old.id);
      expect(await manager.getSession(old.id)).toBeUndefined();
      expect(db.getSessionMessages(old.id).map(message => message.content)).toEqual(['Keep this history']);
      expect(db.getSession(old.id)?.archiveReason).toBe('new_conversation');
      expect(await manager.getSession(worker.id)).toBeDefined();
      await manager.addMessage(worker.id, { role: 'assistant', content: 'Worker finished after reset' });
      expect(db.findSessionByUserId('telegram:user123', 'telegram')?.id).toBe(fresh.id);
      expect(db.getSessionLifecycleEvents(old.id)).toMatchObject([
        { action: 'archived', actor: 'user_command', messageCount: 1 },
      ]);
    });

    it('does not resume an older session when /new arrives after restart', async () => {
      const { SessionManager } = await import('./session.js');
      const firstManager = new SessionManager(db);
      const old = await firstManager.createSession({ userId: 'telegram:user123', channelId: 'telegram' });
      await firstManager.addMessage(old.id, { role: 'user', content: 'Old turn' });

      const restartedManager = new SessionManager(db);
      const fresh = await restartedManager.startNewSession({
        userId: 'telegram:user123',
        channelId: 'telegram',
      });

      expect(fresh.id).not.toBe(old.id);
      expect(db.findSessionByUserId('telegram:user123')?.id).toBe(fresh.id);
      expect(db.getSessionMessages(old.id)).toHaveLength(1);
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      await manager.createSession();
      await manager.createSession();
      await manager.createSession();

      const sessions = await manager.listSessions();

      expect(sessions).toHaveLength(3);
    });

    it('should return empty array when no sessions', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const sessions = await manager.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('updateMetadata', () => {
    it('should update session metadata', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      await manager.updateMetadata(session.id, { lastTool: 'bash' });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.metadata?.lastTool).toBe('bash');
    });
  });

  describe('token tracking', () => {
    it('should track token usage', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      await manager.recordTokenUsage(session.id, { inputTokens: 100, outputTokens: 50 });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.tokenUsage?.inputTokens).toBe(100);
      expect(loaded?.tokenUsage?.outputTokens).toBe(50);
    });

    it('should accumulate token usage', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      await manager.recordTokenUsage(session.id, { inputTokens: 100, outputTokens: 50 });
      await manager.recordTokenUsage(session.id, { inputTokens: 200, outputTokens: 100 });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.tokenUsage?.inputTokens).toBe(300);
      expect(loaded?.tokenUsage?.outputTokens).toBe(150);
    });
  });
});
