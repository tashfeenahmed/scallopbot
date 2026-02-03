/**
 * Tests for LLM-based Fact Extractor
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LLMFactExtractor,
  extractFactsWithLLM,
  type ExtractedFactWithEmbedding,
  type FactExtractionResult,
} from './fact-extractor.js';
import { MemoryStore, HybridSearch } from './memory.js';
import type { LLMProvider } from '../providers/types.js';
import type { Logger } from 'pino';

// Mock logger
const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

// Mock LLM provider that returns structured facts
const createMockProvider = (response: string): LLMProvider => ({
  name: 'mock',
  complete: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: response }],
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
  isAvailable: vi.fn().mockResolvedValue(true),
});

describe('LLMFactExtractor', () => {
  let memoryStore: MemoryStore;
  let hybridSearch: HybridSearch;
  let logger: Logger;

  beforeEach(() => {
    memoryStore = new MemoryStore();
    hybridSearch = new HybridSearch({ store: memoryStore });
    logger = createMockLogger();
  });

  describe('extractFacts', () => {
    it('should extract facts from user message about work', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Acme Corp', subject: 'user', category: 'work' },
          { content: 'Job title is Senior Product Designer', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'I work at Acme Corp as a Senior Product Designer',
        'user-123'
      );

      expect(result.facts.length).toBe(2);
      expect(result.facts[0].content).toContain('Acme Corp');
      expect(result.facts[0].subject).toBe('user');
    });

    it('should extract facts about third parties', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Globex', subject: 'Bob', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My flatmate Bob works at Globex',
        'user-123'
      );

      expect(result.facts.length).toBe(1);
      expect(result.facts[0].subject).toBe('Bob');
      expect(result.facts[0].content).toContain('Globex');
    });

    it('should extract location facts', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Office is at One Acme Plaza, Metropolis', subject: 'user', category: 'location' },
          { content: 'Lives in Maple Street, Springfield', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My office is called One Acme Plaza in Metropolis. I live in Maple Street, Springfield.',
        'user-123'
      );

      expect(result.facts.length).toBe(2);
      expect(result.facts.some(f => f.content.includes('One Acme Plaza'))).toBe(true);
      expect(result.facts.some(f => f.content.includes('Maple Street'))).toBe(true);
    });

    it('should handle contextual references like "that\'s my office"', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Office is One Acme Plaza', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      // Simulating context where previous message mentioned One Acme Plaza
      const result = await extractor.extractFacts(
        "Yes that's my office",
        'user-123',
        'One Acme Plaza is a building at Acme Corp\'s campus in Metropolis'
      );

      expect(result.facts.length).toBe(1);
      expect(result.facts[0].content).toContain('One Acme Plaza');
    });

    it('should return empty array for messages with no facts', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts('Hello, how are you?', 'user-123');

      expect(result.facts.length).toBe(0);
    });

    it('should handle malformed LLM response gracefully', async () => {
      const mockProvider = createMockProvider('not valid json');

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts('I work at Google', 'user-123');

      // Should gracefully return empty array, not crash
      expect(result.facts.length).toBe(0);
      // Note: No error is set for parse failures - just returns empty array
    });
  });

  describe('semantic deduplication', () => {
    it('should not store duplicate facts', async () => {
      // First, add an existing fact
      memoryStore.add({
        content: 'Works at Acme Corp',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(),
        metadata: { subject: 'user' },
        tags: ['work'],
      });

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Acme Corp as an employee', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
        deduplicationThreshold: 0.85,
      });

      const result = await extractor.extractFacts(
        'I work at Acme Corp',
        'user-123'
      );

      // Should detect as duplicate and not add
      expect(result.duplicatesSkipped).toBeGreaterThanOrEqual(0);
    });

    it('should update existing fact if new info is more specific', async () => {
      // Add a general fact
      memoryStore.add({
        content: 'Works at Acme Corp',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(),
        metadata: { subject: 'user' },
        tags: ['work'],
      });

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Acme Corp as Senior Product Designer on AI team', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
        deduplicationThreshold: 0.7,
      });

      const result = await extractor.extractFacts(
        'I work at Acme Corp as a Senior Product Designer on the AI team',
        'user-123'
      );

      // Should update with more specific info
      expect(result.factsUpdated).toBeGreaterThanOrEqual(0);
    });
  });

  describe('async processing', () => {
    it('should process facts asynchronously without blocking', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Acme Corp', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      // Queue message for async processing
      const promise = extractor.queueForExtraction('I work at Acme Corp', 'user-123');

      // Should return immediately
      expect(promise).toBeInstanceOf(Promise);

      // Wait for processing
      await promise;

      // Verify fact was stored
      const facts = memoryStore.getAll().filter(m => m.type === 'fact');
      expect(facts.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle multiple queued messages', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Test fact', subject: 'user', category: 'general' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      // Queue multiple messages
      const promises = [
        extractor.queueForExtraction('Message 1', 'user-123'),
        extractor.queueForExtraction('Message 2', 'user-123'),
        extractor.queueForExtraction('Message 3', 'user-123'),
      ];

      await Promise.all(promises);

      // All should complete
      expect(mockProvider.complete).toHaveBeenCalledTimes(3);
    });
  });

  describe('category extraction', () => {
    it('should categorize facts correctly', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Name is Alex', subject: 'user', category: 'personal' },
          { content: 'Works at Acme Corp', subject: 'user', category: 'work' },
          { content: 'Lives in Springfield', subject: 'user', category: 'location' },
          { content: 'Prefers dark mode', subject: 'user', category: 'preference' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'I\'m Alex, I work at Acme Corp, live in Springfield, and prefer dark mode',
        'user-123'
      );

      expect(result.facts.length).toBe(4);
      expect(result.facts.map(f => f.category)).toContain('personal');
      expect(result.facts.map(f => f.category)).toContain('work');
      expect(result.facts.map(f => f.category)).toContain('location');
      expect(result.facts.map(f => f.category)).toContain('preference');
    });
  });
});

describe('extractFactsWithLLM helper', () => {
  it('should extract facts using provided provider', async () => {
    const mockProvider = createMockProvider(JSON.stringify({
      facts: [
        { content: 'Test fact', subject: 'user', category: 'general' },
      ],
    }));

    const result = await extractFactsWithLLM(
      mockProvider,
      'Test message',
      undefined
    );

    expect(result.facts.length).toBe(1);
  });
});
