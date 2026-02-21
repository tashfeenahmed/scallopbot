/**
 * Tests for Progressive Context Compaction.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message, LLMProvider, CompletionResponse } from '../providers/types.js';
import {
  computeAdaptiveChunkRatio,
  chunkMessagesByTokenBudget,
  repairToolUsePairing,
  progressiveCompact,
} from './compaction.js';

// ============ Helpers ============

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function toolUseMsg(toolUseId: string, toolName: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
  };
}

function toolResultMsg(toolUseId: string, result: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
  };
}

function mockProvider(summaryText: string = 'Summary of conversation.'): LLMProvider {
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: summaryText }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'mock-model',
    } as CompletionResponse),
  };
}

// ============ computeAdaptiveChunkRatio ============

describe('computeAdaptiveChunkRatio', () => {
  it('returns BASE_CHUNK_RATIO for empty messages', () => {
    expect(computeAdaptiveChunkRatio([], 128000)).toBe(0.4);
  });

  it('returns smaller ratio for very large messages', () => {
    const bigMessages = Array.from({ length: 10 }, (_, i) =>
      textMsg('user', 'x'.repeat(20000))
    );
    const ratio = computeAdaptiveChunkRatio(bigMessages, 128000);
    expect(ratio).toBeLessThanOrEqual(0.4);
  });

  it('returns base ratio for small messages in large context', () => {
    const smallMessages = Array.from({ length: 10 }, () =>
      textMsg('user', 'Hello world')
    );
    const ratio = computeAdaptiveChunkRatio(smallMessages, 128000);
    expect(ratio).toBe(0.4);
  });
});

// ============ chunkMessagesByTokenBudget ============

describe('chunkMessagesByTokenBudget', () => {
  it('puts all messages in one chunk when under budget', () => {
    const messages = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ];
    const chunks = chunkMessagesByTokenBudget(messages, 10000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(2);
  });

  it('splits messages across chunks when over budget', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      textMsg('user', 'x'.repeat(400)) // ~100 tokens each
    );
    const chunks = chunkMessagesByTokenBudget(messages, 500); // ~2 messages per chunk
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles empty message list', () => {
    expect(chunkMessagesByTokenBudget([], 1000)).toEqual([]);
  });
});

// ============ repairToolUsePairing ============

describe('repairToolUsePairing', () => {
  it('keeps valid tool_use/tool_result pairs', () => {
    const messages = [
      toolUseMsg('call-1', 'bash'),
      toolResultMsg('call-1', 'output'),
    ];
    const repaired = repairToolUsePairing(messages);
    expect(repaired.length).toBe(2);
  });

  it('removes orphaned tool_results', () => {
    const messages = [
      // No tool_use for 'orphan-id'
      toolResultMsg('orphan-id', 'orphaned result'),
      textMsg('user', 'hello'),
    ];
    const repaired = repairToolUsePairing(messages);
    // The orphaned tool result message should be replaced with a text note
    expect(typeof repaired[0].content).toBe('string');
  });

  it('preserves text-only messages', () => {
    const messages = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ];
    const repaired = repairToolUsePairing(messages);
    expect(repaired).toEqual(messages);
  });

  it('handles mixed valid and orphaned results', () => {
    const messages = [
      toolUseMsg('valid-1', 'bash'),
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'valid-1', content: 'ok' },
          { type: 'tool_result' as const, tool_use_id: 'orphan-1', content: 'nope' },
        ],
      },
    ];
    const repaired = repairToolUsePairing(messages);
    // Should keep valid-1 result and remove orphan-1
    const blocks = repaired[1].content as Array<{ type: string; tool_use_id?: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0].tool_use_id).toBe('valid-1');
  });
});

// ============ progressiveCompact ============

describe('progressiveCompact', () => {
  it('returns messages unchanged when count <= preserveLastN', async () => {
    const messages = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ];
    const provider = mockProvider();
    const result = await progressiveCompact(messages, provider, 128000, { preserveLastN: 6 });
    expect(result.compactedMessages).toEqual(messages);
    expect(result.summary).toBe('');
  });

  it('compacts older messages and preserves recent ones', async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );
    const provider = mockProvider('This is a test summary.');
    const result = await progressiveCompact(messages, provider, 128000, { preserveLastN: 3 });

    // Should have summary message + 3 recent messages
    expect(result.compactedMessages.length).toBe(4);
    expect(result.summary).toBe('This is a test summary.');

    // First message should be the summary
    const firstContent = result.compactedMessages[0].content as string;
    expect(firstContent).toContain('Conversation summary');
    expect(firstContent).toContain('This is a test summary.');
  });

  it('uses fallback summary when provider fails', async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      textMsg(i % 2 === 0 ? 'user' : 'assistant', `Message number ${i}`)
    );
    const provider: LLMProvider = {
      name: 'broken',
      isAvailable: () => true,
      complete: vi.fn().mockRejectedValue(new Error('LLM error')),
    };

    const result = await progressiveCompact(messages, provider, 128000, { preserveLastN: 3 });
    // Should still return something (fallback summary)
    expect(result.compactedMessages.length).toBe(4);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
