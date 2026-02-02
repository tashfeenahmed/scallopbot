import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '../providers/types.js';

describe('SessionManager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-session-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('should create a new session with unique ID', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();

      expect(session.id).toBeDefined();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeDefined();
    });

    it('should create session with metadata', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession({ userId: 'user123' });

      expect(session.metadata?.userId).toBe('user123');
    });

    it('should create JSONL file for new session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      const filePath = path.join(testDir, `${session.id}.jsonl`);

      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('addMessage', () => {
    it('should add message to session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      const message: Message = { role: 'user', content: 'Hello' };

      await manager.addMessage(session.id, message);

      const loaded = await manager.getSession(session.id);
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Hello');
    });

    it('should append to JSONL file', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();

      await manager.addMessage(session.id, { role: 'user', content: 'First' });
      await manager.addMessage(session.id, { role: 'assistant', content: 'Second' });

      const filePath = path.join(testDir, `${session.id}.jsonl`);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      // First line is session metadata, then messages
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it('should throw error for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      await expect(
        manager.addMessage('nonexistent', { role: 'user', content: 'test' })
      ).rejects.toThrow();
    });
  });

  describe('getSession', () => {
    it('should retrieve existing session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const created = await manager.createSession();
      await manager.addMessage(created.id, { role: 'user', content: 'Test' });

      const retrieved = await manager.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.messages).toHaveLength(1);
    });

    it('should return undefined for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.getSession('nonexistent');

      expect(session).toBeUndefined();
    });

    it('should preserve message history across restarts', async () => {
      const { SessionManager } = await import('./session.js');

      // First manager instance
      const manager1 = new SessionManager(testDir);
      const session = await manager1.createSession();
      await manager1.addMessage(session.id, { role: 'user', content: 'Before restart' });

      // Simulate restart with new manager instance
      const manager2 = new SessionManager(testDir);
      const loaded = await manager2.getSession(session.id);

      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.messages[0].content).toBe('Before restart');
    });
  });

  describe('deleteSession', () => {
    it('should delete session and its file', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      const filePath = path.join(testDir, `${session.id}.jsonl`);

      await manager.deleteSession(session.id);

      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should return true when session is deleted', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      const result = await manager.deleteSession(session.id);

      expect(result).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const result = await manager.deleteSession('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      await manager.createSession();
      await manager.createSession();
      await manager.createSession();

      const sessions = await manager.listSessions();

      expect(sessions).toHaveLength(3);
    });

    it('should return empty array when no sessions', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const sessions = await manager.listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('updateMetadata', () => {
    it('should update session metadata', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      await manager.updateMetadata(session.id, { lastTool: 'bash' });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.metadata?.lastTool).toBe('bash');
    });
  });

  describe('token tracking', () => {
    it('should track token usage', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      await manager.recordTokenUsage(session.id, { inputTokens: 100, outputTokens: 50 });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.tokenUsage?.inputTokens).toBe(100);
      expect(loaded?.tokenUsage?.outputTokens).toBe(50);
    });

    it('should accumulate token usage', async () => {
      const { SessionManager } = await import('./session.js');
      const manager = new SessionManager(testDir);

      const session = await manager.createSession();
      await manager.recordTokenUsage(session.id, { inputTokens: 100, outputTokens: 50 });
      await manager.recordTokenUsage(session.id, { inputTokens: 200, outputTokens: 100 });

      const loaded = await manager.getSession(session.id);
      expect(loaded?.tokenUsage?.inputTokens).toBe(300);
      expect(loaded?.tokenUsage?.outputTokens).toBe(150);
    });
  });
});
