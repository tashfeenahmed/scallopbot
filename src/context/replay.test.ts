import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import { compactCompletedConversationHistory } from '../memory/session-message-view.js';
import { buildReplayMessages, capImages, ensureToolPairing, MISSING_TOOL_RESULT, stubToolResult } from './replay.js';
import { leanCompact } from './lean-compaction.js';
import { makeToolSession, pairingViolations } from './test-fixtures.js';

describe('buildReplayMessages (no compaction yet)', () => {
  it('replays prior turns in full, including their tool calls and results', () => {
    const messages = makeToolSession(12, { tools: 2, resultChars: 200 });
    const replay = buildReplayMessages(messages);
    expect(replay).toEqual(messages);
    // The old 8-turn visible-text window drops all of that tool history.
    const old = compactCompletedConversationHistory(messages);
    expect(old.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.id === 'call_0'))).toBe(false);
    expect(replay.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.id === 'call_0'))).toBe(true);
  });

  it('drops empty messages, internal notes and reasoning-only rows from completed turns only', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      { role: 'assistant', content: '' },
      { role: 'user', content: '[System: background job finished]' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'latest question' },
      { role: 'user', content: '[System: active-turn note]' },
    ];
    const replay = buildReplayMessages(messages);
    expect(replay).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'latest question' },
      // The active turn (latest genuine human message onwards) is kept verbatim.
      { role: 'user', content: '[System: active-turn note]' },
    ]);
  });

  it('parses stored JSON content rows but keeps a human_user string literal', () => {
    const replay = buildReplayMessages([
      { role: 'user', content: '[{"type":"text","text":"literal"}]', messageKind: 'human_user' },
      { role: 'assistant', content: '[{"type":"text","text":"parsed"}]', messageKind: 'assistant_final' },
    ]);
    expect(replay[0].content).toBe('[{"type":"text","text":"literal"}]');
    expect(replay[1].content).toEqual([{ type: 'text', text: 'parsed' }]);
  });

  it('drops leading assistant messages', () => {
    const replay = buildReplayMessages([
      { role: 'assistant', content: 'Good morning! (proactive)' },
      { role: 'user', content: 'hi' },
    ]);
    expect(replay[0]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('ensureToolPairing', () => {
  it('synthesises a result for a tool_use whose result is missing', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'b', name: 'bash', input: { command: 'pwd' } }] },
      { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'bash', input: {} }] },
    ];
    const repaired = ensureToolPairing(messages);
    expect(pairingViolations(repaired)).toEqual([]);
    expect(repaired[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'x' },
      { type: 'tool_result', tool_use_id: 'b', content: MISSING_TOOL_RESULT, is_error: true },
      { type: 'text', text: 'note' },
    ]);
    expect(repaired[4]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: MISSING_TOOL_RESULT, is_error: true }] });
  });

  it('removes orphan tool_results and the message when nothing else remains', () => {
    const repaired = ensureToolPairing([
      { role: 'user', content: 'go' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(repaired).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }]);
  });

  it('returns well-formed pairs by reference', () => {
    const messages = makeToolSession(2);
    const repaired = ensureToolPairing(messages);
    repaired.forEach((message, index) => expect(message).toBe(messages[index]));
  });
});

describe('free pass', () => {
  it('stubs describe the call and outcome in one line', () => {
    expect(stubToolResult({ type: 'tool_use', id: '1', name: 'bash', input: { command: 'npm test' } },
      { type: 'tool_result', tool_use_id: '1', content: `{"exitCode":1}\n${'z'.repeat(3_200)}` }))
      .toMatch(/^\[bash\] npm test → exit 1 \(3\.2k chars; stubbed/);
    expect(stubToolResult({ type: 'tool_use', id: '1', name: 'web_fetch', input: { url: 'https://x.dev' } },
      { type: 'tool_result', tool_use_id: '1', content: 'Error: 404 not found', is_error: true }))
      .toMatch(/^\[web_fetch\] https:\/\/x\.dev → error: 404 not found/);
  });

  it('dedupes identical results and keeps tool_use input byte-identical after compaction', async () => {
    const messages = makeToolSession(30, { tools: 2, resultChars: 3_000 });
    const result = (await leanCompact({ messages, windowTokens: 128_000 }))!;
    expect(pairingViolations(result.messages)).toEqual([]);
    const replayAgain = buildReplayMessages(messages, { compactionState: result.state });
    expect(replayAgain).toEqual(result.messages);
  });

  it('caps images to the newest three', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'A' } };
    const capped = capImages(Array.from({ length: 5 }, (): Message => ({ role: 'user', content: [image] })));
    expect(capped.slice(2).every(message => (message.content as { type: string }[])[0].type === 'image')).toBe(true);
    expect(capped.slice(0, 2).every(message => (message.content as { type: string }[])[0].type === 'text')).toBe(true);
  });
});
