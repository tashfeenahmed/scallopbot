import { describe, it, expect } from 'vitest';
import { gatherAdvice, withMoaAdvice, formatAdviceMessage, isMoaEnabled, selectAdvisors } from './moa.js';
import type { LLMProvider, CompletionRequest, Message } from '../providers/types.js';
import { Router } from '../routing/router.js';

function advisor(name: string, reply: string | Error, delayMs = 0): LLMProvider & { requests: CompletionRequest[] } {
  const provider = {
    name,
    model: `${name}-model`,
    requests: [] as CompletionRequest[],
    isAvailable: () => true,
    async complete(request: CompletionRequest) {
      provider.requests.push(request);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      if (reply instanceof Error) throw reply;
      return { content: [{ type: 'text' as const, text: reply }], stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 }, model: `${name}-model` };
    },
  };
  return provider;
}

const conversation: Message[] = [
  { role: 'user', content: 'Refactor the parser without breaking the API.' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'parser.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function parse() {}' }] },
];

describe('mixture of agents', () => {
  it('is off unless MOA_ENABLED is set', () => {
    expect(isMoaEnabled({})).toBe(false);
    expect(isMoaEnabled({ MOA_ENABLED: 'true' })).toBe(true);
    expect(isMoaEnabled({ MOA_ENABLED: '0' })).toBe(false);
  });

  it('asks advisors in parallel with a tool-free transcript and drops failures and timeouts', async () => {
    const a = advisor('anthropic', 'Keep parse() signature; add tests first.');
    const b = advisor('openai', new Error('rate limited'));
    const c = advisor('moonshot', 'too slow', 200);
    const advice = await gatherAdvice(conversation, { advisors: [a, b, c], timeoutMs: 50 });
    expect(advice).toEqual([{ provider: 'anthropic', model: 'anthropic-model', text: 'Keep parse() signature; add tests first.' }]);
    expect(a.requests[0].tools).toBeUndefined();
    const flattened = a.requests[0].messages.map(m => m.content).join('\n');
    expect(flattened).toContain('[tool call read_file');
    expect(flattened).toContain('[tool result] export function parse() {}');
  });

  it('attaches advice to the trailing user turn with a [moa-advice] header', async () => {
    const { messages, advice } = await withMoaAdvice(conversation, {
      advisors: [advisor('anthropic', 'Add tests.'), advisor('openai', 'Watch the default export.')],
    });
    expect(advice).toHaveLength(2);
    expect(messages).toHaveLength(conversation.length);
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string; text?: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks.at(-1)!.text).toMatch(/^\[moa-advice: 2 advisors\]/);
    expect(formatAdviceMessage(advice)).toContain('Watch the default export.');
  });

  it('appends a new user message after an assistant turn and is a no-op without advice', async () => {
    const endsOnAssistant: Message[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const out = await withMoaAdvice(endsOnAssistant, { advisors: [advisor('anthropic', 'Ask what they need.')] });
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2].content).toMatch(/^\[moa-advice: 1 advisor\]/);
    const none = await withMoaAdvice(endsOnAssistant, { advisors: [advisor('openai', new Error('down'))] });
    expect(none.messages).toBe(endsOnAssistant);
  });

  it('selects distinct healthy advisors, capable tier first, excluding the main model', () => {
    const router = new Router({});
    for (const name of ['anthropic', 'openai', 'moonshot', 'groq']) router.registerProvider(advisor(name, 'x'));
    const picked = selectAdvisors(router, { count: 2, exclude: ['anthropic'] }).map(p => p.name);
    expect(picked).toHaveLength(2);
    expect(picked).not.toContain('anthropic');
    expect(new Set(picked).size).toBe(2);
  });
});
