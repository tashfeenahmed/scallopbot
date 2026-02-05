import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { Message } from '../providers/types.js';
import { ScallopDatabase } from '../memory/db.js';

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
    it('should delete session from SQLite', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      await manager.deleteSession(session.id);

      const row = db.getSession(session.id);
      expect(row).toBeNull();
    });

    it('should return true when session is deleted', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const session = await manager.createSession();
      const result = await manager.deleteSession(session.id);

      expect(result).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(db);

      const result = await manager.deleteSession('nonexistent');

      expect(result).toBe(false);
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
