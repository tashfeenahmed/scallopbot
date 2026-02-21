/**
 * Tests for Session Transcript Indexer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptIndexer, type TranscriptChunk, type TranscriptSearchResult, type TranscriptIndexerDeps } from './transcript-indexer.js';
import type { Message } from '../providers/types.js';

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function createMockDeps(): TranscriptIndexerDeps & {
  storedChunks: TranscriptChunk[];
  indexCounts: Map<string, number>;
} {
  const storedChunks: TranscriptChunk[] = [];
  const indexCounts = new Map<string, number>();

  return {
    storedChunks,
    indexCounts,
    storeChunk: (chunk) => storedChunks.push(chunk),
    searchChunks: async (query, options) => {
      const limit = options?.limit ?? 10;
      const results: TranscriptSearchResult[] = storedChunks
        .filter(c => {
          if (options?.userId && c.userId !== options.userId) return false;
          return c.content.toLowerCase().includes(query.toLowerCase());
        })
        .map(c => ({ chunk: c, score: 0.5 }))
        .slice(0, limit);
      return results;
    },
    getLastIndexedCount: (sessionId) => indexCounts.get(sessionId) || 0,
    setLastIndexedCount: (sessionId, count) => indexCounts.set(sessionId, count),
  };
}

describe('TranscriptIndexer', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let indexer: TranscriptIndexer;

  beforeEach(() => {
    deps = createMockDeps();
    indexer = new TranscriptIndexer(deps);
  });

  describe('indexSession', () => {
    it('indexes a session into chunks', async () => {
      const messages = [
        textMsg('user', 'Hello, can you help me with my project?'),
        textMsg('assistant', 'Of course! What do you need help with?'),
        textMsg('user', 'I need to build a REST API with authentication.'),
        textMsg('assistant', 'I can help with that. Let me set up the project structure.'),
      ];

      await indexer.indexSession('sess-1', messages, 'user-1');

      expect(deps.storedChunks.length).toBeGreaterThan(0);
      expect(deps.storedChunks[0].sessionId).toBe('sess-1');
      expect(deps.storedChunks[0].userId).toBe('user-1');
      expect(deps.indexCounts.get('sess-1')).toBe(4);
    });

    it('handles empty message list', async () => {
      await indexer.indexSession('sess-1', [], 'user-1');
      expect(deps.storedChunks.length).toBe(0);
      expect(deps.indexCounts.get('sess-1')).toBe(0);
    });

    it('calls embed function when available', async () => {
      const embedFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      deps.embed = embedFn;
      indexer = new TranscriptIndexer(deps);

      await indexer.indexSession('sess-1', [
        textMsg('user', 'Test message'),
      ], 'user-1');

      expect(embedFn).toHaveBeenCalled();
      expect(deps.storedChunks[0].embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('search', () => {
    it('searches across indexed transcripts', async () => {
      await indexer.indexSession('sess-1', [
        textMsg('user', 'I love coffee and espresso'),
        textMsg('assistant', 'Coffee is great!'),
      ], 'user-1');

      await indexer.indexSession('sess-2', [
        textMsg('user', 'The meeting is tomorrow'),
        textMsg('assistant', 'I will remind you.'),
      ], 'user-1');

      const results = await indexer.search('coffee');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunk.content).toContain('coffee');
    });

    it('filters by userId', async () => {
      await indexer.indexSession('sess-1', [
        textMsg('user', 'user-1 data'),
      ], 'user-1');

      await indexer.indexSession('sess-2', [
        textMsg('user', 'user-2 data'),
      ], 'user-2');

      const results = await indexer.search('data', { userId: 'user-1' });
      for (const r of results) {
        expect(r.chunk.userId).toBe('user-1');
      }
    });
  });

  describe('indexDelta', () => {
    it('only indexes new messages', async () => {
      const messages = [
        textMsg('user', 'First message'),
        textMsg('assistant', 'First reply'),
      ];

      await indexer.indexSession('sess-1', messages, 'user-1');
      const initialChunks = deps.storedChunks.length;

      // Add new messages
      messages.push(
        textMsg('user', 'Second message'),
        textMsg('assistant', 'Second reply'),
      );

      await indexer.indexDelta('sess-1', messages, 'user-1');

      // Should have more chunks now
      expect(deps.storedChunks.length).toBeGreaterThan(initialChunks);
      expect(deps.indexCounts.get('sess-1')).toBe(4);
    });

    it('skips when no new messages', async () => {
      const messages = [textMsg('user', 'Hello')];
      await indexer.indexSession('sess-1', messages, 'user-1');
      const countBefore = deps.storedChunks.length;

      await indexer.indexDelta('sess-1', messages, 'user-1');
      expect(deps.storedChunks.length).toBe(countBefore);
    });
  });

  describe('chunking', () => {
    it('creates multiple chunks for long conversations', async () => {
      // Create a long conversation
      const messages: Message[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push(textMsg('user', `This is a detailed message number ${i} with enough content to make substantial chunks when all combined together in the conversation history.`));
        messages.push(textMsg('assistant', `Here is a detailed response number ${i} with various information that should be preserved in the transcript index for later retrieval.`));
      }

      await indexer.indexSession('sess-1', messages, 'user-1');
      expect(deps.storedChunks.length).toBeGreaterThan(1);
    });

    it('includes message range metadata', async () => {
      const messages = [
        textMsg('user', 'Hello'),
        textMsg('assistant', 'Hi there'),
        textMsg('user', 'How are you?'),
      ];

      await indexer.indexSession('sess-1', messages, 'user-1');

      for (const chunk of deps.storedChunks) {
        expect(chunk.messageRange).toBeDefined();
        expect(chunk.messageRange[0]).toBeGreaterThanOrEqual(0);
        expect(chunk.messageRange[1]).toBeGreaterThanOrEqual(chunk.messageRange[0]);
      }
    });
  });
});
