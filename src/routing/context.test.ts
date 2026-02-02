import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContextManager,
  ContextManagerOptions,
  CompressedContext,
  ToolOutputDeduplicator,
} from './context.js';
import type { Message } from '../providers/types.js';

describe('ContextManager', () => {
  let manager: ContextManager;

  describe('constructor', () => {
    it('should create manager with default options', () => {
      manager = new ContextManager({});
      expect(manager).toBeInstanceOf(ContextManager);
    });

    it('should create manager with custom options', () => {
      manager = new ContextManager({
        hotWindowSize: 10,
        maxContextTokens: 100000,
        compressionThreshold: 0.8,
        maxToolOutputBytes: 50000,
      });
      expect(manager.getHotWindowSize()).toBe(10);
      expect(manager.getMaxContextTokens()).toBe(100000);
    });
  });

  describe('hot window', () => {
    beforeEach(() => {
      manager = new ContextManager({
        hotWindowSize: 5,
      });
    });

    it('should keep last N messages in hot window', () => {
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));

      const result = manager.processMessages(messages);

      expect(result.hotMessages).toHaveLength(5);
      expect(result.hotMessages[0].content).toBe('Message 5');
      expect(result.hotMessages[4].content).toBe('Message 9');
    });

    it('should not compress if messages fit in hot window', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = manager.processMessages(messages);

      expect(result.hotMessages).toHaveLength(2);
      expect(result.warmSummary).toBeUndefined();
    });

    it('should include warm summary for older messages', () => {
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));

      const result = manager.processMessages(messages);

      expect(result.warmSummary).toBeDefined();
      expect(result.warmSummary?.messageCount).toBe(5);
    });
  });

  describe('warm summary', () => {
    beforeEach(() => {
      manager = new ContextManager({
        hotWindowSize: 3,
      });
    });

    it('should compress older messages into summary', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: 'Answer 2' },
        { role: 'user', content: 'Question 3' },
        { role: 'assistant', content: 'Answer 3' },
      ];

      const result = manager.processMessages(messages);

      expect(result.warmSummary).toBeDefined();
      expect(result.warmSummary?.summary).toContain('Question 1');
      expect(result.warmSummary?.summary).toContain('Answer 1');
    });

    it('should include tool use information in summary', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: '1', name: 'read', input: { path: 'file.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: 'File contents here',
            },
          ],
        },
        { role: 'assistant', content: 'The file contains...' },
        { role: 'user', content: 'Now do something else' },
        { role: 'assistant', content: 'Sure!' },
      ];

      const result = manager.processMessages(messages);

      expect(result.warmSummary?.toolsUsed).toContain('read');
    });

    it('should track topics discussed in summary', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Tell me about TypeScript' },
        { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript' },
        { role: 'user', content: 'What about React?' },
        { role: 'assistant', content: 'React is a UI library' },
        { role: 'user', content: 'Current question' },
        { role: 'assistant', content: 'Current answer' },
      ];

      const result = manager.processMessages(messages);

      expect(result.warmSummary?.topics).toBeDefined();
      expect(result.warmSummary?.topics?.length).toBeGreaterThan(0);
    });
  });

  describe('tool output truncation', () => {
    beforeEach(() => {
      manager = new ContextManager({
        maxToolOutputBytes: 100, // Very small for testing
      });
    });

    it('should truncate large tool outputs', () => {
      const largeOutput = 'x'.repeat(200);
      const messages: Message[] = [
        { role: 'user', content: 'Read big file' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '1', name: 'read', input: { path: 'big.txt' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: largeOutput,
            },
          ],
        },
      ];

      const result = manager.processMessages(messages);

      // Find the tool result in hot messages
      const toolResultMsg = result.hotMessages.find(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((c) => c.type === 'tool_result')
      );

      expect(toolResultMsg).toBeDefined();
      const toolResult = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find(
        (c) => c.type === 'tool_result'
      );
      expect(toolResult?.content?.length).toBeLessThan(200);
    });

    it('should store hash for truncated outputs', () => {
      const largeOutput = 'Important data: ' + 'x'.repeat(200);
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: largeOutput,
            },
          ],
        },
      ];

      manager.processMessages(messages);

      // Should be able to retrieve by hash
      const hashes = manager.getTruncatedOutputHashes();
      expect(hashes.length).toBeGreaterThan(0);
    });

    it('should allow retrieval of full output by hash', () => {
      const largeOutput = 'Original content: ' + 'x'.repeat(200);
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: largeOutput,
            },
          ],
        },
      ];

      manager.processMessages(messages);

      const hashes = manager.getTruncatedOutputHashes();
      const retrieved = manager.getFullOutputByHash(hashes[0]);
      expect(retrieved).toBe(largeOutput);
    });

    it('should not truncate small outputs', () => {
      const smallOutput = 'Small output';
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: smallOutput,
            },
          ],
        },
      ];

      const result = manager.processMessages(messages);

      const toolResult = (result.hotMessages[0].content as Array<{ type: string; content?: string }>).find(
        (c) => c.type === 'tool_result'
      );
      expect(toolResult?.content).toBe(smallOutput);
    });
  });

  describe('auto-compression', () => {
    it('should trigger compression at threshold', () => {
      manager = new ContextManager({
        hotWindowSize: 3,
        maxContextTokens: 100,
        compressionThreshold: 0.7,
      });

      // Create messages that exceed threshold
      const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'A'.repeat(20), // ~5 tokens each
      }));

      const result = manager.processMessages(messages);

      expect(result.wasCompressed).toBe(true);
      expect(result.warmSummary).toBeDefined();
    });

    it('should not compress below threshold', () => {
      manager = new ContextManager({
        hotWindowSize: 10,
        maxContextTokens: 10000,
        compressionThreshold: 0.7,
      });

      const messages: Message[] = [
        { role: 'user', content: 'Short' },
        { role: 'assistant', content: 'Response' },
      ];

      const result = manager.processMessages(messages);

      expect(result.wasCompressed).toBe(false);
    });
  });

  describe('token estimation', () => {
    beforeEach(() => {
      manager = new ContextManager({});
    });

    it('should estimate tokens for messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const estimate = manager.estimateTokens(messages);
      expect(estimate).toBeGreaterThan(0);
    });

    it('should estimate tokens for content blocks', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me help' },
            { type: 'tool_use', id: '1', name: 'read', input: { path: 'file.txt' } },
          ],
        },
      ];

      const estimate = manager.estimateTokens(messages);
      expect(estimate).toBeGreaterThan(0);
    });
  });

  describe('context capacity', () => {
    beforeEach(() => {
      manager = new ContextManager({
        maxContextTokens: 1000,
      });
    });

    it('should report remaining capacity', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];

      manager.processMessages(messages);

      const capacity = manager.getRemainingCapacity(messages);
      expect(capacity).toBeLessThan(1000);
      expect(capacity).toBeGreaterThan(0);
    });

    it('should report usage percentage', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello world this is a longer message' },
        { role: 'assistant', content: 'This is a response with more content too' },
      ];

      const usage = manager.getCapacityUsage(messages);
      expect(usage).toBeGreaterThan(0);
      expect(usage).toBeLessThan(1);
    });
  });

  describe('buildContextMessages', () => {
    beforeEach(() => {
      manager = new ContextManager({
        hotWindowSize: 3,
      });
    });

    it('should build messages array for LLM request', () => {
      const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));

      const contextMessages = manager.buildContextMessages(messages);

      // Should include system context about compressed history + hot messages
      expect(contextMessages.length).toBeLessThanOrEqual(messages.length);
    });

    it('should include compressed history indicator', () => {
      const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));

      const contextMessages = manager.buildContextMessages(messages);

      // First message should indicate there's compressed history
      const hasContextNote = contextMessages.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.toLowerCase().includes('previous')
      );
      expect(hasContextNote).toBe(true);
    });
  });

  describe('tool output deduplication', () => {
    beforeEach(() => {
      manager = new ContextManager({
        dedupeIdentical: true,
      });
    });

    it('should deduplicate identical tool outputs', () => {
      const longOutput = 'x'.repeat(200); // Above min size threshold

      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'file.txt' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: longOutput }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-2', name: 'read', input: { path: 'file.txt' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: longOutput }],
        },
      ];

      const result = manager.processMessages(messages);

      // Second tool result should be deduplicated
      const secondResult = result.hotMessages[3];
      if (typeof secondResult.content !== 'string') {
        const toolResult = secondResult.content[0];
        if (toolResult.type === 'tool_result') {
          expect(toolResult.content).toContain('Identical to previous');
        }
      }
    });

    it('should not deduplicate different tool outputs', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'file1.txt' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Content A '.repeat(50) }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-2', name: 'read', input: { path: 'file2.txt' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'Content B '.repeat(50) }],
        },
      ];

      const result = manager.processMessages(messages);

      // Both outputs should be preserved
      const secondResult = result.hotMessages[3];
      if (typeof secondResult.content !== 'string') {
        const toolResult = secondResult.content[0];
        if (toolResult.type === 'tool_result') {
          expect(toolResult.content).toContain('Content B');
        }
      }
    });

    it('should provide deduplicator access', () => {
      const deduplicator = manager.getDeduplicator();
      expect(deduplicator).toBeInstanceOf(ToolOutputDeduplicator);
    });
  });
});

describe('ToolOutputDeduplicator', () => {
  let deduplicator: ToolOutputDeduplicator;

  beforeEach(() => {
    deduplicator = new ToolOutputDeduplicator();
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      expect(deduplicator.isEnabled()).toBe(true);
    });

    it('should create with custom options', () => {
      const custom = new ToolOutputDeduplicator({ enabled: false, minSizeBytes: 500 });
      expect(custom.isEnabled()).toBe(false);
    });
  });

  describe('shouldDeduplicate', () => {
    it('should not deduplicate first occurrence', () => {
      const result = deduplicator.shouldDeduplicate(
        'read',
        { path: 'file.txt' },
        'x'.repeat(150) // Long enough to meet minimum
      );

      expect(result.deduplicated).toBe(false);
    });

    it('should deduplicate identical output', () => {
      // Ensure output is well over 100 bytes
      const output = 'x'.repeat(150);

      // First call
      deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);

      // Second call with same output
      const result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);

      expect(result.deduplicated).toBe(true);
      expect(result.reference).toContain('Identical to previous');
    });

    it('should deduplicate same content from different calls', () => {
      // Ensure output is well over 100 bytes
      const output = 'y'.repeat(150);

      // First call
      deduplicator.shouldDeduplicate('read', { path: 'file1.txt' }, output);

      // Second call with different input but same output
      const result = deduplicator.shouldDeduplicate('read', { path: 'file2.txt' }, output);

      expect(result.deduplicated).toBe(true);
      expect(result.reference).toContain('Identical to previous');
    });

    it('should not deduplicate small outputs', () => {
      const smallOutput = 'tiny';

      // First call
      deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, smallOutput);

      // Second identical call
      const result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, smallOutput);

      expect(result.deduplicated).toBe(false);
    });

    it('should not deduplicate when disabled', () => {
      const disabled = new ToolOutputDeduplicator({ enabled: false });
      const output = 'z'.repeat(150);

      disabled.shouldDeduplicate('read', { path: 'file.txt' }, output);
      const result = disabled.shouldDeduplicate('read', { path: 'file.txt' }, output);

      expect(result.deduplicated).toBe(false);
    });
  });

  describe('getOutputByHash', () => {
    it('should retrieve original output by hash', () => {
      const output = 'a'.repeat(150);

      // First call stores it
      deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);

      // Second call returns reference with hash
      const result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);

      // Should be able to retrieve original by hash
      if (result.originalHash) {
        const retrieved = deduplicator.getOutputByHash(result.originalHash);
        expect(retrieved).toBe(output);
      }
    });

    it('should return undefined for unknown hash', () => {
      expect(deduplicator.getOutputByHash('nonexistent')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should track deduplication statistics', () => {
      const output1 = 'b'.repeat(150);
      const output2 = 'c'.repeat(150);

      deduplicator.shouldDeduplicate('read', { path: 'a.txt' }, output1);
      deduplicator.shouldDeduplicate('read', { path: 'a.txt' }, output1); // Duplicate
      deduplicator.shouldDeduplicate('read', { path: 'b.txt' }, output2);
      deduplicator.shouldDeduplicate('read', { path: 'b.txt' }, output2); // Duplicate
      deduplicator.shouldDeduplicate('read', { path: 'b.txt' }, output2); // Another duplicate

      const stats = deduplicator.getStats();
      expect(stats.totalOutputs).toBe(2);
      expect(stats.totalDeduplicated).toBe(3); // 1 + 2 duplicates
      expect(stats.bytesSaved).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('should clear all stored outputs', () => {
      const output = 'd'.repeat(150);

      deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);
      expect(deduplicator.getStats().totalOutputs).toBe(1);

      deduplicator.clear();
      expect(deduplicator.getStats().totalOutputs).toBe(0);
    });
  });

  describe('setEnabled', () => {
    it('should toggle deduplication on and off', () => {
      const output = 'e'.repeat(150);

      // Initially enabled
      deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);
      let result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);
      expect(result.deduplicated).toBe(true);

      // Disable
      deduplicator.setEnabled(false);
      result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);
      expect(result.deduplicated).toBe(false);

      // Re-enable
      deduplicator.setEnabled(true);
      result = deduplicator.shouldDeduplicate('read', { path: 'file.txt' }, output);
      expect(result.deduplicated).toBe(true);
    });
  });
});
