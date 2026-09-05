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
        db: { getBotConfig: vi.fn().mockReturnValue(null), upsertBotConfig: vi.fn() } as any,
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
        db: {
          getBotConfig: vi.fn().mockReturnValue(null),
          upsertBotConfig: vi.fn(),
          findSessionByUserId: vi.fn().mockReturnValue(null),
        } as any,
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
        db: { getBotConfig: vi.fn().mockReturnValue(null), upsertBotConfig: vi.fn() } as any,
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

    it('should handle /reset by preserving the old session and activating a new one', async () => {
      const { TelegramChannel } = await import('./telegram.js');

      const mockSessionManager = {
        deleteSession: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: 'new-session' }),
        startNewSession: vi.fn().mockResolvedValue({ id: 'new-session' }),
      } as any;

      const channel = new TelegramChannel({
        botToken: 'test-token',
        agent: {} as any,
        sessionManager: mockSessionManager,
        logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any,
        workspacePath: '/tmp/test-workspace',
        db: { getBotConfig: vi.fn().mockReturnValue(null), upsertBotConfig: vi.fn() } as any,
      });

      channel.userSessions.set('user123', 'old-session');

      await channel.handleReset('user123');

      expect(mockSessionManager.startNewSession).toHaveBeenCalledWith({
        userId: 'telegram:user123',
        channelId: 'telegram',
      }, 'old-session');
      expect(mockSessionManager.deleteSession).not.toHaveBeenCalled();
      expect(channel.userSessions.get('user123')).toBe('new-session');
    });
  });

  describe('approvals (one-tap yes/no for blocked writes)', () => {
    const notionCreate = {
      type: 'tool_use' as const,
      id: 'n1',
      name: 'notion',
      input: { action: 'create', properties: { Name: { title: [{ text: { content: 'Leg Press' } }] } } },
    };

    async function makeApprovalChannel() {
      const { TelegramChannel } = await import('./telegram.js');
      const { ApprovalStore } = await import('../agent/approvals.js');
      const { promises: fs } = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scallopbot-tg-approvals-'));
      const store = new ApprovalStore({ dataDir: dir });
      const processMessage = vi.fn().mockResolvedValue({
        response: 'Logged Leg Press.',
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
      });
      const channel = Object.create(TelegramChannel.prototype) as any;
      channel.bot = { token: 'test-token', botInfo: { id: 99 } };
      channel.agent = { processMessage, getApprovalStore: () => store };
      channel.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      channel.userSessions = new Map([['42', 'tg-session']]);
      channel.getOrCreateSession = vi.fn().mockResolvedValue('tg-session');
      channel.startTypingIndicator = vi.fn().mockReturnValue(setInterval(() => {}, 60_000));
      channel.buildOnProgress = vi.fn().mockReturnValue(async () => {});
      channel.stopRequests = new Set();
      channel.getProviderForUser = vi.fn().mockReturnValue(undefined);
      channel.maybeWarnContext = vi.fn().mockResolvedValue(undefined);
      channel.sendPendingVoiceAttachments = vi.fn().mockResolvedValue(undefined);
      channel.activeProcessing = new Set();
      channel.userQueues = new Map();
      const cleanup = () => fs.rm(dir, { recursive: true, force: true });
      return { channel, store, processMessage, cleanup };
    }

    function makeCallbackContext(data: string, text = 'Do you want me to notion create: name=Leg Press?') {
      return {
        from: { id: 42 },
        callbackQuery: { data, message: { text } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue(undefined),
      } as any;
    }

    it('renders four buttons with the apv:<id>:<choice> protocol', async () => {
      const { approvalKeyboard, parseApprovalCallback } = await import('./telegram.js');

      const rows = approvalKeyboard('abc12345').inline_keyboard;
      const buttons = rows.flat() as Array<{ text: string; callback_data: string }>;
      expect(buttons.map(b => [b.text, b.callback_data])).toEqual([
        ['✅ Yes, once', 'apv:abc12345:once'],
        ['✅ This session', 'apv:abc12345:session'],
        ['✅ Always', 'apv:abc12345:always'],
        ['❌ No', 'apv:abc12345:deny'],
      ]);
      expect(parseApprovalCallback('apv:abc12345:always')).toEqual({ id: 'abc12345', choice: 'always' });
      expect(parseApprovalCallback('apv:abc12345:maybe')).toBeNull();
      expect(parseApprovalCallback('other:abc12345:once')).toBeNull();
    });

    it('attaches the keyboard to the last chunk only when the result carries pendingApproval', async () => {
      const { channel, cleanup } = await makeApprovalChannel();
      try {
        const ctx = { reply: vi.fn().mockResolvedValue(undefined) } as any;
        await channel.sendAgentResponse(ctx, {
          response: 'Plain answer',
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
        });
        expect(ctx.reply).toHaveBeenCalledWith('Plain answer', { parse_mode: 'HTML' });

        ctx.reply.mockClear();
        await channel.sendAgentResponse(ctx, {
          response: 'Do you want me to log Leg Press?',
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          pendingApproval: { id: 'abc12345', question: 'Do you want me to notion create: name=Leg Press?' },
        });
        expect(ctx.reply).toHaveBeenCalledTimes(1);
        const [text, options] = ctx.reply.mock.calls[0];
        expect(text).toBe('Do you want me to log Leg Press?');
        expect(options.parse_mode).toBe('HTML');
        const buttons = options.reply_markup.inline_keyboard.flat();
        expect(buttons.map((b: { callback_data: string }) => b.callback_data)).toEqual([
          'apv:abc12345:once', 'apv:abc12345:session', 'apv:abc12345:always', 'apv:abc12345:deny',
        ]);
      } finally {
        await cleanup();
      }
    });

    it('approve: grants at the chosen scope, marks the prompt, then runs a "Yes — …" turn', async () => {
      const { channel, store, processMessage, cleanup } = await makeApprovalChannel();
      try {
        const pending = store.registerPending({
          sessionId: 'tg-session',
          userId: 'telegram:42',
          toolUse: notionCreate,
          question: 'Do you want me to notion create: name=Leg Press?',
          description: 'notion create: name=Leg Press',
        })!;
        const ctx = makeCallbackContext(`apv:${pending.id}:session`);

        await channel.handleApprovalCallback(ctx, '42', `apv:${pending.id}:session`);

        expect(store.has('telegram:42', 'tg-session', 'notion:create')).toBe(true);
        expect(store.listAlways('telegram:42')).toEqual([]);
        expect(store.getPending('tg-session')).toBeUndefined();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Approved (this session).' });
        expect(ctx.editMessageText).toHaveBeenCalledWith(
          'Do you want me to notion create: name=Leg Press?\n\n✅ approved (this session)',
        );
        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(processMessage.mock.calls[0][0]).toBe('tg-session');
        expect(processMessage.mock.calls[0][1]).toBe('Yes — Do you want me to notion create: name=Leg Press?');
        expect(ctx.reply).toHaveBeenCalledWith('Logged Leg Press.', { parse_mode: 'HTML' });
        expect(channel.activeProcessing.has('42')).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('always: persists the grant so /approvals lists it and "clear" revokes it', async () => {
      const { channel, store, cleanup } = await makeApprovalChannel();
      try {
        const pending = store.registerPending({
          sessionId: 'tg-session', userId: 'telegram:42', toolUse: notionCreate, question: 'q?', description: 'd',
        })!;
        await channel.handleApprovalCallback(makeCallbackContext(`apv:${pending.id}:always`), '42', `apv:${pending.id}:always`);
        expect(store.listAlways('telegram:42').map(g => g.pattern)).toEqual(['notion:create']);

        const listCtx = { reply: vi.fn().mockResolvedValue(undefined) } as any;
        await channel.handleApprovalsCommand(listCtx, '42', '');
        expect(listCtx.reply.mock.calls[0][0]).toContain('<code>notion:create</code>');

        const clearCtx = { reply: vi.fn().mockResolvedValue(undefined) } as any;
        await channel.handleApprovalsCommand(clearCtx, '42', 'clear');
        expect(clearCtx.reply).toHaveBeenCalledWith('Cleared 1 standing approval.');
        expect(store.listAlways('telegram:42')).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('deny: records the denial, marks "not done", and runs a "No, don\'t …" turn', async () => {
      const { channel, store, processMessage, cleanup } = await makeApprovalChannel();
      try {
        const pending = store.registerPending({
          sessionId: 'tg-session',
          userId: 'telegram:42',
          toolUse: notionCreate,
          question: 'Do you want me to notion create: name=Leg Press?',
          description: 'notion create: name=Leg Press',
        })!;
        const ctx = makeCallbackContext(`apv:${pending.id}:deny`);

        await channel.handleApprovalCallback(ctx, '42', `apv:${pending.id}:deny`);

        expect(store.has('telegram:42', 'tg-session', 'notion:create')).toBe(false);
        expect(store.getDenial('tg-session')).toMatchObject({ pattern: 'notion:create' });
        expect(ctx.editMessageText).toHaveBeenCalledWith(
          'Do you want me to notion create: name=Leg Press?\n\n❌ not done',
        );
        expect(processMessage.mock.calls[0][1]).toBe("No, don't notion create: name=Leg Press.");
      } finally {
        await cleanup();
      }
    });

    it('expired or unknown id: answers the tap and runs no turn', async () => {
      const { channel, processMessage, cleanup } = await makeApprovalChannel();
      try {
        const ctx = makeCallbackContext('apv:nope1234:once');
        await channel.handleApprovalCallback(ctx, '42', 'apv:nope1234:once');
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'This request expired; just ask again.' });
        expect(ctx.editMessageText).not.toHaveBeenCalled();
        expect(processMessage).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    });

    it("refuses a tap from a user who does not own the prompt", async () => {
      const { channel, store, processMessage, cleanup } = await makeApprovalChannel();
      try {
        const pending = store.registerPending({
          sessionId: 'tg-session', userId: 'telegram:42', toolUse: notionCreate, question: 'q?', description: 'd',
        })!;
        const ctx = makeCallbackContext(`apv:${pending.id}:always`);
        ctx.from = { id: 7 };
        await channel.handleApprovalCallback(ctx, '7', `apv:${pending.id}:always`);
        expect(store.has('telegram:42', 'tg-session', 'notion:create')).toBe(false);
        expect(store.getPending('tg-session')).toBeDefined();
        expect(processMessage).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    });
  });
});
