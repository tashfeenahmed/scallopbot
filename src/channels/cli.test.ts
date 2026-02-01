import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIChannel,
  CLIChannelOptions,
  formatOutput,
  parseCommand,
  getHelpMessage,
} from './cli.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Logger } from 'pino';

// Mock readline
vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  })),
}));

describe('CLIChannel', () => {
  let mockAgent: Agent;
  let mockSessionManager: SessionManager;
  let mockLogger: Logger;
  let channel: CLIChannel;
  let mockStdout: string[];
  let originalStdout: typeof process.stdout.write;

  beforeEach(() => {
    mockAgent = {
      processMessage: vi.fn().mockResolvedValue({
        response: 'Test response',
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        iterationsUsed: 1,
      }),
    } as unknown as Agent;

    mockSessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'session-123' }),
      getSession: vi.fn().mockResolvedValue({ id: 'session-123', messages: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;

    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    // Capture stdout
    mockStdout = [];
    originalStdout = process.stdout.write;
    process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
      mockStdout.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create CLI channel with options', () => {
      channel = new CLIChannel({
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
        enableColors: true,
      });

      expect(channel).toBeInstanceOf(CLIChannel);
    });

    it('should use default color setting when not specified', () => {
      channel = new CLIChannel({
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });

      expect(channel).toBeInstanceOf(CLIChannel);
    });
  });

  describe('parseCommand', () => {
    it('should parse /help command', () => {
      const result = parseCommand('/help');
      expect(result).toEqual({ command: 'help', args: '' });
    });

    it('should parse /reset command', () => {
      const result = parseCommand('/reset');
      expect(result).toEqual({ command: 'reset', args: '' });
    });

    it('should parse /exit command', () => {
      const result = parseCommand('/exit');
      expect(result).toEqual({ command: 'exit', args: '' });
    });

    it('should parse /quit command', () => {
      const result = parseCommand('/quit');
      expect(result).toEqual({ command: 'quit', args: '' });
    });

    it('should parse command with arguments', () => {
      const result = parseCommand('/model gpt-4');
      expect(result).toEqual({ command: 'model', args: 'gpt-4' });
    });

    it('should return null for non-command input', () => {
      const result = parseCommand('Hello, how are you?');
      expect(result).toBeNull();
    });

    it('should handle empty input', () => {
      const result = parseCommand('');
      expect(result).toBeNull();
    });
  });

  describe('formatOutput', () => {
    it('should format plain text', () => {
      const result = formatOutput('Hello world', false);
      expect(result).toBe('Hello world');
    });

    it('should preserve code blocks', () => {
      const input = '```javascript\nconsole.log("hello");\n```';
      const result = formatOutput(input, false);
      expect(result).toContain('console.log("hello")');
    });

    it('should handle empty input', () => {
      const result = formatOutput('', false);
      expect(result).toBe('');
    });

    it('should handle multiline text', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const result = formatOutput(input, false);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('getHelpMessage', () => {
    it('should return help text with available commands', () => {
      const help = getHelpMessage();
      expect(help).toContain('/help');
      expect(help).toContain('/reset');
      expect(help).toContain('/exit');
      expect(help).toContain('/quit');
    });

    it('should include description of each command', () => {
      const help = getHelpMessage();
      expect(help).toContain('Show this help');
      expect(help).toContain('Clear conversation');
      expect(help).toContain('Exit');
    });
  });

  describe('handleInput', () => {
    beforeEach(() => {
      channel = new CLIChannel({
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
        enableColors: false,
      });
    });

    it('should process regular messages through agent', async () => {
      await channel.handleInput('Hello');

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        expect.any(String),
        'Hello'
      );
    });

    it('should handle /reset command', async () => {
      // First create a session by sending a message
      await channel.handleInput('Hello');

      // Now reset should delete the session
      await channel.handleInput('/reset');

      expect(mockSessionManager.deleteSession).toHaveBeenCalled();
    });

    it('should handle /help command', async () => {
      await channel.handleInput('/help');

      const output = mockStdout.join('');
      expect(output).toContain('/help');
    });

    it('should return exit signal for /exit command', async () => {
      const result = await channel.handleInput('/exit');

      expect(result).toEqual({ shouldExit: true });
    });

    it('should return exit signal for /quit command', async () => {
      const result = await channel.handleInput('/quit');

      expect(result).toEqual({ shouldExit: true });
    });

    it('should handle agent errors gracefully', async () => {
      (mockAgent.processMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Agent failed')
      );

      await channel.handleInput('test');

      const output = mockStdout.join('');
      expect(output).toContain('Error');
    });
  });

  describe('session management', () => {
    beforeEach(() => {
      channel = new CLIChannel({
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
        enableColors: false,
      });
    });

    it('should create session on first message', async () => {
      await channel.handleInput('Hello');

      expect(mockSessionManager.createSession).toHaveBeenCalledWith({
        userId: 'cli-user',
        channelId: 'cli',
      });
    });

    it('should reuse session for subsequent messages', async () => {
      await channel.handleInput('Hello');
      await channel.handleInput('World');

      expect(mockSessionManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('should create new session after reset', async () => {
      await channel.handleInput('Hello');
      await channel.handleInput('/reset');
      await channel.handleInput('New conversation');

      expect(mockSessionManager.createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('token usage display', () => {
    beforeEach(() => {
      channel = new CLIChannel({
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
        enableColors: false,
        showTokenUsage: true,
      });
    });

    it('should display token usage when enabled', async () => {
      await channel.handleInput('Hello');

      const output = mockStdout.join('');
      expect(output).toContain('tokens');
    });
  });
});
