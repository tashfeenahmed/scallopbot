import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BranchManager,
  Branch,
  BranchState,
  summarizeBranch,
  mergeBranches,
} from './branching.js';
import type { Message } from '../providers/types.js';
import type { Logger } from 'pino';

describe('Branch', () => {
  describe('creation', () => {
    it('should create a branch with unique id', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Investigation',
      });

      expect(branch.id).toBeDefined();
      expect(branch.parentSessionId).toBe('session-123');
      expect(branch.name).toBe('Investigation');
    });

    it('should start with empty messages', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      expect(branch.messages).toEqual([]);
    });

    it('should have active state initially', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      expect(branch.state).toBe('active');
    });
  });

  describe('messages', () => {
    it('should add messages to branch', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      branch.addMessage({ role: 'user', content: 'Hello' });
      branch.addMessage({ role: 'assistant', content: 'Hi there!' });

      expect(branch.messages).toHaveLength(2);
    });

    it('should track message count', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      branch.addMessage({ role: 'user', content: 'Hello' });
      branch.addMessage({ role: 'assistant', content: 'Hi!' });
      branch.addMessage({ role: 'user', content: 'How are you?' });

      expect(branch.messageCount).toBe(3);
    });
  });

  describe('state transitions', () => {
    it('should transition to merged state', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      branch.setState('merged');

      expect(branch.state).toBe('merged');
    });

    it('should transition to discarded state', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      branch.setState('discarded');

      expect(branch.state).toBe('discarded');
    });

    it('should not allow adding messages after merge', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });

      branch.setState('merged');

      expect(() => {
        branch.addMessage({ role: 'user', content: 'New message' });
      }).toThrow();
    });
  });

  describe('metadata', () => {
    it('should track creation timestamp', () => {
      const before = Date.now();
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
      });
      const after = Date.now();

      expect(branch.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(branch.createdAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('should store custom metadata', () => {
      const branch = new Branch({
        parentSessionId: 'session-123',
        name: 'Test',
        metadata: { purpose: 'debugging', priority: 'high' },
      });

      expect(branch.metadata?.purpose).toBe('debugging');
      expect(branch.metadata?.priority).toBe('high');
    });
  });
});

describe('BranchManager', () => {
  let manager: BranchManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    manager = new BranchManager({ logger: mockLogger });
  });

  describe('createBranch', () => {
    it('should create a new branch for session', () => {
      const branch = manager.createBranch('session-123', 'Investigation');

      expect(branch).toBeDefined();
      expect(branch.parentSessionId).toBe('session-123');
      expect(branch.name).toBe('Investigation');
    });

    it('should copy context messages to branch', () => {
      const contextMessages: Message[] = [
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ];

      const branch = manager.createBranch(
        'session-123',
        'Investigation',
        contextMessages
      );

      expect(branch.messages).toHaveLength(2);
    });

    it('should track branch in manager', () => {
      const branch = manager.createBranch('session-123', 'Test');

      expect(manager.getBranch(branch.id)).toBeDefined();
    });
  });

  describe('getBranchesForSession', () => {
    it('should return all branches for a session', () => {
      manager.createBranch('session-123', 'Branch 1');
      manager.createBranch('session-123', 'Branch 2');
      manager.createBranch('session-456', 'Branch 3');

      const branches = manager.getBranchesForSession('session-123');

      expect(branches).toHaveLength(2);
    });

    it('should return empty array for session with no branches', () => {
      const branches = manager.getBranchesForSession('unknown-session');

      expect(branches).toEqual([]);
    });
  });

  describe('mergeBranch', () => {
    it('should merge branch into parent session', async () => {
      const branch = manager.createBranch('session-123', 'Investigation');
      branch.addMessage({ role: 'user', content: 'Investigating issue' });
      branch.addMessage({ role: 'assistant', content: 'Found the problem' });

      const result = await manager.mergeBranch(branch.id);

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(branch.state).toBe('merged');
    });

    it('should return summary of branch findings', async () => {
      const branch = manager.createBranch('session-123', 'Investigation');
      branch.addMessage({ role: 'user', content: 'Check the logs' });
      branch.addMessage({
        role: 'assistant',
        content: 'I found an error in the authentication module',
      });

      const result = await manager.mergeBranch(branch.id);

      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('should fail for unknown branch', async () => {
      const result = await manager.mergeBranch('unknown-branch');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail for already merged branch', async () => {
      const branch = manager.createBranch('session-123', 'Test');
      await manager.mergeBranch(branch.id);

      const result = await manager.mergeBranch(branch.id);

      expect(result.success).toBe(false);
    });
  });

  describe('discardBranch', () => {
    it('should discard a branch', () => {
      const branch = manager.createBranch('session-123', 'Test');

      const success = manager.discardBranch(branch.id);

      expect(success).toBe(true);
      expect(branch.state).toBe('discarded');
    });

    it('should return false for unknown branch', () => {
      const success = manager.discardBranch('unknown-branch');

      expect(success).toBe(false);
    });
  });

  describe('getActiveBranches', () => {
    it('should return only active branches', () => {
      const branch1 = manager.createBranch('session-123', 'Active 1');
      const branch2 = manager.createBranch('session-123', 'Active 2');
      const branch3 = manager.createBranch('session-123', 'To Discard');

      manager.discardBranch(branch3.id);

      const active = manager.getActiveBranches('session-123');

      expect(active).toHaveLength(2);
      expect(active.map((b) => b.id)).toContain(branch1.id);
      expect(active.map((b) => b.id)).toContain(branch2.id);
    });
  });

  describe('cleanup', () => {
    it('should remove discarded branches older than threshold', () => {
      const branch = manager.createBranch('session-123', 'Test');
      manager.discardBranch(branch.id);

      // Simulate age by modifying createdAt (hack for testing)
      (branch as any)._createdAt = new Date(Date.now() - 86400001);

      manager.cleanup(86400000); // 24 hours

      expect(manager.getBranch(branch.id)).toBeUndefined();
    });

    it('should keep recent discarded branches', () => {
      const branch = manager.createBranch('session-123', 'Test');
      manager.discardBranch(branch.id);

      manager.cleanup(86400000); // 24 hours

      expect(manager.getBranch(branch.id)).toBeDefined();
    });
  });
});

describe('summarizeBranch', () => {
  it('should create summary from branch messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Can you check why the API is slow?' },
      {
        role: 'assistant',
        content: 'I analyzed the logs and found a database query taking 5 seconds.',
      },
      { role: 'user', content: 'Can you fix it?' },
      { role: 'assistant', content: 'I added an index and the query now takes 50ms.' },
    ];

    const summary = summarizeBranch(messages, 'Performance Investigation');

    expect(summary).toContain('Investigation');
    expect(summary.length).toBeLessThan(
      messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('').length
    );
  });

  it('should handle empty messages', () => {
    const summary = summarizeBranch([], 'Empty Branch');

    expect(summary).toBe('');
  });

  it('should include key findings', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'The bug was caused by a null pointer exception.' },
    ];

    const summary = summarizeBranch(messages, 'Bug Investigation');

    expect(summary).toContain('null pointer');
  });
});

describe('mergeBranches', () => {
  it('should combine summaries from multiple branches', () => {
    const summaries = [
      'Investigation 1: Found memory leak in worker process',
      'Investigation 2: Identified slow database queries',
    ];

    const merged = mergeBranches(summaries);

    expect(merged).toContain('memory leak');
    expect(merged).toContain('database queries');
  });

  it('should handle single branch', () => {
    const summaries = ['Single finding about the issue'];

    const merged = mergeBranches(summaries);

    expect(merged).toBe('Single finding about the issue');
  });

  it('should handle empty array', () => {
    const merged = mergeBranches([]);

    expect(merged).toBe('');
  });
});
