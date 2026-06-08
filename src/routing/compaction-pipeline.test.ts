import { describe, it, expect, vi } from 'vitest';
import {
  estimateMessagesTokens,
  dedupeToolOutputs,
  snipToolOutputs,
  dropOldThinking,
  pruneToolOutputs,
  compactSync,
  compact,
} from './compaction-pipeline.js';
import type { Message, LLMProvider, ContentBlock } from '../providers/types.js';

function toolResult(id: string, content: string): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}
function toolUse(id: string, name = 'bash'): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

describe('estimateMessagesTokens', () => {
  it('estimates ~4 chars per token across block types', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'a'.repeat(40) }, // ~10 tokens
      toolResult('t1', 'b'.repeat(40)), // ~10 tokens
    ];
    expect(estimateMessagesTokens(msgs)).toBe(20);
  });

  it('counts thinking blocks', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(80) }] as ContentBlock[] },
    ];
    expect(estimateMessagesTokens(msgs)).toBe(20);
  });
});

describe('dedupeToolOutputs', () => {
  it('replaces later identical tool outputs with a reference', () => {
    const big = 'DUPLICATE'.repeat(20);
    const msgs = [toolUse('a'), toolResult('a', big), toolUse('b'), toolResult('b', big), toolUse('c'), toolResult('c', big)];
    const out = dedupeToolOutputs(msgs, 0);
    const bodies = out.filter((m) => Array.isArray(m.content)).map((m) => (m.content as ContentBlock[])[0]);
    const toolResults = bodies.filter((b) => b.type === 'tool_result') as { content: string }[];
    expect(toolResults[0].content).toBe(big); // first kept
    expect(toolResults[1].content).toMatch(/Identical to earlier tool output #1/);
    expect(toolResults[2].content).toMatch(/Identical to earlier tool output #1/);
  });

  it('ignores short outputs below minChars', () => {
    const msgs = [toolResult('a', 'tiny'), toolResult('b', 'tiny')];
    const out = dedupeToolOutputs(msgs, 0, 100);
    expect((out[1].content as ContentBlock[])[0]).toMatchObject({ content: 'tiny' });
  });

  it('preserves the last N messages verbatim', () => {
    const big = 'D'.repeat(200);
    const msgs = [toolResult('a', big), toolResult('b', big)];
    const out = dedupeToolOutputs(msgs, 2); // preserve both
    expect((out[1].content as ContentBlock[])[0]).toMatchObject({ content: big });
  });
});

describe('snipToolOutputs', () => {
  it('truncates oversized tool outputs and notes dropped chars', () => {
    const huge = 'x'.repeat(10000);
    const msgs = [toolResult('a', huge), { role: 'user' as const, content: 'recent' }];
    const out = snipToolOutputs(msgs, 100, 1);
    const body = (out[0].content as ContentBlock[])[0] as { content: string };
    expect(body.content).toMatch(/\[\.\.\.snipped 9900 chars\]/);
    expect(body.content.length).toBeLessThan(huge.length);
  });
});

describe('dropOldThinking', () => {
  it('removes thinking blocks from older messages', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }] as ContentBlock[] },
      { role: 'user', content: 'recent' },
    ];
    const out = dropOldThinking(msgs, 1);
    expect((out[0].content as ContentBlock[]).some((b) => b.type === 'thinking')).toBe(false);
    expect((out[0].content as ContentBlock[]).some((b) => b.type === 'text')).toBe(true);
  });

  it('does not empty a thinking-only message', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }] as ContentBlock[] },
      { role: 'user', content: 'recent' },
    ];
    const out = dropOldThinking(msgs, 1);
    expect((out[0].content as ContentBlock[]).length).toBe(1); // untouched
  });
});

describe('pruneToolOutputs', () => {
  it('replaces old tool bodies with size placeholders', () => {
    const body = 'y'.repeat(500);
    const msgs = [toolResult('a', body), { role: 'user' as const, content: 'recent' }];
    const out = pruneToolOutputs(msgs, 1);
    expect((out[0].content as ContentBlock[])[0]).toMatchObject({ content: '[pruned: 500 chars]' });
  });

  it('is idempotent (does not re-prune placeholders)', () => {
    const msgs = [toolResult('a', '[pruned: 500 chars]'), { role: 'user' as const, content: 'recent' }];
    const out = pruneToolOutputs(msgs, 1);
    expect((out[0].content as ContentBlock[])[0]).toMatchObject({ content: '[pruned: 500 chars]' });
  });
});

describe('compactSync', () => {
  it('returns unchanged when already under budget', () => {
    const msgs: Message[] = [{ role: 'user', content: 'short' }];
    const r = compactSync(msgs, { targetTokens: 1000 });
    expect(r.fits).toBe(true);
    expect(r.stagesApplied).toEqual([]);
    expect(r.messages).toBe(msgs);
  });

  it('applies stages cheapest-first and stops once under budget', () => {
    // Two identical huge tool outputs: dedupe alone should get under budget.
    const big = 'Z'.repeat(40000); // ~10k tokens each
    const msgs = [
      toolUse('a'), toolResult('a', big),
      toolUse('b'), toolResult('b', big),
      { role: 'user' as const, content: 'recent 1' },
      { role: 'user' as const, content: 'recent 2' },
    ];
    const r = compactSync(msgs, { targetTokens: 6000, preserveLastN: 2 });
    expect(r.estimatedTokensAfter).toBeLessThan(r.estimatedTokensBefore);
    expect(r.stagesApplied[0]).toBe('dedupeToolOutputs');
    expect(r.fits).toBe(true);
  });

  it('escalates through multiple stages when needed', () => {
    // Distinct huge outputs so dedupe can't help — needs snip/prune.
    const msgs: Message[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(toolUse(`u${i}`));
      msgs.push(toolResult(`u${i}`, `unique-${i}-` + 'q'.repeat(40000)));
    }
    msgs.push({ role: 'user', content: 'recent' });
    const r = compactSync(msgs, { targetTokens: 5000, preserveLastN: 1 });
    expect(r.estimatedTokensAfter).toBeLessThan(r.estimatedTokensBefore);
    expect(r.stagesApplied).toContain('snipToolOutputs');
  });
});

describe('compact (async with LLM escalation)', () => {
  it('skips the summary stage when sync stages already fit', async () => {
    const provider = { name: 'fake', complete: vi.fn(), isAvailable: () => true } as unknown as LLMProvider;
    const big = 'Z'.repeat(40000);
    const msgs = [toolUse('a'), toolResult('a', big), toolUse('b'), toolResult('b', big), { role: 'user' as const, content: 'r1' }, { role: 'user' as const, content: 'r2' }];
    const r = await compact(msgs, { targetTokens: 6000, preserveLastN: 2, provider });
    expect(r.fits).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('escalates to LLM summary when cheap stages are insufficient', async () => {
    const provider = {
      name: 'fake',
      isAvailable: () => true,
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'SUMMARY' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
      }),
    } as unknown as LLMProvider;
    // Many distinct large messages that cheap stages can shrink but not enough.
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i} ` + 'w'.repeat(2000) });
    }
    const r = await compact(msgs, { targetTokens: 500, preserveLastN: 4, provider });
    expect(provider.complete).toHaveBeenCalled();
    expect(r.stagesApplied).toContain('summarizeOldest');
  });

  it('falls back gracefully to sync result without a provider', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: 'w'.repeat(2000) });
    const r = await compact(msgs, { targetTokens: 500, preserveLastN: 4 });
    expect(r.stagesApplied).not.toContain('summarizeOldest');
  });
});
