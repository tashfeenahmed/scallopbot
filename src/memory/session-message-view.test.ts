import { describe, expect, it } from 'vitest';
import type { Message } from '../providers/types.js';
import {
  classifySessionMessage,
  compactCompletedConversationHistory,
  filterHumanVisibleTranscript,
  getHumanVisibleText,
} from './session-message-view.js';

describe('session message view', () => {
  it('does not mistake provider tool results for human turns', () => {
    const toolResult = {
      role: 'user',
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: '1', content: 'private output' }]),
    };
    expect(classifySessionMessage(toolResult)).toMatchObject({
      kind: 'tool_result', isHumanTurn: false, isHumanVisible: false,
    });
    expect(getHumanVisibleText(toolResult)).toBeNull();
  });

  it('does not mistake internal user-role control messages for human turns', () => {
    for (const content of [
      '[System: Your response was truncated. Continue.]',
      '[Sub-agent "research" completed — 2 iterations]',
      '[Previous conversation summary (12 messages): ...]',
    ]) {
      expect(classifySessionMessage({ role: 'user', content })).toMatchObject({
        kind: 'internal', isHumanTurn: false, isHumanVisible: false,
      });
    }
  });

  it('prefers persisted kinds over ambiguous plain role/content heuristics', () => {
    expect(classifySessionMessage({
      role: 'user',
      content: 'This plain text would otherwise look human.',
      messageKind: 'system_internal',
    })).toMatchObject({
      persistedKind: 'system_internal',
      isHumanTurn: false,
      isHumanVisible: false,
    });
    expect(classifySessionMessage({
      role: 'assistant',
      content: 'This plain text is provider protocol.',
      messageKind: 'assistant_protocol',
    })).toMatchObject({
      persistedKind: 'assistant_protocol',
      isHumanVisible: false,
    });
  });

  it('keeps only final conversational text and rejects sub-agent sessions', () => {
    const rows = [
      { role: 'user', content: 'Real question' },
      { role: 'assistant', content: JSON.stringify([
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'I should call a tool' },
        { type: 'tool_use', id: '1', name: 'search', input: {} },
      ]) },
      { role: 'assistant', content: JSON.stringify([
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: '<think>also private</think>Final answer' },
      ]) },
    ];
    expect(filterHumanVisibleTranscript(rows).map(row => row.role)).toEqual(['user', 'assistant']);
    expect(getHumanVisibleText(rows[2])).toBe('Final answer');
    expect(filterHumanVisibleTranscript(rows, {
      sessionMetadata: { isSubAgent: true },
    })).toEqual([]);
  });

  it('compacts completed turns but preserves the active tool chain exactly', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Older question' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'old thought' },
        { type: 'text', text: 'old plan' },
        { type: 'tool_use', id: 'old', name: 'search', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'huge old result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Older final answer' }] },
      { role: 'user', content: 'Current question' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'active', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'active', content: 'active result' }] },
    ];

    const compacted = compactCompletedConversationHistory(messages);
    expect(compacted.slice(0, 2)).toEqual([
      { role: 'user', content: 'Older question' },
      { role: 'assistant', content: 'Older final answer' },
    ]);
    expect(compacted.slice(2)).toEqual(messages.slice(4));
    expect(JSON.stringify(compacted)).not.toContain('huge old result');
  });

  it('caps retained completed turns without dropping the current turn', () => {
    const messages: Message[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'one answer' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'two answer' },
      { role: 'user', content: 'current' },
    ];
    expect(compactCompletedConversationHistory(messages, { maxCompletedTurns: 1 })).toEqual([
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'two answer' },
      { role: 'user', content: 'current' },
    ]);
  });

  it('bounds long replay history while preserving the current request', () => {
    const messages: Message[] = [];
    for (let turn = 0; turn < 20; turn++) {
      messages.push(
        { role: 'user', content: `Question ${turn} ${'q'.repeat(1_000)}` },
        { role: 'assistant', content: [{ type: 'tool_use', id: `t-${turn}`, name: 'search', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${turn}`, content: 'x'.repeat(10_000) }] },
        { role: 'assistant', content: `Answer ${turn} ${'a'.repeat(5_000)}` },
      );
    }
    messages.push({ role: 'user', content: 'Current request must survive' });

    const beforeChars = JSON.stringify(messages).length;
    const compacted = compactCompletedConversationHistory(messages);
    const afterChars = JSON.stringify(compacted).length;

    expect(compacted).toHaveLength(17); // 8 completed pairs + current request
    expect(compacted.at(-1)).toEqual({ role: 'user', content: 'Current request must survive' });
    expect(afterChars / beforeChars).toBeLessThan(0.15);
  });
});
