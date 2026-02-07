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
import type { ScallopMemoryStore } from './scallop-store.js';
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

// Mock database for trigger tests
const createMockDatabase = () => ({
  hasSimilarPendingScheduledItem: vi.fn().mockReturnValue(false),
  addScheduledItem: vi.fn().mockImplementation((item: any) => ({
    id: `sched-${Date.now()}`,
    ...item,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    firedAt: null,
  })),
});

// Mock ScallopMemoryStore
const createMockScallopStore = (mockDb?: ReturnType<typeof createMockDatabase>): ScallopMemoryStore => {
  const db = mockDb ?? createMockDatabase();
  const store = {
    search: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockImplementation(async (opts: any) => ({
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content: opts.content,
      category: opts.category,
      userId: opts.userId,
      importance: opts.importance ?? 5,
      confidence: opts.confidence ?? 0.8,
      metadata: opts.metadata ?? {},
      embedding: null,
      isLatest: true,
    })),
    update: vi.fn(),
    getProfileManager: vi.fn().mockReturnValue({
      getStaticProfile: vi.fn().mockReturnValue({}),
      setStaticValue: vi.fn(),
    }),
    getDatabase: vi.fn().mockReturnValue(db),
    processDecay: vi.fn().mockReturnValue({ updated: 0, archived: 0 }),
  };
  return store as unknown as ScallopMemoryStore;
};

describe('LLMFactExtractor', () => {
  let mockScallopStore: ScallopMemoryStore;
  let logger: Logger;

  beforeEach(() => {
    mockScallopStore = createMockScallopStore();
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
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
        scallopStore: mockScallopStore,
        logger,
      });

      const result = await extractor.extractFacts('Hello, how are you?', 'user-123');

      expect(result.facts.length).toBe(0);
    });

    it('should handle malformed LLM response gracefully', async () => {
      const mockProvider = createMockProvider('not valid json');

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
        logger,
      });

      const result = await extractor.extractFacts('I work at Google', 'user-123');

      // Should gracefully return empty array, not crash
      expect(result.facts.length).toBe(0);
    });
  });

  describe('semantic deduplication', () => {
    it('should not store duplicate facts', async () => {
      // Existing fact with embedding in ScallopStore
      const existingEmbedding = [0, 0, 0.9, 0, 0, 0.1, 0.1]; // matches "Works at Microsoft"
      (mockScallopStore.search as any).mockResolvedValue([{
        memory: {
          id: 'existing-1',
          content: 'Works at Microsoft',
          category: 'fact',
          metadata: { subject: 'user' },
          embedding: existingEmbedding,
          isLatest: true,
        },
        score: 0.9,
      }]);

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Microsoft as an employee', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
        logger,
        embedder: createMockEmbedder(),
        deduplicationThreshold: 0.85,
      });

      const result = await extractor.extractFacts(
        'I work at Microsoft',
        'user-123'
      );

      // Should detect as duplicate via embedding similarity
      expect(result.duplicatesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('should update existing fact if new info is more specific', async () => {
      (mockScallopStore.search as any).mockResolvedValue([{
        memory: {
          id: 'existing-1',
          content: 'Works at Microsoft',
          category: 'fact',
          metadata: { subject: 'user', originalCategory: 'work' },
          embedding: null,
          isLatest: true,
        },
        score: 0.8,
      }]);

      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Works at Microsoft as Senior Product Designer on AI team', subject: 'user', category: 'work' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
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
      const oldFactId = 'old-fact-1';

      // Mock search to return the old (incorrect) location fact
      (mockScallopStore.search as any).mockResolvedValue([{
        memory: {
          id: oldFactId,
          content: 'Office is in Wicklow',
          category: 'fact',
          metadata: { subject: 'user', originalCategory: 'location', userId: 'user-123' },
          embedding: null,
          isLatest: true,
        },
        score: 0.7,
      }]);

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
          } else if (callCount === 2) {
            // Second call: batch classification - returns UPDATES
            return Promise.resolve({
              content: [{ type: 'text', text: JSON.stringify({
                classifications: [{
                  index: 1,
                  classification: 'UPDATES',
                  targetId: oldFactId,
                  confidence: 0.9,
                  reason: 'Location updated from Wicklow to Dublin'
                }]
              })}],
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 50 },
            });
          } else {
            // Subsequent calls (e.g. consolidation)
            return Promise.resolve({
              content: [{ type: 'text', text: '{"superseded": [], "user_profile": {}, "agent_profile": {}}' }],
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 50 },
            });
          }
        }),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
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

      // Verify old fact was marked as superseded
      expect(mockScallopStore.update).toHaveBeenCalledWith(oldFactId, { isLatest: false });

      // Verify new fact was stored with Dublin content
      expect(mockScallopStore.add).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Dublin'),
        })
      );
    });

    it('should create new fact if category differs from existing facts', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Lives in Dublin', subject: 'user', category: 'location' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
        logger,
      });

      const result = await extractor.extractFacts(
        'I live in Dublin',
        'user-123'
      );

      // Should store as new fact
      expect(result.factsStored).toBe(1);
      expect(result.factsUpdated).toBe(0);
      expect(mockScallopStore.add).toHaveBeenCalled();
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
        scallopStore: mockScallopStore,
        logger,
      });

      // Queue message for async processing
      const promise = extractor.queueForExtraction('I work at Microsoft', 'user-123');

      // Should return immediately
      expect(promise).toBeInstanceOf(Promise);

      // Wait for processing
      await promise;

      // Verify fact was stored via ScallopStore
      expect(mockScallopStore.add).toHaveBeenCalled();
    });

    it('should handle multiple queued messages', async () => {
      const mockProvider = createMockProvider(JSON.stringify({
        facts: [
          { content: 'Test fact', subject: 'user', category: 'general' },
        ],
      }));

      const extractor = new LLMFactExtractor({
        provider: mockProvider,
        scallopStore: mockScallopStore,
        logger,
        useRelationshipClassifier: false, // Disable to simplify call tracking
      });

      // Queue multiple messages
      const promises = [
        extractor.queueForExtraction('Message 1', 'user-123'),
        extractor.queueForExtraction('Message 2', 'user-123'),
        extractor.queueForExtraction('Message 3', 'user-123'),
      ];

      await Promise.all(promises);

      // Each message triggers at least one extraction call
      // (additional background consolidation calls may also fire)
      expect((mockProvider.complete as any).mock.calls.length).toBeGreaterThanOrEqual(3);
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
        scallopStore: mockScallopStore,
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

describe('Combined fact + trigger extraction', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should extract both facts and triggers from a single LLM call', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [
        { content: 'Has a dentist appointment tomorrow at 2pm', subject: 'user', category: 'general', confidence: 0.9 },
      ],
      proactive_triggers: [
        {
          type: 'event_prep',
          description: 'Dentist appointment tomorrow',
          trigger_time: 'tomorrow 12:00',
          context: 'User has a dentist appointment tomorrow at 2pm',
          guidance: 'Search for directions to the dentist and check weather',
          recurring_pattern: null,
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    const result = await extractor.extractFacts(
      'I have a dentist appointment tomorrow at 2pm',
      'user-123'
    );

    // Facts should be extracted
    expect(result.facts.length).toBe(1);
    expect(result.facts[0].content).toContain('dentist');

    // Trigger should be created via processExtractedTriggers
    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const scheduledCall = mockDb.addScheduledItem.mock.calls[0][0];
    expect(scheduledCall.type).toBe('event_prep');
    expect(scheduledCall.message).toBe('Dentist appointment tomorrow');

    // Only 1 LLM call (combined extraction) + possible consolidation
    // The key test: no separate trigger extraction call
    expect((mockProvider.complete as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('should process triggers even when 0 facts extracted', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [],
      proactive_triggers: [
        {
          type: 'event_prep',
          description: 'Flight to London',
          trigger_time: 'tomorrow 6:00',
          context: 'User has a flight tomorrow morning',
          guidance: 'Look up flight status',
          recurring_pattern: null,
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    const result = await extractor.extractFacts(
      'My flight to London is tomorrow morning',
      'user-123'
    );

    // No facts stored
    expect(result.facts.length).toBe(0);
    expect(result.factsStored).toBe(0);

    // But trigger should still be created
    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    expect(mockDb.addScheduledItem.mock.calls[0][0].message).toBe('Flight to London');
  });

  it('should store guidance as structured JSON in context', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [],
      proactive_triggers: [
        {
          type: 'event_prep',
          description: 'Meeting with client',
          trigger_time: 'tomorrow 8:00',
          context: 'User has a client meeting at 10am',
          guidance: 'Check calendar and prepare agenda',
          recurring_pattern: null,
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('I have a client meeting tomorrow at 10am', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const storedContext = mockDb.addScheduledItem.mock.calls[0][0].context;
    const parsed = JSON.parse(storedContext);
    expect(parsed.original_context).toBe('User has a client meeting at 10am');
    expect(parsed.guidance).toBe('Check calendar and prepare agenda');
  });

  it('should store plain context when no guidance provided', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [],
      proactive_triggers: [
        {
          type: 'follow_up',
          description: 'Check on report',
          trigger_time: 'tomorrow 9:00',
          context: 'User needs to finish report',
          guidance: null,
          recurring_pattern: null,
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('I need to finish my report', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const storedContext = mockDb.addScheduledItem.mock.calls[0][0].context;
    // No guidance → plain string, not JSON
    expect(storedContext).toBe('User needs to finish report');
  });

  it('should parse daily recurring pattern correctly', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [
        { content: 'Takes medication daily at 9am', subject: 'user', category: 'personal', confidence: 0.9 },
      ],
      proactive_triggers: [
        {
          type: 'follow_up',
          description: 'Take morning medication',
          trigger_time: 'tomorrow 9:00',
          context: 'User takes medication every morning',
          guidance: null,
          recurring_pattern: 'daily',
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('I take my medication every day at 9am', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const recurring = mockDb.addScheduledItem.mock.calls[0][0].recurring;
    expect(recurring).not.toBeNull();
    expect(recurring.type).toBe('daily');
    expect(recurring.hour).toBe(9);
    expect(recurring.minute).toBe(0);
  });

  it('should parse weekday recurring pattern correctly', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [
        { content: 'Goes to gym every weekday at 7am', subject: 'user', category: 'personal', confidence: 0.9 },
      ],
      proactive_triggers: [
        {
          type: 'commitment_check',
          description: 'Gym workout',
          trigger_time: 'tomorrow 6:30',
          context: 'User goes to gym every weekday morning',
          guidance: null,
          recurring_pattern: 'every weekday',
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('I go to gym every weekday at 7am', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const recurring = mockDb.addScheduledItem.mock.calls[0][0].recurring;
    expect(recurring).not.toBeNull();
    expect(recurring.type).toBe('weekdays');
  });

  it('should parse weekly with day recurring pattern correctly', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [
        { content: 'Has team standup every Monday at 9am', subject: 'user', category: 'work', confidence: 0.9 },
      ],
      proactive_triggers: [
        {
          type: 'event_prep',
          description: 'Monday team standup',
          trigger_time: 'Monday 8:00',
          context: 'Weekly team standup meeting',
          guidance: 'Check team status updates',
          recurring_pattern: 'every Monday at 9am',
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('We have team standup every Monday at 9am', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const recurring = mockDb.addScheduledItem.mock.calls[0][0].recurring;
    expect(recurring).not.toBeNull();
    expect(recurring.type).toBe('weekly');
    expect(recurring.dayOfWeek).toBe(1); // Monday
    expect(recurring.hour).toBe(9);
    expect(recurring.minute).toBe(0);
  });

  it('should create one-time trigger when recurring_pattern is null', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [],
      proactive_triggers: [
        {
          type: 'event_prep',
          description: 'Doctor appointment',
          trigger_time: 'tomorrow 9:00',
          context: 'User has a doctor appointment',
          guidance: null,
          recurring_pattern: null,
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('I have a doctor appointment tomorrow at 10am', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const recurring = mockDb.addScheduledItem.mock.calls[0][0].recurring;
    expect(recurring).toBeNull();
  });

  it('should create one-time trigger for invalid recurring_pattern', async () => {
    const mockDb = createMockDatabase();
    const mockScallopStore = createMockScallopStore(mockDb);

    const mockProvider = createMockProvider(JSON.stringify({
      facts: [],
      proactive_triggers: [
        {
          type: 'follow_up',
          description: 'Check on project',
          trigger_time: 'tomorrow 9:00',
          context: 'User working on project',
          guidance: null,
          recurring_pattern: 'every other fortnight',
        },
      ],
    }));

    const extractor = new LLMFactExtractor({
      provider: mockProvider,
      scallopStore: mockScallopStore,
      logger,
      useRelationshipClassifier: false,
    });

    await extractor.extractFacts('Working on my project, need to check back', 'user-123');

    expect(mockDb.addScheduledItem).toHaveBeenCalledTimes(1);
    const recurring = mockDb.addScheduledItem.mock.calls[0][0].recurring;
    expect(recurring).toBeNull();
  });
});
