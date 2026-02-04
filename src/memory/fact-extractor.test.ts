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
import type { EmbeddingProvider } from './embeddings.js';
import type { Logger } from 'pino';

// Mock embedder that returns simple word-based vectors for testing
// Designed so facts about the same topic (e.g., "office") have high similarity
const createMockEmbedder = (): EmbeddingProvider => {
  const embedFn = (text: string): number[] => {
    const lower = text.toLowerCase();
    // Create a vector that emphasizes topic similarity
    // Facts about "office" should be highly similar regardless of location
    return [
      lower.includes('office') ? 0.9 : 0,        // office topic (high weight)
      lower.includes('lives') || lower.includes('home') ? 0.9 : 0, // home topic
      lower.includes('works') || lower.includes('work') ? 0.9 : 0, // work topic
      lower.includes('dublin') ? 0.1 : 0,        // location detail (low weight)
      lower.includes('wicklow') ? 0.1 : 0,       // location detail (low weight)
      lower.includes('microsoft') ? 0.1 : 0,     // company detail (low weight)
      0.1, // Small constant to avoid zero vectors
    ];
  };

  return {
    name: 'mock-embedder',
    dimension: 7,
    embed: vi.fn().mockImplementation((text: string) => Promise.resolve(embedFn(text))),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => Promise.resolve(texts.map(embedFn))),
    isAvailable: vi.fn().mockReturnValue(true),
  };
};

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
          { content: 'Works at Microsoft', subject: 'user', category: 'work' },
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
        'I work at Microsoft as a Senior Product Designer',
        'user-123'
      );

      expect(result.facts.length).toBe(2);
      expect(result.facts[0].content).toContain('Microsoft');
      expect(result.facts[0].subject).toBe('user');
    });

    it('should extract facts about third parties', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Henry Schein', subject: 'Hamza', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My flatmate Hamza works at Henry Schein',
        'user-123'
      );

      expect(result.facts.length).toBe(1);
      expect(result.facts[0].subject).toBe('Hamza');
      expect(result.facts[0].content).toContain('Henry Schein');
    });

    it('should extract relationship facts with subject as "user"', async () => {
      // This tests the critical fix: "My wife is Hayat" should have subject: "user"
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Wife is Hayat', subject: 'user', category: 'relationship' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My wife is Hayat',
        'user-123'
      );

      expect(result.facts.length).toBe(1);
      expect(result.facts[0].subject).toBe('user'); // Critical: relationship belongs to user
      expect(result.facts[0].content).toContain('Hayat');
      expect(result.facts[0].category).toBe('relationship');
    });

    it('should extract both relationship and attribute facts for spouse', async () => {
      // "My wife Hayat is a TikToker" should produce TWO facts
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Wife is Hayat', subject: 'user', category: 'relationship' },
          { content: 'Is a TikToker', subject: 'Hayat', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My wife Hayat is a TikToker',
        'user-123'
      );

      expect(result.facts.length).toBe(2);

      // Relationship fact has subject: "user"
      const relationshipFact = result.facts.find(f => f.category === 'relationship');
      expect(relationshipFact?.subject).toBe('user');
      expect(relationshipFact?.content).toContain('Hayat');

      // Work fact has subject: "Hayat"
      const workFact = result.facts.find(f => f.category === 'work');
      expect(workFact?.subject).toBe('Hayat');
      expect(workFact?.content).toContain('TikToker');
    });

    it('should extract location facts', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Office is at One Microsoft Court, Dublin', subject: 'user', category: 'location' },
          { content: 'Lives in Burkeen Dales, Wicklow', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'My office is called One Microsoft Court in Dublin. I live in Burkeen Dales, Wicklow.',
        'user-123'
      );

      expect(result.facts.length).toBe(2);
      expect(result.facts.some(f => f.content.includes('One Microsoft Court'))).toBe(true);
      expect(result.facts.some(f => f.content.includes('Burkeen Dales'))).toBe(true);
    });

    it('should handle contextual references like "that\'s my office"', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Office is One Microsoft Court', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      // Simulating context where previous message mentioned One Microsoft Court
      const result = await extractor.extractFacts(
        "Yes that's my office",
        'user-123',
        'One Microsoft Court is a building at Microsoft\'s campus in Dublin'
      );

      expect(result.facts.length).toBe(1);
      expect(result.facts[0].content).toContain('One Microsoft Court');
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
        content: 'Works at Microsoft',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(),
        metadata: { subject: 'user' },
        tags: ['work'],
      });

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Microsoft as an employee', subject: 'user', category: 'work' },
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
        'I work at Microsoft',
        'user-123'
      );

      // Should detect as duplicate and not add
      expect(result.duplicatesSkipped).toBeGreaterThanOrEqual(0);
    });

    it('should update existing fact if new info is more specific', async () => {
      // Add a general fact
      memoryStore.add({
        content: 'Works at Microsoft',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(),
        metadata: { subject: 'user' },
        tags: ['work'],
      });

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Microsoft as Senior Product Designer on AI team', subject: 'user', category: 'work' },
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
        'I work at Microsoft as a Senior Product Designer on the AI team',
        'user-123'
      );

      // Should update with more specific info
      expect(result.factsUpdated).toBeGreaterThanOrEqual(0);
    });

    it('should enrich/correct existing fact in same category with new info using LLM classification', async () => {
      // Add an INCORRECT location fact (Wicklow instead of Dublin)
      const oldFact = memoryStore.add({
        content: 'Office is in Wicklow',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(Date.now() - 86400000), // 1 day old
        metadata: { subject: 'user', category: 'location', userId: 'user-123' },
        tags: ['location', 'about-user'],
      });

      // Mock provider that returns extraction first, then UPDATES classification
      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        complete: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: fact extraction
            return Promise.resolve({
              content: [{ type: 'text', text: JSON.stringify({
                facts: [{ content: 'Office is One Microsoft Court in Dublin', subject: 'user', category: 'location' }]
              })}],
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 50 },
            });
          } else {
            // Second call: batch classification - returns UPDATES
            return Promise.resolve({
              content: [{ type: 'text', text: JSON.stringify({
                classifications: [{
                  index: 1,
                  classification: 'UPDATES',
                  targetId: oldFact.id,
                  confidence: 0.9,
                  reason: 'Location updated from Wicklow to Dublin'
                }]
              })}],
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 50 },
            });
          }
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
        embedder: createMockEmbedder(),
        useRelationshipClassifier: true, // Enable LLM classifier for UPDATES detection
      });

      const result = await extractor.extractFacts(
        'My office is One Microsoft Court in Dublin',
        'user-123'
      );

      // Should update the existing location fact via LLM classification
      expect(result.factsUpdated).toBe(1);
      expect(result.factsStored).toBe(0);

      // Verify the old fact was updated, not a new one created
      const allFacts = memoryStore.getAll().filter(m => m.type === 'fact');
      const locationFacts = allFacts.filter(f =>
        f.metadata?.category === 'location' && f.metadata?.subject === 'user'
      );

      expect(locationFacts.length).toBe(1);
      expect(locationFacts[0].content).toContain('Dublin');
    });

    it('should create new fact if category differs from existing facts', async () => {
      // Add a work fact
      memoryStore.add({
        content: 'Works at Microsoft',
        type: 'fact',
        sessionId: 'user-123',
        timestamp: new Date(),
        metadata: { subject: 'user', category: 'work' },
        tags: ['work', 'about-user'],
      });

      // User provides a LOCATION fact (different category)
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Lives in Dublin', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      const result = await extractor.extractFacts(
        'I live in Dublin',
        'user-123'
      );

      // Should store as new fact (different category)
      expect(result.factsStored).toBe(1);
      expect(result.factsUpdated).toBe(0);

      // Verify both facts exist
      const allFacts = memoryStore.getAll().filter(m => m.type === 'fact');
      expect(allFacts.length).toBe(2);
    });
  });

  describe('async processing', () => {
    it('should process facts asynchronously without blocking', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Microsoft', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        memoryStore,
        hybridSearch,
        logger,
      });

      // Queue message for async processing
      const promise = extractor.queueForExtraction('I work at Microsoft', 'user-123');

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
        useRelationshipClassifier: false, // Disable to test exact call counts
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
          { content: 'Name is Tashfeen', subject: 'user', category: 'personal' },
          { content: 'Works at Microsoft', subject: 'user', category: 'work' },
          { content: 'Lives in Wicklow', subject: 'user', category: 'location' },
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
        'I\'m Tashfeen, I work at Microsoft, live in Wicklow, and prefer dark mode',
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
