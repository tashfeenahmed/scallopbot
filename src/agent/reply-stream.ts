/**
 * Reply streaming for the agent loop.
 *
 * The provider hands over raw text deltas. Before they reach a channel as
 * `text_delta` progress events they go through two filters:
 *   - <think>…</think> blocks are dropped, including tags split across chunks
 *     and an orphan </think> (everything before it was reasoning);
 *   - a trailing [DONE] marker is held back and dropped at the end.
 *
 * Text that turns out to sit beside tool calls is planning, not the reply:
 * the channel is told to discard its draft with a `text_reset` event.
 */

import type { StreamHandlers } from '../providers/types.js';

/** Minimal shape of the agent's ProgressUpdate used here. */
export interface ReplyStreamUpdate {
  type: 'text_delta' | 'text_reset';
  message: string;
  iteration?: number;
}

export type ReplyStreamCallback = (update: ReplyStreamUpdate) => Promise<void>;

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
const DONE_MARKER = '[done]';

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (case-insensitive). */
function partialTagSuffix(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let len = Math.min(tag.length - 1, lower.length); len > 0; len--) {
    if (tag.startsWith(lower.slice(lower.length - len))) return len;
  }
  return 0;
}

/**
 * Incremental <think> stripper. push() returns the visible text it can
 * release now; `reset` is set when an orphan </think> showed that the text
 * already released was reasoning.
 */
export class ThinkTagFilter {
  private inThink = false;
  private pending = '';
  /** True when visible text released so far must be discarded. */
  reset = false;

  push(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = '';
    let out = '';

    while (text) {
      const lower = text.toLowerCase();
      if (this.inThink) {
        const close = lower.indexOf(CLOSE_TAG);
        if (close === -1) {
          const keep = partialTagSuffix(text, CLOSE_TAG);
          this.pending = keep ? text.slice(text.length - keep) : '';
          return out;
        }
        this.inThink = false;
        text = text.slice(close + CLOSE_TAG.length);
        continue;
      }

      const open = lower.indexOf(OPEN_TAG);
      const close = lower.indexOf(CLOSE_TAG);
      if (close !== -1 && (open === -1 || close < open)) {
        // A block closed that never opened: everything before was reasoning.
        out = '';
        this.reset = true;
        text = text.slice(close + CLOSE_TAG.length);
        continue;
      }
      if (open !== -1) {
        out += text.slice(0, open);
        this.inThink = true;
        text = text.slice(open + OPEN_TAG.length);
        continue;
      }
      const keep = Math.max(partialTagSuffix(text, OPEN_TAG), partialTagSuffix(text, CLOSE_TAG));
      out += text.slice(0, text.length - keep);
      this.pending = keep ? text.slice(text.length - keep) : '';
      return out;
    }
    return out;
  }

  /** End of stream: a dangling partial tag that never completed is text. */
  flush(): string {
    const rest = this.inThink ? '' : this.pending;
    this.pending = '';
    return rest;
  }
}

/**
 * Holds back a trailing "[DONE]" (or a prefix of it) so the completion
 * marker never flashes up in the draft.
 */
export class DoneMarkerFilter {
  private held = '';

  push(chunk: string): string {
    const text = this.held + chunk;
    this.held = '';
    const bracket = text.lastIndexOf('[');
    if (bracket === -1) return text;
    const tail = text.slice(bracket).trimEnd().toLowerCase();
    if (!DONE_MARKER.startsWith(tail)) return text;
    // Hold the marker candidate and the whitespace in front of it.
    let start = bracket;
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    this.held = text.slice(start);
    return text.slice(0, start);
  }

  /** End of stream: drop a complete trailing marker, release anything else. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest.trim().toLowerCase() === DONE_MARKER ? '' : rest;
  }
}

/**
 * One per agent turn. begin() before each model call, pass `handlers` to the
 * streaming provider call, end() when the response is in.
 */
export class ReplyStream {
  private think = new ThinkTagFilter();
  private done = new DoneMarkerFilter();
  private chain: Promise<void> = Promise.resolve();
  /** Visible text was emitted since the last reset. */
  private open = false;
  /** Further deltas of the current call are ignored (tool call started, or call ended). */
  private muted = true;
  private iteration = 0;

  readonly handlers: StreamHandlers = {
    onTextDelta: (text) => this.delta(text),
    onToolUseStart: () => {
      this.muted = true;
      this.reset();
    },
    onTextReset: () => this.reset(),
  };

  constructor(
    private readonly onProgress: ReplyStreamCallback,
    private readonly onError?: (error: Error) => void,
  ) {}

  /** Start a model call. Text left from an earlier call of this turn is void. */
  begin(iteration: number): void {
    this.reset();
    this.iteration = iteration;
    this.muted = false;
  }

  /**
   * The call returned (or failed). Flushes held text unless `discard`, in
   * which case anything shown is reset; waits for queued events to deliver.
   */
  async end(discard: boolean): Promise<void> {
    if (!this.muted && !discard) {
      const tail = this.done.push(this.think.flush()) + this.done.flush();
      if (tail) this.emit(tail);
    }
    this.muted = true;
    if (discard) this.reset();
    await this.chain;
  }

  private delta(text: string): void {
    if (this.muted) return;
    let visible = this.think.push(text);
    if (this.think.reset) {
      // Orphan </think>: what was shown (and any held tail) was reasoning.
      this.think.reset = false;
      this.done = new DoneMarkerFilter();
      this.reset({ keepThinkState: true });
    }
    visible = this.done.push(visible);
    if (visible) this.emit(visible);
  }

  private emit(text: string): void {
    this.open = true;
    this.enqueue({ type: 'text_delta', message: text, iteration: this.iteration });
  }

  private reset(options: { keepThinkState?: boolean } = {}): void {
    if (!options.keepThinkState) {
      this.think = new ThinkTagFilter();
      this.done = new DoneMarkerFilter();
    }
    if (!this.open) return;
    this.open = false;
    this.enqueue({ type: 'text_reset', message: '', iteration: this.iteration });
  }

  private enqueue(update: ReplyStreamUpdate): void {
    this.chain = this.chain
      .then(() => this.onProgress(update))
      .catch((error: unknown) => this.onError?.(error as Error));
  }
}
