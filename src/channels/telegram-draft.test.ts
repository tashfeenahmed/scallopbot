import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramReplyDraft, type DraftTransport } from './telegram-draft.js';
import { TelegramChannel } from './telegram.js';

/** A fake Bot API that records calls in order. */
function fakeTransport() {
  const calls: string[] = [];
  let nextId = 100;
  const transport: DraftTransport & { failHtml?: boolean } = {
    send: vi.fn(async (text: string) => {
      const id = nextId++;
      calls.push(`send#${id}:${text}`);
      return id;
    }),
    edit: vi.fn(async (id: number, text: string, options?: { html?: boolean; replyMarkup?: unknown }) => {
      if (options?.html && transport.failHtml) throw new Error("Bad Request: can't parse entities");
      calls.push(`edit#${id}:${options?.html ? 'html:' : ''}${options?.replyMarkup ? 'kb:' : ''}${text}`);
    }),
    delete: vi.fn(async (id: number) => {
      calls.push(`delete#${id}`);
    }),
  };
  return { transport, calls };
}

describe('TelegramReplyDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a draft on the first delta, throttles edits to one per second, and finalizes in place', async () => {
    const { transport, calls } = fakeTransport();
    const draft = new TelegramReplyDraft(transport);

    draft.push('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['send#100:Hel']);

    draft.push('lo');
    draft.push(' wor');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(['send#100:Hel', 'edit#100:Hello wor']);

    draft.push('ld');
    expect(await draft.finalize('<b>Hello world</b>')).toBe(true);
    expect(calls).toEqual(['send#100:Hel', 'edit#100:Hello wor', 'edit#100:html:<b>Hello world</b>']);
    // No late edit after finalize.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
  });

  it('deletes the draft on reset and starts a fresh one for the next text', async () => {
    const { transport, calls } = fakeTransport();
    const draft = new TelegramReplyDraft(transport);
    draft.push('Let me check.');
    await vi.advanceTimersByTimeAsync(0);
    draft.reset();
    await vi.advanceTimersByTimeAsync(0);
    draft.push('Answer');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await draft.finalize('Answer', { inline_keyboard: [] })).toBe(true);
    expect(calls).toEqual(['send#100:Let me check.', 'delete#100', 'send#101:Answer', 'edit#101:html:kb:Answer']);
  });

  it('a reset while the first send is in flight still deletes that message', async () => {
    const { transport, calls } = fakeTransport();
    let release!: () => void;
    (transport.send as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string) => {
      await new Promise<void>((resolve) => { release = resolve; });
      calls.push(`send#100:${text}`);
      return 100;
    });
    const draft = new TelegramReplyDraft(transport);
    draft.push('planning');
    await vi.advanceTimersByTimeAsync(0);
    draft.reset();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['send#100:planning', 'delete#100']);
    expect(await draft.finalize('x')).toBe(false);
  });

  it('caps the draft at the Telegram limit', async () => {
    const { transport } = fakeTransport();
    const draft = new TelegramReplyDraft(transport, { maxChars: 10 });
    draft.push('abcdefghijklmnop');
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.send).toHaveBeenCalledWith('abcdefghi…');
  });

  it('falls back to plain text when the HTML edit is rejected', async () => {
    const { transport, calls } = fakeTransport();
    transport.failHtml = true;
    const draft = new TelegramReplyDraft(transport);
    draft.push('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(await draft.finalize('<b>bold</b>')).toBe(true);
    expect(calls.at(-1)).toBe('edit#100:bold');
  });

  it('finalize without any draft returns false and sends nothing', async () => {
    const { transport, calls } = fakeTransport();
    const draft = new TelegramReplyDraft(transport);
    expect(await draft.finalize('hi')).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('TelegramChannel streaming wiring', () => {
  function makeChannel() {
    const channel = Object.create(TelegramChannel.prototype) as any;
    channel.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    channel.verboseUsers = new Set();
    channel.liveDrafts = new Map();
    return channel;
  }

  function makeCtx() {
    let nextId = 1;
    const ctx = {
      from: { id: 42 },
      chat: { id: 42 },
      reply: vi.fn(async () => ({ message_id: nextId++ })),
      api: {
        editMessageText: vi.fn(async () => true),
        deleteMessage: vi.fn(async () => true),
      },
    };
    return ctx;
  }

  it('streams into one message and does not send the final reply a second time', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      const ctx = makeCtx();
      const draft = channel.createReplyDraft('42', ctx);
      const onProgress = channel.buildOnProgress('42', ctx, draft);

      await onProgress({ type: 'text_delta', message: 'Planning…' });
      await vi.advanceTimersByTimeAsync(0);
      await onProgress({ type: 'text_reset', message: '' });
      await onProgress({ type: 'tool_start', message: 'x', toolName: 'bash' });
      await onProgress({ type: 'text_delta', message: 'The **answer**' });
      await vi.advanceTimersByTimeAsync(1_000);

      await channel.sendAgentResponse(ctx, { response: 'The **answer**', tokenUsage: { inputTokens: 1, outputTokens: 1 } }, draft);

      // Two drafts were sent (the planning one deleted); the reply itself never went out as a new message.
      expect(ctx.reply.mock.calls.map((c: unknown[]) => c[0])).toEqual(['Planning…', 'The **answer**']);
      expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 1);
      expect(ctx.api.editMessageText).toHaveBeenLastCalledWith(42, 2, 'The <b>answer</b>', { parse_mode: 'HTML' });
      expect(channel.liveDrafts.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts approval buttons on the finalized draft', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      const ctx = makeCtx();
      const draft = channel.createReplyDraft('42', ctx);
      draft.push('Shall I?');
      await vi.advanceTimersByTimeAsync(0);
      await channel.sendAgentResponse(ctx, {
        response: 'Shall I?',
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        pendingApproval: { id: 'abc12345', question: 'Shall I?' },
      }, draft);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const [, , text, options] = ctx.api.editMessageText.mock.calls.at(-1) as unknown as [number, number, string, { reply_markup?: { inline_keyboard: unknown[][] } }];
      expect(text).toBe('Shall I?');
      expect(options.reply_markup?.inline_keyboard.flat()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed turn deletes its draft', async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel();
      const ctx = makeCtx();
      const draft = channel.createReplyDraft('42', ctx);
      draft.push('half');
      await vi.advanceTimersByTimeAsync(0);
      await channel.discardReplyDraft('42');
      expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
