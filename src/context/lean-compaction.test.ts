import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import {
  COMPACTION_PREFIX,
  COMPACTION_SUFFIX,
  QUOTED_USER_CHARS,
  compactionThresholdRatio,
  computeBoundaries,
  deterministicSummary,
  estimateTokens,
  evaluateCompactionTrigger,
  isValidSummary,
  leanCompact,
  prepareContext,
  quoteAssistantReplies,
  quoteUserMessages,
  shouldCompact,
  tailBudgetTokens,
} from './lean-compaction.js';
import { isGenuineHuman } from './replay.js';
import { loadCompactionState, type CompactionStore } from './compaction-state.js';
import { emptyAnchors } from './anchors.js';
import { FakeProvider, VALID_SUMMARY, makeToolSession, pairingViolations } from './test-fixtures.js';

class MemoryStore implements CompactionStore {
  rows = new Map<string, { stateJson: string; summaryMessage: string; compactionCount: number }>();
  saves = 0;
  getSessionCompaction(sessionId: string) { return this.rows.get(sessionId) ?? null; }
  saveSessionCompaction(sessionId: string, stateJson: string, summaryMessage: string, compactionCount: number) {
    this.saves++;
    this.rows.set(sessionId, { stateJson, summaryMessage, compactionCount });
  }
}

function textOf(message: Message): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

describe('trigger', () => {
  it('uses 50% for windows >= 512k and 75% below', () => {
    expect(compactionThresholdRatio(1_000_000)).toBe(0.5);
    expect(compactionThresholdRatio(512_000)).toBe(0.5);
    expect(compactionThresholdRatio(200_000)).toBe(0.75);
    expect(shouldCompact({ windowTokens: 200_000, promptTokens: 149_999 })).toBe(false);
    expect(shouldCompact({ windowTokens: 200_000, promptTokens: 150_000 })).toBe(true);
    expect(shouldCompact({ windowTokens: 1_000_000, promptTokens: 500_000 })).toBe(true);
    expect(shouldCompact({ windowTokens: 1_000_000, promptTokens: 499_000 })).toBe(false);
  });

  it('prefers real prompt tokens (plus the delta) over the estimate', () => {
    const real = evaluateCompactionTrigger({ windowTokens: 100_000, promptTokens: 70_000, addedTokensSincePrompt: 6_000, estimatedTokens: 10 });
    expect(real).toMatchObject({ compact: true, usedTokens: 76_000, source: 'provider' });
    const estimate = evaluateCompactionTrigger({ windowTokens: 100_000, promptTokens: 0, estimatedTokens: 80_000 });
    expect(estimate).toMatchObject({ compact: true, source: 'estimate' });
  });

  it('clamps the tail budget to 10k-25k tokens', () => {
    expect(tailBudgetTokens(128_000)).toBe(10_000);
    expect(tailBudgetTokens(800_000)).toBe(20_000);
    expect(tailBudgetTokens(2_000_000)).toBe(25_000);
  });
});

describe('computeBoundaries', () => {
  it('keeps a 3-message head, >= 8 tail messages and starts the tail on a genuine user message', () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const boundaries = computeBoundaries(messages, 128_000)!;
    expect(boundaries.headEnd).toBe(3);
    expect(messages.length - boundaries.tailStart).toBeGreaterThanOrEqual(8);
    expect(isGenuineHuman(messages[boundaries.tailStart])).toBe(true);
    expect(estimateTokens(messages.slice(boundaries.tailStart))).toBeGreaterThanOrEqual(10_000);
  });

  it('never ends the head between a tool_use and its tool_result', () => {
    const messages = makeToolSession(20, { tools: 3 });
    // Turn 0 = user, use, result, use, result, use, result, final; 3 is safe (after a result).
    const boundaries = computeBoundaries(messages, 128_000)!;
    const head = messages.slice(0, boundaries.headEnd);
    expect(pairingViolations(head)).toEqual([]);
    expect(head.at(-1)?.role).toBe('user');
  });

  it('returns null when there is nothing to compact', () => {
    expect(computeBoundaries(makeToolSession(2), 128_000)).toBeNull();
  });

  it('cuts inside one huge turn at a safe step boundary and stubs older results', () => {
    const messages = makeToolSession(1, { tools: 60, resultChars: 4_000 });
    const boundaries = computeBoundaries(messages, 128_000)!;
    expect(boundaries).not.toBeNull();
    const before = messages[boundaries.tailStart - 1];
    const first = messages[boundaries.tailStart];
    expect(Array.isArray(before.content) && before.content.some(block => block.type === 'tool_use')).toBe(false);
    expect(Array.isArray(first.content) && first.content.some(block => block.type === 'tool_result')).toBe(false);
  });
});

describe('quoteUserMessages', () => {
  it('quotes genuine user messages verbatim, newest first, excluding tool results and harness notes', () => {
    const span: Message[] = [
      { role: 'user', content: 'first: deploy to staging only' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
      { role: 'user', content: '[System: background task finished]' },
      { role: 'user', content: '[kind: reminder] drink water' },
      { role: 'user', content: 'second: and use the blue theme' },
    ];
    expect(quoteUserMessages(span)).toEqual(['second: and use the blue theme', 'first: deploy to staging only']);
  });

  it('caps the quoted total at 24k chars and appends earlier quotes after new ones', () => {
    const big = 'q'.repeat(20_000);
    const quotes = quoteUserMessages([{ role: 'user', content: big }, { role: 'user', content: 'newest' }], ['older-1', 'older-2']);
    expect(quotes[0]).toBe('newest');
    expect(quotes[1]).toBe(big);
    expect(quotes.join('').length).toBeLessThanOrEqual(QUOTED_USER_CHARS + 20);
    const overflow = quoteUserMessages([{ role: 'user', content: 'z'.repeat(30_000) }]);
    expect(overflow[0].endsWith('…[truncated]')).toBe(true);
  });
});

describe('leanCompact', () => {
  it('produces a prefixed summary message with sections, anchors, quotes and the session_search pointer', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const provider = new FakeProvider(VALID_SUMMARY);
    const result = (await leanCompact({ messages, windowTokens: 128_000, provider, extraState: 'Todo: [ ] ship it' }))!;
    expect(result.usedFallback).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].purpose).toBe('compaction_summary');
    const summary = result.state.summaryMessage;
    expect(summary.startsWith(COMPACTION_PREFIX)).toBe(true);
    expect(summary.trim().endsWith(COMPACTION_SUFFIX)).toBe(true);
    expect(summary).toContain('## Completed Actions');
    expect(summary).toContain('## Anchor Index');
    expect(summary).toContain('PRs/issues: #');
    expect(summary).toContain('src/module3.ts');
    expect(summary).toContain('Turn 3: please check src/module3.ts and run the tests (preference: use pnpm)');
    expect(summary).toContain('## Live State\nTodo: [ ] ship it');
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 2);
  });

  it('keeps every tool_use paired and never rewrites tool_use arguments', async () => {
    const messages = makeToolSession(40, { tools: 3, resultChars: 2_500 });
    const result = (await leanCompact({ messages, windowTokens: 128_000, provider: new FakeProvider(VALID_SUMMARY) }))!;
    expect(pairingViolations(result.messages)).toEqual([]);
    const originalUses = new Map<string, string>();
    for (const message of messages) {
      if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_use') originalUses.set(block.id, JSON.stringify(block.input));
    }
    for (const message of result.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'tool_use') expect(JSON.stringify(block.input)).toBe(originalUses.get(block.id));
      }
    }
  });

  it('stubs old tool results in the head with a one-line description from the paired tool_use', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const result = (await leanCompact({ messages, windowTokens: 128_000, provider: new FakeProvider(VALID_SUMMARY) }))!;
    const headResult = result.messages[2];
    expect(Array.isArray(headResult.content)).toBe(true);
    const block = (headResult.content as Extract<Message['content'], unknown[]>)[0] as { content: string };
    expect(block.content).toMatch(/^\[read_file\] src\/module0\.ts lines 1-200 → export const value0 = 0; \(3\.0k chars/);
  });

  it('falls back to a deterministic summary when the summary call fails or times out', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const failing = new FakeProvider(() => { throw new Error('boom'); });
    const errors: unknown[] = [];
    const failed = (await leanCompact({ messages, windowTokens: 128_000, provider: failing, onSummaryError: error => errors.push(error) }))!;
    expect(failed.usedFallback).toBe(true);
    expect(errors).toHaveLength(1);
    expect(failed.state.summaryMessage).toContain('Deterministic summary');
    expect(failed.state.summaryMessage).toMatch(/\d+\. (RAN|FAILED) .* — .* \[(bash|read_file)\]/);

    const slow = new FakeProvider(() => new Promise(resolve => setTimeout(() => resolve(VALID_SUMMARY), 1_000)));
    const timedOut = (await leanCompact({ messages, windowTokens: 128_000, provider: slow, summaryTimeoutMs: 20 }))!;
    expect(timedOut.usedFallback).toBe(true);

    const malformed = (await leanCompact({ messages, windowTokens: 128_000, provider: new FakeProvider('ok') }))!;
    expect(malformed.usedFallback).toBe(true);
  });

  it('is deterministic without a provider', async () => {
    const messages = makeToolSession(30);
    const a = (await leanCompact({ messages, windowTokens: 128_000, now: 1 }))!;
    const b = (await leanCompact({ messages, windowTokens: 128_000, now: 1 }))!;
    expect(a.state.summaryMessage).toBe(b.state.summaryMessage);
    expect(a.messages).toEqual(b.messages);
  });

  it('updates the summary iteratively: previous summary + new turns, quotes carried forward', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const first = (await leanCompact({ messages, windowTokens: 128_000, provider: new FakeProvider(VALID_SUMMARY) }))!;
    const grown = [...messages, ...makeToolSession(30, { tools: 2, resultChars: 3_000 }).map(message => (
      typeof message.content === 'string' ? { ...message, content: message.content.replace('Turn ', 'Later turn ') } : message
    ))];
    // Re-key tool ids so they stay unique.
    let counter = 0;
    const rekeyed: Message[] = grown.map((message, index) => {
      if (index < messages.length || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map(block => block.type === 'tool_use'
          ? { ...block, id: `late_${block.id}` }
          : block.type === 'tool_result' ? { ...block, tool_use_id: `late_${block.tool_use_id}` } : block),
      };
    });
    counter++;
    const provider = new FakeProvider(VALID_SUMMARY);
    const second = (await leanCompact({ messages: rekeyed, windowTokens: 128_000, provider, previous: first.state }))!;
    expect(counter).toBe(1);
    expect(second.state.compactionCount).toBe(2);
    expect(second.state.headEnd).toBe(first.state.headEnd);
    expect(second.state.tailStart).toBeGreaterThan(first.state.tailStart);
    const prompt = String(provider.requests[0].messages[0].content);
    expect(prompt).toContain('PREVIOUS SUMMARY');
    expect(prompt).toContain('keep everything still relevant');
    // Newest quotes first, earlier compaction's quotes still present.
    const quotes = second.state.quotedUserMessages;
    expect(quotes[0]).toMatch(/^Later turn/);
    expect(quotes).toContain(first.state.quotedUserMessages[0]);
    expect(pairingViolations(second.messages)).toEqual([]);
    // The span compacted the second time starts exactly at the old tail.
    expect(prompt).toContain(`[#${first.state.tailStart} USER]`);
  });

  it('keeps only the newest 3 images', async () => {
    const messages = makeToolSession(30, { tools: 1, resultChars: 3_000 });
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } };
    const withImages: Message[] = [...messages];
    for (let index = 0; index < 5; index++) {
      withImages.push({ role: 'user', content: [{ type: 'text', text: `photo ${index}` }, image] });
      withImages.push({ role: 'assistant', content: `nice photo ${index}` });
    }
    const result = (await leanCompact({ messages: withImages, windowTokens: 128_000 }))!;
    const images = result.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : []);
    expect(images).toHaveLength(3);
    expect(result.messages.some(message => textOf(message).includes('older image omitted'))).toBe(true);
  });
});

describe('prepareContext', () => {
  it('compacts once over the threshold, persists, and replays a stable prefix afterwards', async () => {
    const store = new MemoryStore();
    const messages = makeToolSession(40, { tools: 2, resultChars: 3_000 });
    const provider = new FakeProvider(VALID_SUMMARY);
    const below = await prepareContext({ sessionId: 's1', messages, windowTokens: 1_000_000, provider, store });
    expect(below.compacted).toBe(false);
    expect(store.saves).toBe(0);

    const first = await prepareContext({ sessionId: 's1', messages, windowTokens: 100_000, provider, store, promptTokens: 90_000 });
    expect(first.compacted).toBe(true);
    expect(store.saves).toBe(1);
    expect(loadCompactionState(store, 's1')?.compactionCount).toBe(1);

    // Append a turn: no new compaction, replay prefix byte-identical (cacheable).
    const grown: Message[] = [...messages, { role: 'user', content: 'one more thing' }];
    const next = await prepareContext({ sessionId: 's1', messages: grown, windowTokens: 100_000, provider, store, promptTokens: 20_000 });
    expect(next.compacted).toBe(false);
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    expect(next.messages.at(-1)).toEqual({ role: 'user', content: 'one more thing' });
  });

  it('ignores a stored state whose boundary no longer matches the transcript', async () => {
    const store = new MemoryStore();
    const messages = makeToolSession(40, { tools: 2, resultChars: 3_000 });
    await prepareContext({ sessionId: 's1', messages, windowTokens: 100_000, store, promptTokens: 90_000 });
    const other = messages.map(message => (message.role === 'assistant' && typeof message.content === 'string'
      ? { ...message, content: `${message.content} (rewritten)` }
      : message));
    const replay = await prepareContext({ sessionId: 's1', messages: other, windowTokens: 1_000_000, store });
    expect(replay.state).toBeNull();
    expect(replay.messages.some(message => textOf(message).includes(COMPACTION_PREFIX))).toBe(false);
  });
});

describe('summary validation + deterministic summary', () => {
  it('requires most fixed sections', () => {
    expect(isValidSummary(VALID_SUMMARY)).toBe(true);
    expect(isValidSummary('## Goal\nstuff')).toBe(false);
  });

  it('lists actions as "N. ACTION target — outcome [tool]"', () => {
    const span = makeToolSession(2);
    const text = deterministicSummary({ span, quotes: ['latest ask'], anchors: { ...emptyAnchors(), files: ['src/a.ts'] } });
    expect(text).toContain('1. RAN src/module0.ts lines 1-200 — export const value0 = 0; [read_file]');
    expect(text).toMatch(/2\. FAILED npm test -- module0 — error: FAILED module0\.test\.ts \[bash\]/);
    expect(text).toContain('## Relevant Files\nsrc/a.ts');
  });
});

describe('assistant reply excerpts', () => {
  it('quotes visible assistant replies newest first, skipping tool-call protocol', () => {
    const span: Message[] = [
      { role: 'user', content: 'count them' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: { command: 'wc -l' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '945' }] },
      { role: 'assistant', content: 'There are 945 entries.' },
      { role: 'user', content: 'and duplicates?' },
      { role: 'assistant', content: 'I removed 17 duplicate rows.' },
    ];
    expect(quoteAssistantReplies(span)).toEqual(['I removed 17 duplicate rows.', 'There are 945 entries.']);
    // Older replies from a previous compaction come after, within the budget.
    expect(quoteAssistantReplies(span, ['older reply'], 60)).toEqual(['I removed 17 duplicate rows.', 'There are 945 entries.']);
    expect(quoteAssistantReplies(span, ['older reply'])).toEqual(['I removed 17 duplicate rows.', 'There are 945 entries.', 'older reply']);
  });

  it('renders the excerpts into the summary message and state', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const result = (await leanCompact({ messages, windowTokens: 128_000 }))!;
    expect(result.state.summaryMessage).toContain('## Your Earlier Replies (verbatim excerpts, newest first)');
    expect(result.state.summaryMessage).toContain('Commit a1b2c3d');
    expect(result.state.assistantReplies?.length).toBeGreaterThan(0);
  });
});
