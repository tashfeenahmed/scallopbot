import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pino } from 'pino';
import type { CompletionResponse, LLMProvider, Message } from '../providers/types.js';

// Mock provider that simulates LLM responses
function createMockProvider(responses: CompletionResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex];
      callIndex++;
      return response;
    }),
  };
}

describe('Agent', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-agent-test-'));
    sessionsDir = path.join(testDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('processMessage', () => {
    it('should process simple user message and return response', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      const provider = createMockProvider([
        {
          content: [{ type: 'text', text: 'Hello! How can I help you?' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 8 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Hello');

      expect(result.response).toBe('Hello! How can I help you?');
      expect(provider.complete).toHaveBeenCalledTimes(1);
    });

    it('should execute tool and continue conversation', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
            
      // Create a test file
      const testFile = path.join(testDir, 'test.txt');
      await fs.writeFile(testFile, 'Test content');

      const provider = createMockProvider([
        // First response: tool use
        {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'read',
              input: { path: testFile },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 20, outputTokens: 15 },
          model: 'test-model',
        },
        // Second response: final answer
        {
          content: [{ type: 'text', text: 'The file contains: Test content' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 30, outputTokens: 10 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
                  const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Read the test file');

      expect(result.response).toBe('The file contains: Test content');
      expect(provider.complete).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple tool calls in sequence', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
                  
      const testFile = path.join(testDir, 'output.txt');

      const provider = createMockProvider([
        // First: write file
        {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'write',
              input: { path: testFile, content: 'New content' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 20, outputTokens: 15 },
          model: 'test-model',
        },
        // Second: read file
        {
          content: [
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'read',
              input: { path: testFile },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 30, outputTokens: 15 },
          model: 'test-model',
        },
        // Third: final answer
        {
          content: [{ type: 'text', text: 'I created and verified the file.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 40, outputTokens: 10 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
                        const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Create a file and verify it');

      expect(result.response).toBe('I created and verified the file.');
      expect(provider.complete).toHaveBeenCalledTimes(3);
    });

    it('should stop at max iterations to prevent infinite loops', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
            
      // Provider that always returns tool use (infinite loop scenario)
      const infiniteProvider: LLMProvider = {
        name: 'infinite',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [
            {
              type: 'tool_use',
              id: 'tool-infinite',
              name: 'bash',
              input: { command: 'echo loop' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'test-model',
        }),
      };

      const sessionManager = new SessionManager(sessionsDir);
                  const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider: infiniteProvider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 5, // Low limit for testing
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Loop forever');

      // Should have stopped due to max iterations
      expect(result.response).toContain('maximum iterations');
      expect(infiniteProvider.complete).toHaveBeenCalledTimes(5);
    });

    it('should handle tool execution errors gracefully', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
            
      const provider = createMockProvider([
        // Try to read non-existent file
        {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'read',
              input: { path: '/nonexistent/file.txt' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 20, outputTokens: 15 },
          model: 'test-model',
        },
        // Handle error and respond
        {
          content: [{ type: 'text', text: 'The file does not exist.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 30, outputTokens: 10 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
                  const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Read nonexistent file');

      expect(result.response).toBe('The file does not exist.');
    });

    it('should handle unknown tool gracefully', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      const provider = createMockProvider([
        // Try to use unknown tool
        {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'unknown_tool',
              input: {},
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 20, outputTokens: 15 },
          model: 'test-model',
        },
        // Handle error and respond
        {
          content: [{ type: 'text', text: 'I apologize, that tool is not available.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 30, outputTokens: 10 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Use unknown tool');

      expect(result.response).toBe('I apologize, that tool is not available.');
    });

    it('should include system prompt with workspace context', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      const provider = createMockProvider([
        {
          content: [{ type: 'text', text: 'Response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
        systemPrompt: 'You are a helpful assistant.',
      });

      const session = await sessionManager.createSession();
      await agent.processMessage(session.id, 'Hello');

      const callArgs = (provider.complete as any).mock.calls[0][0];
      expect(callArgs.system).toContain('You are a helpful assistant.');
      expect(callArgs.system).toContain(testDir);
    });

    it('should load SOUL.md if present in workspace', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      // Create SOUL.md
      const soulContent = 'Always be friendly and helpful.';
      await fs.writeFile(path.join(testDir, 'SOUL.md'), soulContent);

      const provider = createMockProvider([
        {
          content: [{ type: 'text', text: 'Response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      await agent.processMessage(session.id, 'Hello');

      const callArgs = (provider.complete as any).mock.calls[0][0];
      expect(callArgs.system).toContain(soulContent);
    });

    it('should track token usage in session', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      const provider = createMockProvider([
        {
          content: [{ type: 'text', text: 'Response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'test-model',
        },
      ]);

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();
      const result = await agent.processMessage(session.id, 'Hello');

      expect(result.tokenUsage.inputTokens).toBe(100);
      expect(result.tokenUsage.outputTokens).toBe(50);

      // Check session has updated usage
      const updatedSession = await sessionManager.getSession(session.id);
      expect(updatedSession?.tokenUsage?.inputTokens).toBe(100);
    });

    it('should preserve conversation history', async () => {
      const { Agent } = await import('./agent.js');
      const { SessionManager } = await import('./session.js');
      
      const provider: LLMProvider = {
        name: 'history-check',
        isAvailable: () => true,
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'test-model',
        }),
      };

      const sessionManager = new SessionManager(sessionsDir);
            const logger = pino({ level: 'silent' });

      const agent = new Agent({
        provider,
        sessionManager,
                workspace: testDir,
        logger,
        maxIterations: 20,
      });

      const session = await sessionManager.createSession();

      // First message
      await agent.processMessage(session.id, 'First message');

      // Second message - should include first message in history
      await agent.processMessage(session.id, 'Second message');

      const secondCallArgs = (provider.complete as any).mock.calls[1][0];
      expect(secondCallArgs.messages.length).toBeGreaterThan(1);
      expect(secondCallArgs.messages[0].content).toBe('First message');
    });
  });
});
