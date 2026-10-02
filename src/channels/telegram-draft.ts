/**
 * Edit-message streaming for Telegram.
 *
 * The first text delta sends a plain-text draft message; later deltas edit it
 * at most once per `minEditIntervalMs` (Telegram rate-limits edits). A reset
 * deletes the draft (that text was planning beside a tool call). finalize()
 * turns the draft into the first chunk of the formatted reply, so the reply
 * is never sent twice.
 */

/** The three Bot API calls the draft needs, bound to one chat. */
export interface DraftTransport {
  /** Send a plain-text message; resolves to its message_id. */
  send(text: string): Promise<number>;
  edit(messageId: number, text: string, options?: { html?: boolean; replyMarkup?: unknown }): Promise<void>;
  delete(messageId: number): Promise<void>;
}

export interface DraftLogger {
  debug(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export interface ReplyDraftOptions {
  /** Minimum gap between Bot API writes. Default 1000 ms. */
  minEditIntervalMs?: number;
  /** Telegram's message length limit. Default 4096. */
  maxChars?: number;
  logger?: DraftLogger;
  now?: () => number;
}

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

function errorText(error: unknown): string {
  const e = error as { description?: string; message?: string };
  return e?.description ?? e?.message ?? String(error);
}

function isNotModified(error: unknown): boolean {
  return /message is not modified/i.test(errorText(error));
}

export class TelegramReplyDraft {
  private text = '';
  private shown = '';
  private messageId: number | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly minEditIntervalMs: number;
  private readonly maxChars: number;
  private readonly now: () => number;

  constructor(private readonly transport: DraftTransport, private readonly options: ReplyDraftOptions = {}) {
    this.minEditIntervalMs = options.minEditIntervalMs ?? 1000;
    this.maxChars = options.maxChars ?? TELEGRAM_MAX_MESSAGE_CHARS;
    this.now = options.now ?? Date.now;
  }

  push(delta: string): void {
    if (this.closed || !delta) return;
    this.text += delta;
    this.schedule();
  }

  /** Drop the streamed text and delete the draft message. */
  reset(): void {
    if (this.closed) return;
    this.clearTimer();
    this.text = '';
    void this.enqueue(() => this.deleteDraft());
  }

  /**
   * Replace the draft with the final reply's first chunk (HTML), falling back
   * to plain text if Telegram rejects the markup. Resolves true when the
   * draft now shows that chunk; false when there was no draft or it could not
   * be edited (it is deleted then), so the caller sends the chunk normally.
   */
  async finalize(html: string, replyMarkup?: unknown): Promise<boolean> {
    this.closed = true;
    this.clearTimer();
    return this.enqueue(async () => {
      const id = this.messageId;
      if (id === undefined) return false;
      try {
        await this.transport.edit(id, html, { html: true, ...(replyMarkup !== undefined && { replyMarkup }) });
        return true;
      } catch (error) {
        if (isNotModified(error)) return true;
        this.options.logger?.warn({ error: errorText(error) }, 'Draft HTML edit failed, trying plain text');
      }
      try {
        const plain = html.replace(/<[^>]*>/g, '');
        await this.transport.edit(id, plain, replyMarkup !== undefined ? { replyMarkup } : undefined);
        return true;
      } catch (error) {
        if (isNotModified(error)) return true;
        this.options.logger?.warn({ error: errorText(error) }, 'Draft final edit failed; sending the reply as a new message');
        await this.deleteDraft();
        return false;
      }
    });
  }

  /** Close the draft and delete it (empty final reply, or the turn failed). */
  async discard(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    this.text = '';
    await this.enqueue(() => this.deleteDraft());
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastWriteAt + this.minEditIntervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.flush());
    }, wait);
  }

  private render(): string {
    const text = this.text.trim();
    if (text.length <= this.maxChars) return text;
    return `${text.slice(0, this.maxChars - 1)}…`;
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    const display = this.render();
    if (!display || display === this.shown) return;
    try {
      if (this.messageId === undefined) {
        this.messageId = await this.transport.send(display);
      } else {
        await this.transport.edit(this.messageId, display);
      }
      this.shown = display;
    } catch (error) {
      this.lastWriteAt = this.now();
      if (!isNotModified(error)) {
        // Retry on the next delta rather than in a loop.
        this.options.logger?.debug({ error: errorText(error) }, 'Draft update failed (will retry on next delta)');
        return;
      }
      this.shown = display;
    }
    this.lastWriteAt = this.now();
    // More text arrived while the write was in flight.
    if (!this.closed && this.render() !== this.shown) this.schedule();
  }

  private async deleteDraft(): Promise<void> {
    const id = this.messageId;
    this.messageId = undefined;
    this.shown = '';
    if (id === undefined) return;
    try {
      await this.transport.delete(id);
    } catch (error) {
      this.options.logger?.debug({ error: errorText(error) }, 'Draft delete failed');
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
