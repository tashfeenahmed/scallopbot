import { describe, it, expect } from 'vitest';
import { DoneMarkerFilter, ReplyStream, ThinkTagFilter, type ReplyStreamUpdate } from './reply-stream.js';

/** Feed `text` to a filter in pieces of every size and return what it released. */
function runThink(pieces: string[]): { out: string; reset: boolean } {
  const filter = new ThinkTagFilter();
  let out = '';
  let reset = false;
  for (const piece of pieces) {
    const visible = filter.push(piece);
    if (filter.reset) {
      out = '';
      reset = true;
      filter.reset = false;
    }
    out += visible;
  }
  return { out: out + filter.flush(), reset };
}

function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('ThinkTagFilter', () => {
  it('strips think blocks whose tags are split across chunk boundaries', () => {
    const text = 'Hello <think>secret plan</think>world<THINK>more</Think>!';
    for (let size = 1; size <= text.length; size++) {
      expect(runThink(pieces(text, size)).out).toBe('Hello world!');
    }
  });

  it('drops everything after an unterminated <think>', () => {
    expect(runThink(['Answer. <thi', 'nk>still reasoning']).out).toBe('Answer. ');
  });

  it('treats text before an orphan </think> as reasoning', () => {
    const result = runThink(['reasoning without an open tag', '</thi', 'nk>Real answer']);
    expect(result).toEqual({ out: 'Real answer', reset: true });
  });

  it('releases a dangling partial tag that never completed', () => {
    expect(runThink(['a < b and x <thi']).out).toBe('a < b and x <thi');
  });
});

describe('DoneMarkerFilter', () => {
  function run(chunks: string[]): string {
    const filter = new DoneMarkerFilter();
    return chunks.map((c) => filter.push(c)).join('') + filter.flush();
  }

  it('drops a trailing [DONE] split across chunks', () => {
    expect(run(['All set.', ' [D', 'ON', 'E]', '\n'])).toBe('All set.');
    expect(run(['All set. [done]'])).toBe('All set.');
  });

  it('keeps brackets that are not the marker', () => {
    expect(run(['See [the docs](https://x) and [D', 'ata]'])).toBe('See [the docs](https://x) and [Data]');
    expect(run(['Marker [DONE] then more'])).toBe('Marker [DONE] then more');
  });
});

describe('ReplyStream', () => {
  function setup() {
    const updates: ReplyStreamUpdate[] = [];
    const stream = new ReplyStream(async (u) => { updates.push(u); });
    return { stream, updates };
  }

  it('emits visible deltas and holds back think text and the [DONE] marker', async () => {
    const { stream, updates } = setup();
    stream.begin(1);
    for (const piece of ['<think>hm', 'm</think>Hi', ' there', ' [DO', 'NE]']) stream.handlers.onTextDelta!(piece);
    await stream.end(false);
    expect(updates.map((u) => u.type)).toEqual(['text_delta', 'text_delta']);
    expect(updates.map((u) => u.message).join('')).toBe('Hi there');
    expect(updates.every((u) => u.iteration === 1)).toBe(true);
  });

  it('resets as soon as a tool call starts and ignores the rest of that call', async () => {
    const { stream, updates } = setup();
    stream.begin(1);
    stream.handlers.onTextDelta!('Let me check.');
    stream.handlers.onToolUseStart!('read_file');
    stream.handlers.onTextDelta!('ignored');
    await stream.end(true);
    expect(updates.map((u) => u.type)).toEqual(['text_delta', 'text_reset']);
  });

  it('resets leftover text when the next model call begins', async () => {
    const { stream, updates } = setup();
    stream.begin(1);
    stream.handlers.onTextDelta!('first draft');
    await stream.end(false);
    stream.begin(2);
    stream.handlers.onTextDelta!('second');
    await stream.end(false);
    expect(updates.map((u) => `${u.type}:${u.message}`)).toEqual([
      'text_delta:first draft',
      'text_reset:',
      'text_delta:second',
    ]);
  });

  it('sends no reset when nothing visible was streamed', async () => {
    const { stream, updates } = setup();
    stream.begin(1);
    stream.handlers.onTextDelta!('<think>only reasoning');
    stream.handlers.onToolUseStart!('bash');
    await stream.end(true);
    expect(updates).toEqual([]);
  });

  it('ignores deltas that arrive after the call ended (timed-out stream)', async () => {
    const { stream, updates } = setup();
    stream.begin(1);
    await stream.end(true);
    stream.handlers.onTextDelta!('late');
    await stream.end(true);
    expect(updates).toEqual([]);
  });

  it('a callback failure does not break the stream', async () => {
    const errors: string[] = [];
    let calls = 0;
    const stream = new ReplyStream(async () => {
      calls++;
      if (calls === 1) throw new Error('channel down');
    }, (e) => errors.push(e.message));
    stream.begin(1);
    stream.handlers.onTextDelta!('a');
    stream.handlers.onTextDelta!('b');
    await stream.end(false);
    expect(calls).toBe(2);
    expect(errors).toEqual(['channel down']);
  });
});
