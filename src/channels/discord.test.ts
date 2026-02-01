import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DiscordChannel,
  DiscordChannelOptions,
  formatMarkdownForDiscord,
  splitMessage,
  parseSlashCommand,
  buildSlashCommands,
} from './discord.js';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { Logger } from 'pino';

// Mock discord.js
vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    user: { tag: 'TestBot#1234', id: 'bot-123' },
    application: { id: 'app-123' },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
  Partials: {
    Channel: 0,
    Message: 1,
  },
  REST: vi.fn().mockImplementation(() => ({
    setToken: vi.fn().mockReturnThis(),
    put: vi.fn().mockResolvedValue(undefined),
  })),
  Routes: {
    applicationCommands: vi.fn().mockReturnValue('/applications/app-123/commands'),
  },
  SlashCommandBuilder: vi.fn().mockImplementation(() => ({
    setName: vi.fn().mockReturnThis(),
    setDescription: vi.fn().mockReturnThis(),
    addStringOption: vi.fn().mockReturnThis(),
    toJSON: vi.fn().mockReturnValue({}),
  })),
}));

describe('DiscordChannel', () => {
  let mockAgent: Agent;
  let mockSessionManager: SessionManager;
  let mockLogger: Logger;
  let channel: DiscordChannel;

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
  });

  describe('constructor', () => {
    it('should create Discord channel with options', () => {
      channel = new DiscordChannel({
        botToken: 'test-token',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });

      expect(channel).toBeInstanceOf(DiscordChannel);
    });

    it('should accept optional application ID', () => {
      channel = new DiscordChannel({
        botToken: 'test-token',
        applicationId: 'app-123',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });

      expect(channel).toBeInstanceOf(DiscordChannel);
    });
  });

  describe('formatMarkdownForDiscord', () => {
    it('should pass through plain text', () => {
      const result = formatMarkdownForDiscord('Hello world');
      expect(result).toBe('Hello world');
    });

    it('should preserve code blocks', () => {
      const input = '```javascript\nconst x = 1;\n```';
      const result = formatMarkdownForDiscord(input);
      expect(result).toBe(input);
    });

    it('should preserve inline code', () => {
      const input = 'Use `npm install` to install';
      const result = formatMarkdownForDiscord(input);
      expect(result).toBe(input);
    });

    it('should preserve bold formatting', () => {
      const input = 'This is **bold** text';
      const result = formatMarkdownForDiscord(input);
      expect(result).toBe(input);
    });

    it('should preserve italic formatting', () => {
      const input = 'This is *italic* text';
      const result = formatMarkdownForDiscord(input);
      expect(result).toBe(input);
    });

    it('should handle empty input', () => {
      const result = formatMarkdownForDiscord('');
      expect(result).toBe('');
    });
  });

  describe('splitMessage', () => {
    it('should return single chunk for short messages', () => {
      const result = splitMessage('Hello world');
      expect(result).toEqual(['Hello world']);
    });

    it('should split long messages at 2000 chars (Discord limit)', () => {
      const longText = 'a'.repeat(2500);
      const result = splitMessage(longText);
      expect(result.length).toBeGreaterThan(1);
      expect(result[0].length).toBeLessThanOrEqual(2000);
    });

    it('should try to split at newlines', () => {
      const text = 'Line 1\n'.repeat(300);
      const result = splitMessage(text);
      result.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      });
    });

    it('should handle empty string', () => {
      const result = splitMessage('');
      expect(result).toEqual(['']);
    });
  });

  describe('parseSlashCommand', () => {
    it('should parse /ask command', () => {
      const mockInteraction = {
        commandName: 'ask',
        options: {
          getString: vi.fn().mockReturnValue('What is TypeScript?'),
        },
      };

      const result = parseSlashCommand(mockInteraction as any);
      expect(result).toEqual({
        command: 'ask',
        message: 'What is TypeScript?',
      });
    });

    it('should parse /reset command', () => {
      const mockInteraction = {
        commandName: 'reset',
        options: {
          getString: vi.fn().mockReturnValue(null),
        },
      };

      const result = parseSlashCommand(mockInteraction as any);
      expect(result).toEqual({
        command: 'reset',
        message: null,
      });
    });

    it('should parse /help command', () => {
      const mockInteraction = {
        commandName: 'help',
        options: {
          getString: vi.fn().mockReturnValue(null),
        },
      };

      const result = parseSlashCommand(mockInteraction as any);
      expect(result).toEqual({
        command: 'help',
        message: null,
      });
    });
  });

  describe('buildSlashCommands', () => {
    it('should return array of slash command definitions', () => {
      const commands = buildSlashCommands();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should include /ask command', () => {
      const commands = buildSlashCommands();
      const askCmd = commands.find((c) => c.name === 'ask');
      expect(askCmd).toBeDefined();
    });

    it('should include /reset command', () => {
      const commands = buildSlashCommands();
      const resetCmd = commands.find((c) => c.name === 'reset');
      expect(resetCmd).toBeDefined();
    });

    it('should include /help command', () => {
      const commands = buildSlashCommands();
      const helpCmd = commands.find((c) => c.name === 'help');
      expect(helpCmd).toBeDefined();
    });
  });

  describe('message handling', () => {
    beforeEach(() => {
      channel = new DiscordChannel({
        botToken: 'test-token',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
    });

    it('should process message through agent', async () => {
      const mockMessage = {
        author: { id: 'user-123', bot: false },
        content: '<@bot-123> Hello there',
        channel: {
          send: vi.fn().mockResolvedValue(undefined),
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
        mentions: {
          has: vi.fn().mockReturnValue(true),
        },
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await channel.handleMessage(mockMessage as any);

      expect(mockAgent.processMessage).toHaveBeenCalled();
    });

    it('should ignore bot messages', async () => {
      const mockMessage = {
        author: { id: 'bot-123', bot: true },
        content: 'Bot message',
        channel: { send: vi.fn() },
        mentions: { has: vi.fn().mockReturnValue(false) },
      };

      await channel.handleMessage(mockMessage as any);

      expect(mockAgent.processMessage).not.toHaveBeenCalled();
    });

    it('should respond to DMs without mention', async () => {
      const mockMessage = {
        author: { id: 'user-123', bot: false },
        content: 'Hello in DM',
        channel: {
          type: 1, // DM channel
          send: vi.fn().mockResolvedValue(undefined),
          sendTyping: vi.fn().mockResolvedValue(undefined),
        },
        mentions: { has: vi.fn().mockReturnValue(false) },
        reply: vi.fn().mockResolvedValue(undefined),
        guild: null,
      };

      await channel.handleMessage(mockMessage as any);

      expect(mockAgent.processMessage).toHaveBeenCalled();
    });
  });

  describe('slash command handling', () => {
    beforeEach(() => {
      channel = new DiscordChannel({
        botToken: 'test-token',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
    });

    it('should handle /ask slash command', async () => {
      const mockInteraction = {
        commandName: 'ask',
        user: { id: 'user-123' },
        options: { getString: vi.fn().mockReturnValue('What is TypeScript?') },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
        isCommand: vi.fn().mockReturnValue(true),
        isChatInputCommand: vi.fn().mockReturnValue(true),
      };

      await channel.handleSlashCommand(mockInteraction as any);

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        expect.any(String),
        'What is TypeScript?'
      );
    });

    it('should handle /reset slash command', async () => {
      // First create a session
      await channel.getOrCreateSession('user-123');

      const mockInteraction = {
        commandName: 'reset',
        user: { id: 'user-123' },
        options: { getString: vi.fn().mockReturnValue(null) },
        reply: vi.fn().mockResolvedValue(undefined),
        isCommand: vi.fn().mockReturnValue(true),
        isChatInputCommand: vi.fn().mockReturnValue(true),
      };

      await channel.handleSlashCommand(mockInteraction as any);

      expect(mockSessionManager.deleteSession).toHaveBeenCalled();
    });

    it('should handle /help slash command', async () => {
      const mockInteraction = {
        commandName: 'help',
        user: { id: 'user-123' },
        options: { getString: vi.fn().mockReturnValue(null) },
        reply: vi.fn().mockResolvedValue(undefined),
        isCommand: vi.fn().mockReturnValue(true),
        isChatInputCommand: vi.fn().mockReturnValue(true),
      };

      await channel.handleSlashCommand(mockInteraction as any);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });
  });

  describe('session management', () => {
    beforeEach(() => {
      channel = new DiscordChannel({
        botToken: 'test-token',
        agent: mockAgent,
        sessionManager: mockSessionManager,
        logger: mockLogger,
      });
    });

    it('should create session for new user', async () => {
      const sessionId = await channel.getOrCreateSession('user-123');

      expect(mockSessionManager.createSession).toHaveBeenCalledWith({
        userId: 'user-123',
        channelId: 'discord',
      });
      expect(sessionId).toBe('session-123');
    });

    it('should reuse existing session', async () => {
      await channel.getOrCreateSession('user-123');
      await channel.getOrCreateSession('user-123');

      expect(mockSessionManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('should reset session for user', async () => {
      await channel.getOrCreateSession('user-123');
      await channel.handleReset('user-123');

      expect(mockSessionManager.deleteSession).toHaveBeenCalled();
    });
  });
});
