import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeChannel(feedback: unknown) {
  const channel = Object.create(TelegramChannel.prototype) as any;
  const addMessage = vi.fn().mockResolvedValue(undefined);
  const processMessage = vi.fn().mockResolvedValue({
    response: 'Normal agent response',
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
  });
  channel.bot = { token: 'test-token', botInfo: { id: 99 } };
  channel.onUserMessage = vi.fn().mockResolvedValue(feedback);
  channel.sessionManager = { addMessage };
  channel.agent = { processMessage };
  channel.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  channel.getOrCreateSession = vi.fn().mockResolvedValue('telegram-session');
  channel.startTypingIndicator = vi.fn().mockReturnValue(setInterval(() => {}, 60_000));
  channel.buildOnProgress = vi.fn().mockReturnValue(async () => {});
  channel.stopRequests = new Set();
  channel.getProviderForUser = vi.fn().mockReturnValue(undefined);
  channel.maybeWarnContext = vi.fn().mockResolvedValue(undefined);
  channel.sendPendingVoiceAttachments = vi.fn().mockResolvedValue(undefined);
  channel.handleOnboardingResponse = vi.fn().mockResolvedValue(false);
  channel.activeProcessing = new Set();
  channel.userQueues = new Map();
  channel.interruptQueue = { enqueue: vi.fn() };
  channel.mediaGroupBuffer = new Map();
  return { channel, addMessage, processMessage };
}

function makeContext(text = 'Archive', directReply = true) {
  return {
    from: { id: 42 },
    message: {
      text,
      ...(directReply ? {
        reply_to_message: {
          message_id: 700,
          text: 'Should the Project Atlas launch task stay open?',
          from: { id: 99, is_bot: true },
        },
      } : {}),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
});

describe('Telegram proactive source replies', () => {
  it('short-circuits an applied Archive reply with one persisted confirmation and no model turn', async () => {
    const { channel, addMessage, processMessage } = makeChannel({
      matched: true,
      sourceAction: { action: 'archive', title: 'Publish Project Atlas launch update', applied: true },
    });
    const ctx = makeContext();

    await channel.processTextCore(ctx);

    expect(channel.onUserMessage).toHaveBeenCalledTimes(1);
    expect(channel.onUserMessage).toHaveBeenCalledWith(
      'telegram:42',
      'Archive',
      expect.objectContaining({ repliedToMessageId: '700' }),
    );
    expect(processMessage).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('Archived “Publish Project Atlas launch update”.');
    expect(addMessage).toHaveBeenNthCalledWith(1, 'telegram-session', expect.objectContaining({
      role: 'user', content: expect.stringContaining('Archive'),
    }));
    expect(addMessage).toHaveBeenNthCalledWith(2, 'telegram-session', {
      role: 'assistant', content: 'Archived “Publish Project Atlas launch update”.',
    });
  });

  it('runs the agent and engagement hook exactly once when a direct reply has no trusted source action', async () => {
    const { channel, processMessage } = makeChannel({ matched: false });
    const ctx = makeContext('Can you explain what you mean?');

    await channel.processTextCore(ctx);

    expect(channel.onUserMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0][1]).toContain('Can you explain what you mean?');
    expect(ctx.reply).toHaveBeenCalledWith('Normal agent response', { parse_mode: 'HTML' });
  });

  it('awaits a transcribed voice action, confirms it deterministically, and skips the agent', async () => {
    const feedback = {
      matched: true,
      sourceAction: { action: 'archive', title: 'Publish Project Atlas launch update', applied: true },
    };
    const hookEntered = deferred<void>();
    const hookResult = deferred<unknown>();
    const { channel, addMessage, processMessage } = makeChannel(undefined);
    channel.onUserMessage = vi.fn().mockImplementation(() => {
      hookEntered.resolve();
      return hookResult.promise;
    });
    channel.voiceManager = {
      transcribe: vi.fn().mockResolvedValue({ text: 'Archive' }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const ctx = {
      from: { id: 42 },
      message: {
        voice: { file_id: 'voice-1' },
        reply_to_message: {
          text: 'Should the Project Atlas launch task stay open?',
          from: { id: 99, is_bot: true },
        },
      },
      api: { getFile: vi.fn().mockResolvedValue({ file_path: 'voice.ogg' }) },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    const processing = channel.processVoiceCore(ctx);
    await hookEntered.promise;

    expect(processMessage).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();

    hookResult.resolve(feedback);
    await processing;

    expect(channel.onUserMessage).toHaveBeenCalledWith(
      'telegram:42',
      'Archive',
      expect.objectContaining({ directReply: true }),
    );
    expect(processMessage).not.toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenCalledWith('Archived “Publish Project Atlas launch update”.');
  });

  it('awaits document engagement but denies mutation authority to an Archive caption', async () => {
    const hookEntered = deferred<void>();
    const hookResult = deferred<unknown>();
    const { channel, addMessage, processMessage } = makeChannel(undefined);
    channel.onUserMessage = vi.fn().mockImplementation(() => {
      hookEntered.resolve();
      return hookResult.promise;
    });
    const getFile = vi.fn().mockRejectedValue(new Error('stop after engagement hook'));
    const ctx = {
      from: { id: 42 },
      message: {
        document: { file_id: 'doc-1', file_name: 'notes.pdf', mime_type: 'application/pdf' },
        caption: 'Archive',
        reply_to_message: {
          text: 'Should the Project Atlas launch task stay open?',
          from: { id: 99, is_bot: true },
        },
      },
      api: { getFile },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    const processing = channel.processDocumentCore(ctx);
    await hookEntered.promise;

    expect(getFile).not.toHaveBeenCalled();
    expect(channel.onUserMessage).toHaveBeenCalledWith(
      'telegram:42',
      'Archive',
      expect.objectContaining({ directReply: true, allowSourceAction: false }),
    );

    hookResult.resolve({ matched: true });
    await processing;

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(addMessage).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('awaits photo engagement but denies mutation authority to an Archive caption', async () => {
    const hookEntered = deferred<void>();
    const hookResult = deferred<unknown>();
    const { channel, addMessage, processMessage } = makeChannel(undefined);
    channel.onUserMessage = vi.fn().mockImplementation(() => {
      hookEntered.resolve();
      return hookResult.promise;
    });
    const getFile = vi.fn().mockRejectedValue(new Error('stop after engagement hook'));
    const ctx = {
      from: { id: 42 },
      chat: { id: 42 },
      message: {
        photo: [{ file_id: 'photo-1', width: 100, height: 100 }],
        caption: 'Archive',
        reply_to_message: {
          text: 'Should the Project Atlas launch task stay open?',
          from: { id: 99, is_bot: true },
        },
      },
      api: { getFile },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    const processing = channel.handlePhotoMessage(ctx);
    await hookEntered.promise;

    expect(getFile).not.toHaveBeenCalled();
    expect(channel.onUserMessage).toHaveBeenCalledWith(
      'telegram:42',
      'Archive',
      expect.objectContaining({ directReply: true, allowSourceAction: false }),
    );

    hookResult.resolve({ matched: true });
    await processing;

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(addMessage).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('serializes Archive confirmation behind an unresolved agent turn', async () => {
    const agentEntered = deferred<void>();
    const releaseAgent = deferred<void>();
    const timeline: string[] = [];
    const { channel, addMessage, processMessage } = makeChannel(undefined);
    channel.onUserMessage = vi.fn().mockImplementation(async (_userId: string, message?: string) => {
      timeline.push(`hook:${message}`);
      return message === 'Archive'
        ? {
            matched: true,
            sourceAction: { action: 'archive', title: 'Publish Project Atlas launch update', applied: true },
          }
        : { matched: false };
    });
    processMessage.mockImplementation(async () => {
      agentEntered.resolve();
      await releaseAgent.promise;
      timeline.push('agent:complete');
      return {
        response: 'First agent response',
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    addMessage.mockImplementation(async (_sessionId: string, message: { role: string }) => {
      timeline.push(`persist:${message.role}`);
    });
    const firstCtx = makeContext('Work on the launch plan', false);
    firstCtx.reply.mockImplementation(async () => {
      timeline.push('reply:first');
    });
    const archiveCtx = makeContext('Archive');
    archiveCtx.reply.mockImplementation(async () => {
      timeline.push('reply:archive');
    });

    const firstTurn = channel.handleMessage(firstCtx);
    await agentEntered.promise;

    await channel.handleMessage(archiveCtx);

    expect(channel.onUserMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).not.toHaveBeenCalled();
    expect(archiveCtx.reply).not.toHaveBeenCalled();
    expect(channel.interruptQueue.enqueue).not.toHaveBeenCalled();

    releaseAgent.resolve();
    await firstTurn;

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(channel.onUserMessage).toHaveBeenCalledTimes(2);
    expect(archiveCtx.reply).toHaveBeenCalledWith('Archived “Publish Project Atlas launch update”.');
    expect(timeline).toEqual([
      'hook:Work on the launch plan',
      'agent:complete',
      'reply:first',
      'hook:Archive',
      'persist:user',
      'persist:assistant',
      'reply:archive',
    ]);
  });

  it('returns every Telegram message ID produced by outbound chunking', async () => {
    const { channel } = makeChannel(undefined);
    channel.isRunning = true;
    channel.allowedUsers = new Set();
    channel.bot.api = {
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ message_id: 801 })
        .mockResolvedValueOnce({ message_id: 802 }),
    };

    const result = await channel.sendMessage('42', 'A'.repeat(5_000));

    expect(channel.bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      sent: true,
      channel: 'telegram',
      messageIds: ['801', '802'],
    });
  });

  it('refuses to guess a default Telegram recipient from a multi-user allow-list', async () => {
    const { channel } = makeChannel(undefined);
    channel.isRunning = true;
    channel.allowedUsers = new Set(['41', '42']);
    channel.bot.api = { sendMessage: vi.fn() };

    await expect(channel.sendMessage('default', 'Project Atlas update')).resolves.toBe(false);
    expect(channel.bot.api.sendMessage).not.toHaveBeenCalled();
    expect(channel.logger.warn).toHaveBeenCalledWith(
      { allowedUserCount: 2 },
      'Cannot resolve default Telegram recipient unambiguously',
    );
  });

  it('refuses an explicit outbound chat outside the configured allow-list', async () => {
    const { channel } = makeChannel(undefined);
    channel.isRunning = true;
    channel.allowedUsers = new Set(['42']);
    channel.bot.api = { sendMessage: vi.fn() };

    await expect(channel.sendMessage('99', 'Project Atlas update')).resolves.toBe(false);
    expect(channel.bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
