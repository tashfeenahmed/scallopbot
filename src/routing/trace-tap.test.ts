import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { wrapProviderWithTraceTap, setTraceSink, type LlmTraceRow } from './trace-tap.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

function makeProvider(response: Partial<CompletionResponse>): LLMProvider & { model: string } {
  return {
    name: 'fake',
    model: 'fake-1',
    isAvailable: () => true,
    complete: async () => ({
      content: [{ type: 'text', text: '{"ok": true}' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'fake-1',
      ...response,
    } as CompletionResponse),
  };
}

describe('wrapProviderWithTraceTap', () => {
  let rows: LlmTraceRow[];
  let previousMode: string | undefined;

  beforeEach(() => {
    rows = [];
    previousMode = process.env.LLM_TRACE_CONTENT_MODE;
    process.env.LLM_TRACE_CONTENT_MODE = 'full';
    setTraceSink((r) => rows.push(r));
  });

  afterEach(() => {
    setTraceSink(null);
    if (previousMode === undefined) delete process.env.LLM_TRACE_CONTENT_MODE;
    else process.env.LLM_TRACE_CONTENT_MODE = previousMode;
  });

  it('records tagged calls with parsed_ok=1 for valid JSON', async () => {
    const p = wrapProviderWithTraceTap(makeProvider({}));
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'fact_extract', maxTokens: 777 });
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('fact_extract');
    expect(rows[0].parsedOk).toBe(1);
    expect(rows[0].provider).toBe('fake');
    expect(rows[0].stopReason).toBe('end_turn');
    expect(rows[0].requestMaxTokens).toBe(777);
    expect(rows[0].modelContextWindowTokens).toBeGreaterThan(0);
    expect(rows[0].modelMaxOutputTokens).toBeGreaterThan(0);
  });

  it('records parsed_ok=0 when a JSON purpose returns unparseable text', async () => {
    const p = wrapProviderWithTraceTap(
      makeProvider({ content: [{ type: 'text', text: 'sorry, no json today' }] })
    );
    await p.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'rerank' });
    expect(rows[0].parsedOk).toBe(0);
  });

  it('does not record untagged tool-less calls', async () => {
    const p = wrapProviderWithTraceTap(makeProvider({}));
    await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rows).toHaveLength(0);
  });

  it('implicitly tags tool-bearing requests as tool_call', async () => {
    const p = wrapProviderWithTraceTap(
      makeProvider({
        content: [{ type: 'tool_use', id: 't1', name: 'board', input: { action: 'view' } }],
        stopReason: 'tool_use',
      })
    );
    await p.complete({
      messages: [{ role: 'user', content: 'show board' }],
      tools: [{ name: 'board', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('tool_call');
    expect(rows[0].parsedOk).toBe(1);
  });

  it('flags textual tool-call markup as parsed_ok=0', async () => {
    const p = wrapProviderWithTraceTap(
      makeProvider({ content: [{ type: 'text', text: '<tool_call>{"name": "board", "arguments": {}}</tool_call>' }] })
    );
    await p.complete({
      messages: [{ role: 'user', content: 'show board' }],
      tools: [{ name: 'board', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
    expect(rows[0].parsedOk).toBe(0);
  });

  it('treats a plain text answer with tools available as a valid no-tool decision', async () => {
    const p = wrapProviderWithTraceTap(
      makeProvider({ content: [{ type: 'text', text: 'You have 3 items on your board.' }] })
    );
    await p.complete({
      messages: [{ role: 'user', content: 'how many items' }],
      tools: [{ name: 'board', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
    expect(rows[0].parsedOk).toBe(1);
  });

  it('serializes the full request (system + messages + tools) into prompt', async () => {
    const p = wrapProviderWithTraceTap(makeProvider({}));
    await p.complete({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be helpful',
      purpose: 'fact_extract',
      traceSessionId: 'sess-1',
    });
    const prompt = JSON.parse(rows[0].prompt);
    expect(prompt.system).toBe('be helpful');
    expect(prompt.messages).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess-1');
  });

  it('redacts secrets before persisting prompts and responses', async () => {
    const previous = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = 'trace-secret-value-123';
    try {
      const p = wrapProviderWithTraceTap(makeProvider({
        content: [{ type: 'text', text: 'response leaked trace-secret-value-123' }],
      }));
      await p.complete({
        messages: [{ role: 'user', content: 'prompt leaked trace-secret-value-123' }],
        purpose: 'tool_call',
      });
      expect(rows[0].prompt).not.toContain('trace-secret-value-123');
      expect(rows[0].response).not.toContain('trace-secret-value-123');
      expect(rows[0].prompt).toContain('[REDACTED]');
      expect(rows[0].response).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.TEST_API_KEY;
      else process.env.TEST_API_KEY = previous;
    }
  });

  it('retains only hashes and sizes by default', async () => {
    delete process.env.LLM_TRACE_CONTENT_MODE;
    const p = wrapProviderWithTraceTap(makeProvider({}));
    await p.complete({
      messages: [{ role: 'user', content: 'private conversation payload' }],
      purpose: 'fact_extract',
    });
    expect(rows[0].prompt).not.toContain('private conversation payload');
    expect(JSON.parse(rows[0].prompt)).toMatchObject({ content_retained: false });
    expect(JSON.parse(rows[0].response)).toMatchObject({ content_retained: false });
  });

  it('passes through when no sink is set', async () => {
    setTraceSink(null);
    const p = wrapProviderWithTraceTap(makeProvider({}));
    const res = await p.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'fact_extract' });
    expect(res.usage.outputTokens).toBe(5);
    expect(rows).toHaveLength(0);
  });

  it('a throwing sink never breaks the call', async () => {
    setTraceSink(() => { throw new Error('disk full'); });
    const p = wrapProviderWithTraceTap(makeProvider({}));
    const res = await p.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'fact_extract' });
    expect(res.model).toBe('fake-1');
  });

  it('preserves provider properties through the proxy', () => {
    const raw = makeProvider({});
    const p = wrapProviderWithTraceTap(raw) as LLMProvider & { model: string };
    expect(p.name).toBe('fake');
    expect(p.model).toBe('fake-1');
    expect(p.isAvailable()).toBe(true);
  });
});
