import { describe, it, expect, vi } from 'vitest';
import { DynamicProvider } from './dynamic-provider.js';
import type { LLMProvider, CompletionResponse } from './types.js';

function ok(name: string): LLMProvider {
  return {
    name,
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: name }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: name,
    } as CompletionResponse),
  };
}

function fail(name: string, msg = 'boom'): LLMProvider {
  return { name, isAvailable: () => true, complete: vi.fn().mockRejectedValue(new Error(msg)) };
}

const REQ = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('DynamicProvider — single-resolver (no chain, back-compat)', () => {
  it('delegates complete() to the resolved provider', async () => {
    const dyn = new DynamicProvider(async () => ok('primary'), 'reranker');
    const res = await dyn.complete(REQ);
    expect((res.content[0] as { text: string }).text).toBe('primary');
  });

  it('throws when nothing resolves', async () => {
    const dyn = new DynamicProvider(async () => undefined, 'reranker');
    await expect(dyn.complete(REQ)).rejects.toThrow('No provider available');
  });

  it('reports available and propagates the primary error (no chain to fall back to)', async () => {
    const dyn = new DynamicProvider(async () => fail('primary'), 'reranker');
    expect(dyn.isAvailable()).toBe(true);
    await expect(dyn.complete(REQ)).rejects.toThrow('boom');
  });
});

describe('DynamicProvider — cascade chain', () => {
  it('returns the first provider that succeeds', async () => {
    const second = ok('second');
    const dyn = new DynamicProvider(async () => ok('first'), 'cognition', async () => [ok('first'), second]);
    const res = await dyn.complete(REQ);
    expect((res.content[0] as { text: string }).text).toBe('first');
    expect(second.complete).not.toHaveBeenCalled();
  });

  it('falls through to the next provider on error', async () => {
    const dyn = new DynamicProvider(async () => fail('first'), 'cognition', async () => [fail('first'), ok('second')]);
    const res = await dyn.complete(REQ);
    expect((res.content[0] as { text: string }).text).toBe('second');
  });

  it('throws the last error when all providers fail', async () => {
    const dyn = new DynamicProvider(
      async () => fail('first', 'e1'),
      'cognition',
      async () => [fail('first', 'e1'), fail('second', 'e2')],
    );
    await expect(dyn.complete(REQ)).rejects.toThrow('e2');
  });

  it('throws when the chain resolves empty', async () => {
    const dyn = new DynamicProvider(async () => undefined, 'cognition', async () => []);
    await expect(dyn.complete(REQ)).rejects.toThrow('No provider available');
  });

  it('logs a warning for each hop it falls through', async () => {
    const warn = vi.fn();
    const dyn = new DynamicProvider(
      async () => fail('first'),
      'cognition',
      async () => [fail('first'), ok('second')],
      { warn },
    );
    await dyn.complete(REQ);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'cognition', failed: 'first', fallback: 'second' }),
      expect.any(String),
    );
  });

  it('does not log on the final provider', async () => {
    const warn = vi.fn();
    const dyn = new DynamicProvider(async () => ok('only'), 'cognition', async () => [ok('only')], { warn });
    await dyn.complete(REQ);
    expect(warn).not.toHaveBeenCalled();
  });
});
