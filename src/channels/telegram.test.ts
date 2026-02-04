import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create channel with bot token', async () => {
      const { TelegramChannel } = await import('./telegram.js');

      const channel = new TelegramChannel({
        botToken: 'test-token',
        agent: {} as any,
        sessionManager: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
        workspacePath: '/tmp/test-workspace',
      });

      expect(channel).toBeDefined();
    });
  });

  describe('formatMarkdownToHtml', () => {
    it('should convert markdown bold to HTML', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('This is **bold** text');
      expect(result).toBe('This is <b>bold</b> text');
    });

    it('should convert markdown italic to HTML', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('This is *italic* text');
      expect(result).toBe('This is <i>italic</i> text');
    });

    it('should convert markdown code to HTML', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('Use `code` here');
      expect(result).toBe('Use <code>code</code> here');
    });

    it('should convert markdown code blocks to HTML', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('```\ncode block\n```');
      expect(result).toContain('<pre>');
      expect(result).toContain('</pre>');
    });

    it('should escape HTML entities', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should handle mixed formatting', async () => {
      const { formatMarkdownToHtml } = await import('./telegram.js');

      const result = formatMarkdownToHtml('**bold** and *italic* and `code`');
      expect(result).toBe('<b>bold</b> and <i>italic</i> and <code>code</code>');
    });
  });

  describe('splitMessage', () => {
    it('should not split short messages', async () => {
      const { splitMessage } = await import('./telegram.js');

      const message = 'Short message';
      const result = splitMessage(message);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(message);
    });

    it('should split long messages at paragraph boundaries', async () => {
      const { splitMessage } = await import('./telegram.js');

      const paragraph1 = 'A'.repeat(2000);
      const paragraph2 = 'B'.repeat(2000);
      const paragraph3 = 'C'.repeat(2000);
      const message = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

      const result = splitMessage(message);

      expect(result.length).toBeGreaterThan(1);
      // Each chunk should be under 4096 chars
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      });
    });

    it('should split at line boundaries when paragraphs are too long', async () => {
      const { splitMessage } = await import('./telegram.js');

      const lines = Array(100).fill('This is a line of text.').join('\n');
      const result = splitMessage(lines);

      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      });
    });

    it('should force split very long single lines', async () => {
      const { splitMessage } = await import('./telegram.js');

      const veryLongLine = 'X'.repeat(10000);
      const result = splitMessage(veryLongLine);

      expect(result.length).toBeGreaterThan(1);
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      });
    });
  });

  describe('message handling', () => {
    it('should get or create session for user', async () => {
      const { TelegramChannel } = await import('./telegram.js');
      const { SessionManager } = await import('../agent/session.js');

      const mockSessionManager = {
        createSession: vi.fn().mockResolvedValue({ id: 'new-session' }),
        getSession: vi.fn().mockResolvedValue(undefined),
        listSessions: vi.fn().mockResolvedValue([]),
      } as unknown as InstanceType<typeof SessionManager>;

      const channel = new TelegramChannel({
        botToken: 'test-token',
        agent: {} as any,
        sessionManager: mockSessionManager,
        logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
        workspacePath: '/tmp/test-workspace',
      });

      const sessionId = await channel.getOrCreateSession('user123');

      expect(sessionId).toBe('new-session');
      expect(mockSessionManager.createSession).toHaveBeenCalledWith({ userId: 'telegram:user123', channelId: 'telegram' });
    });

    it('should reuse existing session for user', async () => {
      const { TelegramChannel } = await import('./telegram.js');
      const { SessionManager } = await import('../agent/session.js');

      const mockSessionManager = {
        createSession: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ id: 'existing-session', metadata: { userId: 'user123' } }),
        listSessions: vi.fn().mockResolvedValue([{ id: 'existing-session' }]),
      } as unknown as InstanceType<typeof SessionManager>;

      const channel = new TelegramChannel({
        botToken: 'test-token',
        agent: {} as any,
        sessionManager: mockSessionManager,
        logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
        workspacePath: '/tmp/test-workspace',
      });

      // Pre-register the session
      channel.userSessions.set('user123', 'existing-session');

      const sessionId = await channel.getOrCreateSession('user123');

      expect(sessionId).toBe('existing-session');
      expect(mockSessionManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('command handlers', () => {
    it('should handle /start command', async () => {
      const { getStartMessage } = await import('./telegram.js');

      const message = getStartMessage();

      expect(message).toContain('Welcome');
      expect(message).toContain('ScallopBot');
    });

    it('should handle /reset command by clearing session', async () => {
      const { TelegramChannel } = await import('./telegram.js');

      const mockSessionManager = {
        deleteSession: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: 'new-session' }),
      } as any;

      const channel = new TelegramChannel({
        botToken: 'test-token',
        agent: {} as any,
        sessionManager: mockSessionManager,
        logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
        workspacePath: '/tmp/test-workspace',
      });

      channel.userSessions.set('user123', 'old-session');

      await channel.handleReset('user123');

      expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('old-session');
      expect(channel.userSessions.has('user123')).toBe(false);
    });
  });
});
