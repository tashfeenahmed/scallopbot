/**
 * LLM-based Fact Extractor
 *
 * Extracts facts from user messages using an LLM, with semantic deduplication
 * to avoid storing redundant information. Runs asynchronously to not block
 * the main conversation flow.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '../providers/types.js';
import type { MemoryStore, HybridSearch, MemoryEntry } from './memory.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';
import type { ScallopMemoryStore } from './scallop-store.js';
import type { MemoryCategory } from './db.js';
import {
  RelationshipClassifier,
  createRelationshipClassifier,
  type ExistingFact,
} from './relation-classifier.js';

/**
 * Categories for extracted facts
 */
export type FactCategory =
  | 'personal'    // Name, age, nationality
  | 'work'        // Job, company, role
  | 'location'    // Home, office, city
  | 'preference'  // Likes, dislikes, settings
  | 'relationship'// Family, friends, colleagues
  | 'project'     // Current work, hobbies
  | 'general';    // Other facts

/**
 * A fact extracted by the LLM
 */
export interface ExtractedFactWithEmbedding {
  content: string;
  subject: string;  // 'user' or person's name
  category: FactCategory;
  confidence?: number;
  embedding?: number[];
}

/**
 * Result of fact extraction
 */
export interface FactExtractionResult {
  facts: ExtractedFactWithEmbedding[];
  factsStored: number;
  factsUpdated: number;
  duplicatesSkipped: number;
  error?: string;
}

/**
 * Resource limits for memory-constrained environments
 */
export interface ResourceLimits {
  /** Maximum facts to process per message (default: 20) */
  maxFactsPerMessage?: number;
  /** Maximum concurrent embedding operations (default: 5) */
  maxConcurrentEmbeddings?: number;
  /** Maximum batch size for LLM classification (default: 10) */
  maxClassificationBatchSize?: number;
  /** Disable LLM classification when memory is low (default: false) */
  disableClassificationOnLowMemory?: boolean;
}

/**
 * Options for LLMFactExtractor
 */
export interface LLMFactExtractorOptions {
  provider: LLMProvider;
  memoryStore: MemoryStore;
  hybridSearch: HybridSearch;
  logger: Logger;
  embedder?: EmbeddingProvider;
  /** Similarity threshold for deduplication (0-1, default 0.95) */
  deduplicationThreshold?: number;
  /** Whether to use LLM for relationship classification (recommended) */
  useRelationshipClassifier?: boolean;
  /** ScallopMemoryStore for enhanced fact storage (optional) */
  scallopStore?: ScallopMemoryStore;
  /** Resource limits for memory-constrained environments */
  resourceLimits?: ResourceLimits;
}

/**
 * The prompt used to extract facts from messages
 */
const FACT_EXTRACTION_PROMPT = `You are a fact extraction system. Extract factual information from the user's message.

Rules:
1. Only extract concrete facts, not opinions or temporary states
2. For each fact, identify WHO it's about:
   - "user" if it's about the person speaking (their name, job, preferences, relationships, location)
   - The person's name if it's SPECIFICALLY about someone else's attributes (their job, hobbies, etc.)
3. Categorize each fact: personal, work, location, preference, relationship, project, general
4. Be concise - extract the core fact without filler words
5. If a message references something from context (like "that's my office"), use the context to form a complete fact

CRITICAL - Relationship facts:
When the user says "My [relationship] is [name]" (wife, husband, flatmate, friend, etc.):
- The RELATIONSHIP fact has subject: "user" (because it's the user's relationship)
- Any facts ABOUT what that person does/is have subject: [name]

Examples:
- "I work at Microsoft" → { "content": "Works at Microsoft", "subject": "user", "category": "work" }
- "My wife is Hayat" → { "content": "Wife is Hayat", "subject": "user", "category": "relationship" }
- "She is a TikToker" (context: wife is Hayat) → { "content": "Is a TikToker", "subject": "Hayat", "category": "work" }
- "My wife Hayat is a TikToker" → TWO facts:
  { "content": "Wife is Hayat", "subject": "user", "category": "relationship" }
  { "content": "Is a TikToker", "subject": "Hayat", "category": "work" }
- "My flatmate Hamza works at Google" → TWO facts:
  { "content": "Flatmate is Hamza", "subject": "user", "category": "relationship" }
  { "content": "Works at Google", "subject": "Hamza", "category": "work" }
- "I live in Wicklow" → { "content": "Lives in Wicklow", "subject": "user", "category": "location" }
- "Yes that's my office" (context: One Microsoft Court) → { "content": "Office is One Microsoft Court", "subject": "user", "category": "location" }
- "I prefer dark mode" → { "content": "Prefers dark mode", "subject": "user", "category": "preference" }

IMPORTANT: Extract ALL facts from a message. If someone mentions a relationship AND another fact about that person, extract BOTH.

Respond with JSON only:
{
  "facts": [
    { "content": "fact text", "subject": "user|name", "category": "category" }
  ]
}

If no facts can be extracted, return: { "facts": [] }`;

/**
 * LLM-based fact extractor with semantic deduplication
 */
export class LLMFactExtractor {
  private provider: LLMProvider;
  private memoryStore: MemoryStore;
  private hybridSearch: HybridSearch;
  private logger: Logger;
  private embedder?: EmbeddingProvider;
  private deduplicationThreshold: number;
  private relationshipClassifier?: RelationshipClassifier;
  private processingQueue: Map<string, Promise<FactExtractionResult>> = new Map();
  private scallopStore?: ScallopMemoryStore;
  private resourceLimits: Required<ResourceLimits>;

  constructor(options: LLMFactExtractorOptions) {
    this.provider = options.provider;
    this.memoryStore = options.memoryStore;
    this.hybridSearch = options.hybridSearch;
    this.logger = options.logger.child({ component: 'fact-extractor' });
    this.embedder = options.embedder;
    this.deduplicationThreshold = options.deduplicationThreshold ?? 0.95;
    this.scallopStore = options.scallopStore;

    // Set resource limits with defaults suitable for 4GB RAM
    this.resourceLimits = {
      maxFactsPerMessage: options.resourceLimits?.maxFactsPerMessage ?? 20,
      maxConcurrentEmbeddings: options.resourceLimits?.maxConcurrentEmbeddings ?? 5,
      maxClassificationBatchSize: options.resourceLimits?.maxClassificationBatchSize ?? 10,
      disableClassificationOnLowMemory: options.resourceLimits?.disableClassificationOnLowMemory ?? false,
    };

    // Use LLM-based relationship classifier by default
    if (options.useRelationshipClassifier !== false) {
      this.relationshipClassifier = createRelationshipClassifier(options.provider, {
        maxBatchSize: this.resourceLimits.maxClassificationBatchSize,
      });
      this.logger.debug('LLM relationship classifier enabled with batch classification');
    }
  }

  /**
   * Extract facts from a user message
   */
  async extractFacts(
    message: string,
    userId: string,
    context?: string
  ): Promise<FactExtractionResult> {
    const result: FactExtractionResult = {
      facts: [],
      factsStored: 0,
      factsUpdated: 0,
      duplicatesSkipped: 0,
    };

    try {
      // Build prompt with optional context
      let prompt = FACT_EXTRACTION_PROMPT + '\n\n';
      if (context) {
        prompt += `Context from previous messages:\n${context}\n\n`;
      }
      prompt += `User message:\n${message}\n\nExtract facts (JSON only):`;

      // Call LLM to extract facts
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
      });

      // Parse response - handle ContentBlock[] response
      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);
      const parsed = this.parseResponse(responseText);
      if (!parsed.facts || !Array.isArray(parsed.facts)) {
        this.logger.debug({ response: response.content }, 'No facts extracted');
        return result;
      }

      result.facts = parsed.facts.map((f: { content: string; subject: string; category?: string }) => ({
        content: f.content,
        subject: f.subject || 'user',
        category: (f.category as FactCategory) || 'general',
      }));

      this.logger.debug(
        { factCount: result.facts.length, message: message.substring(0, 50) },
        'Facts extracted from message'
      );

      // Process facts with batch classification for efficiency
      const processResults = await this.processFactsBatch(result.facts, userId);
      result.factsStored = processResults.stored;
      result.factsUpdated = processResults.updated;
      result.duplicatesSkipped = processResults.duplicates;

      this.logger.info(
        {
          stored: result.factsStored,
          updated: result.factsUpdated,
          skipped: result.duplicatesSkipped,
        },
        'Fact extraction complete'
      );

      return result;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ error: err.message }, 'Fact extraction failed');
      result.error = err.message;
      return result;
    }
  }

  /**
   * Queue a message for async fact extraction (non-blocking)
   */
  async queueForExtraction(
    message: string,
    userId: string,
    context?: string
  ): Promise<FactExtractionResult> {
    const key = `${userId}-${Date.now()}`;

    const promise = this.extractFacts(message, userId, context);
    this.processingQueue.set(key, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.processingQueue.delete(key);
    }
  }

  /**
   * Process multiple facts in a batch with single LLM classification call
   * Much more efficient than calling processAndStoreFact for each fact
   */
  private async processFactsBatch(
    facts: ExtractedFactWithEmbedding[],
    userId: string
  ): Promise<{ stored: number; updated: number; duplicates: number }> {
    const result = { stored: 0, updated: 0, duplicates: 0 };

    if (facts.length === 0) {
      return result;
    }

    // Apply resource limit: cap facts per message
    const limitedFacts = facts.slice(0, this.resourceLimits.maxFactsPerMessage);
    if (facts.length > this.resourceLimits.maxFactsPerMessage) {
      this.logger.warn(
        { total: facts.length, processed: limitedFacts.length },
        'Truncated facts due to resource limits'
      );
    }

    // Step 1: Compute embeddings with concurrency limit
    if (this.embedder) {
      const concurrencyLimit = this.resourceLimits.maxConcurrentEmbeddings;
      for (let i = 0; i < limitedFacts.length; i += concurrencyLimit) {
        const batch = limitedFacts.slice(i, i + concurrencyLimit);
        await Promise.all(
          batch.map(async (fact) => {
            try {
              fact.embedding = await this.embedder!.embed(fact.content);
            } catch (embedError) {
              this.logger.warn(
                { error: (embedError as Error).message, fact: fact.content },
                'Embedding failed for fact'
              );
            }
          })
        );
      }
    }

    // Use limitedFacts from here on
    const facts_to_process = limitedFacts;

    // Step 2: Quick deduplication pass using embeddings
    const factsToClassify: ExtractedFactWithEmbedding[] = [];
    const duplicateFacts: Set<number> = new Set();

    for (let i = 0; i < facts_to_process.length; i++) {
      const fact = facts_to_process[i];
      const existingFacts = this.hybridSearch.search(fact.content, {
        type: 'fact',
        subject: fact.subject,
        limit: 3,
        minScore: 0.3,
      });

      // Check for exact duplicates using embeddings
      let isDuplicate = false;
      if (fact.embedding && existingFacts.length > 0) {
        for (const existing of existingFacts) {
          if (existing.entry.embedding) {
            const similarity = cosineSimilarity(fact.embedding, existing.entry.embedding);
            if (similarity >= this.deduplicationThreshold) {
              isDuplicate = true;
              break;
            }
          }
        }
      }

      if (isDuplicate) {
        duplicateFacts.add(i);
        result.duplicates++;
      } else {
        factsToClassify.push(fact);
      }
    }

    // Step 3: Batch classification with single LLM call
    if (this.relationshipClassifier && factsToClassify.length > 0) {
      const allUserFacts = this.memoryStore.searchByType('fact')
        .filter(f => f.metadata?.userId === userId || f.metadata?.subject === 'user');

      if (allUserFacts.length > 0) {
        const existingFactsForClassifier: ExistingFact[] = allUserFacts.map(f => ({
          id: f.id,
          content: f.content,
          subject: (f.metadata?.subject as string) || 'user',
          category: (f.metadata?.category as string) || 'general',
        }));

        try {
          // Single batch LLM call instead of N calls
          const classifications = await this.relationshipClassifier.classifyBatch(
            factsToClassify.map(f => ({
              content: f.content,
              subject: f.subject,
              category: f.category,
            })),
            existingFactsForClassifier
          );

          this.logger.debug(
            { factCount: factsToClassify.length, classifications: classifications.length },
            'Batch classification complete'
          );

          // Step 4: Apply classifications and store
          for (let i = 0; i < factsToClassify.length; i++) {
            const fact = factsToClassify[i];
            const classification = classifications[i];

            if (classification.classification === 'UPDATES' && classification.targetId) {
              const targetFact = this.memoryStore.get(classification.targetId);
              if (targetFact) {
                this.memoryStore.update(classification.targetId, {
                  content: fact.content,
                  timestamp: new Date(),
                  embedding: fact.embedding,
                  metadata: {
                    ...targetFact.metadata,
                    previousContent: targetFact.content,
                    updatedAt: new Date().toISOString(),
                  },
                });
                result.updated++;
                continue;
              }
            }

            // Store as new fact (NEW or EXTENDS)
            await this.storeNewFact(fact, userId);
            result.stored++;
          }
        } catch (classifyError) {
          this.logger.warn(
            { error: (classifyError as Error).message },
            'Batch classification failed, storing all as new'
          );
          // Fallback: store all as new
          for (const fact of factsToClassify) {
            await this.storeNewFact(fact, userId);
            result.stored++;
          }
        }
      } else {
        // No existing facts to classify against, store all as new
        for (const fact of factsToClassify) {
          await this.storeNewFact(fact, userId);
          result.stored++;
        }
      }
    } else {
      // No classifier, store all non-duplicate facts as new
      for (const fact of factsToClassify) {
        await this.storeNewFact(fact, userId);
        result.stored++;
      }
    }

    return result;
  }

  /**
   * Store a new fact (helper for batch processing)
   */
  private async storeNewFact(fact: ExtractedFactWithEmbedding, userId: string): Promise<void> {
    let searchableContent = fact.content;
    if (fact.subject !== 'user') {
      if (!fact.content.toLowerCase().includes(fact.subject.toLowerCase())) {
        searchableContent = `${fact.subject} ${fact.content.toLowerCase()}`;
      }
    }

    if (this.scallopStore) {
      const scallopCategory = this.mapToScallopCategory(fact.category);
      await this.scallopStore.add({
        userId,
        content: searchableContent,
        category: scallopCategory,
        importance: 5,
        confidence: 0.8,
        metadata: {
          subject: fact.subject,
          originalCategory: fact.category,
          extractedBy: 'llm',
        },
      });
    } else {
      this.memoryStore.add({
        content: searchableContent,
        type: 'fact',
        sessionId: userId,
        timestamp: new Date(),
        metadata: {
          subject: fact.subject,
          category: fact.category,
          userId,
          extractedBy: 'llm',
        },
        tags: [fact.category, fact.subject === 'user' ? 'about-user' : `about-${fact.subject}`],
        embedding: fact.embedding,
      });
    }
  }

  /**
   * Find existing facts by category and subject for enrichment
   */
  private findFactsByCategoryAndSubject(
    category: FactCategory,
    subject: string
  ): MemoryEntry[] {
    const allFacts = this.memoryStore.getAll().filter(m => m.type === 'fact');

    return allFacts.filter(fact => {
      const factCategory = fact.metadata?.category as string | undefined;
      const factSubject = fact.metadata?.subject as string | undefined;

      return (
        factCategory?.toLowerCase() === category.toLowerCase() &&
        factSubject?.toLowerCase() === subject.toLowerCase()
      );
    });
  }

  /**
   * Process a fact: check for duplicates, enrich existing facts, or store new
   *
   * Fact Enrichment Logic:
   * 1. If exact/near duplicate found (>0.85 similarity), skip unless more detailed
   * 2. If related fact in same category+subject found (>0.5 similarity), UPDATE it
   *    This handles corrections like "office in Wicklow" → "office in Dublin"
   * 3. If no related fact, store as new
   */
  private async processAndStoreFact(
    fact: ExtractedFactWithEmbedding,
    userId: string
  ): Promise<'stored' | 'updated' | 'duplicate' | 'error'> {
    try {
      // Get embedding for new fact early (needed for both dedup and enrichment)
      // Embedding is optional - if it fails, we still store the fact without it
      let newEmbedding: number[] | undefined;
      if (this.embedder) {
        try {
          newEmbedding = await this.embedder.embed(fact.content);
          fact.embedding = newEmbedding;
        } catch (embedError) {
          this.logger.warn(
            { error: (embedError as Error).message, fact: fact.content },
            'Embedding failed, storing fact without embedding'
          );
          // Continue without embedding - fact will still be stored
        }
      }

      // Search for similar existing facts by content
      const existingFacts = this.hybridSearch.search(fact.content, {
        type: 'fact',
        subject: fact.subject,
        limit: 5,
        minScore: 0.3,
      });

      // Check for semantic duplicates using embeddings if available
      let isDuplicate = false;
      let mostSimilarFact: MemoryEntry | null = null;
      let highestSimilarity = 0;

      if (newEmbedding && existingFacts.length > 0) {
        for (const result of existingFacts) {
          // Get or compute embedding for existing fact
          let existingEmbedding = result.entry.embedding;
          if (!existingEmbedding && this.embedder) {
            try {
              existingEmbedding = await this.embedder.embed(result.entry.content);
            } catch {
              // Skip semantic comparison if embedding fails
              continue;
            }
          }
          if (!existingEmbedding) continue;

          const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

          if (similarity > highestSimilarity) {
            highestSimilarity = similarity;
            mostSimilarFact = result.entry;
          }

          if (similarity >= this.deduplicationThreshold) {
            isDuplicate = true;
          }
        }
      } else if (existingFacts.length > 0) {
        // Fallback: use BM25 score for deduplication
        // BM25 scores are not normalized (0-1), so use a higher threshold
        const bm25Threshold = 2.0; // Much higher than embedding threshold
        for (const result of existingFacts) {
          this.logger.debug({ fact: fact.content, existing: result.entry.content, score: result.score }, 'BM25 comparison');
          if (result.score > bm25Threshold) {
            isDuplicate = true;
            if (result.score > highestSimilarity) {
              highestSimilarity = result.score;
              mostSimilarFact = result.entry;
            }
          }
        }
      }

      // If exact duplicate but new fact is more detailed, update
      if (isDuplicate && mostSimilarFact) {
        if (fact.content.length > mostSimilarFact.content.length * 1.2) {
          // New fact is significantly more detailed - update
          this.memoryStore.update(mostSimilarFact.id, {
            content: fact.content,
            timestamp: new Date(),
            embedding: fact.embedding,
          });
          this.logger.debug(
            { old: mostSimilarFact.content, new: fact.content },
            'Updated fact with more specific info'
          );
          return 'updated';
        }

        this.logger.info(
          { fact: fact.content, similarity: highestSimilarity.toFixed(3), mostSimilar: mostSimilarFact?.content },
          'Skipping duplicate fact'
        );
        return 'duplicate';
      }

      // Use LLM-based relationship classifier if available
      if (this.relationshipClassifier) {
        // Get all existing facts for this user to compare against
        const allUserFacts = this.memoryStore.searchByType('fact')
          .filter(f => f.metadata?.userId === userId || f.metadata?.subject === fact.subject);

        if (allUserFacts.length > 0) {
          // Convert to classifier format
          const existingFactsForClassifier: ExistingFact[] = allUserFacts.map(f => ({
            id: f.id,
            content: f.content,
            subject: (f.metadata?.subject as string) || 'user',
            category: (f.metadata?.category as string) || 'general',
          }));

          try {
            const classification = await this.relationshipClassifier.classify(
              { content: fact.content, subject: fact.subject, category: fact.category },
              existingFactsForClassifier
            );

            this.logger.debug(
              { fact: fact.content, classification: classification.classification, reason: classification.reason },
              'LLM relationship classification'
            );

            if (classification.classification === 'UPDATES' && classification.targetId) {
              // Update the existing fact
              const targetFact = this.memoryStore.get(classification.targetId);
              if (targetFact) {
                this.memoryStore.update(classification.targetId, {
                  content: fact.content,
                  timestamp: new Date(),
                  embedding: fact.embedding,
                  metadata: {
                    ...targetFact.metadata,
                    previousContent: targetFact.content,
                    updatedAt: new Date().toISOString(),
                  },
                });
                this.logger.info(
                  { old: targetFact.content, new: fact.content, reason: classification.reason },
                  'Updated fact via LLM classification'
                );
                return 'updated';
              }
            }
            // For EXTENDS and NEW, we store as new (EXTENDS creates a link, handled by graph)
            // Classification result is logged for debugging
          } catch (classifyError) {
            this.logger.warn(
              { error: (classifyError as Error).message },
              'LLM classification failed, storing as new fact'
            );
          }
        }
      }

      // Store new fact - use ScallopMemory if available
      // For third-party facts, include the subject name in the content for searchability
      // e.g., "Works at Google" with subject "Hamza" becomes "Hamza works at Google"
      let searchableContent = fact.content;
      if (fact.subject !== 'user') {
        // Prepend subject name if not already present in content
        if (!fact.content.toLowerCase().includes(fact.subject.toLowerCase())) {
          searchableContent = `${fact.subject} ${fact.content.toLowerCase()}`;
        }
      }

      if (this.scallopStore) {
        // Map fact category to ScallopMemory category
        const scallopCategory = this.mapToScallopCategory(fact.category);
        await this.scallopStore.add({
          userId,
          content: searchableContent,
          category: scallopCategory,
          importance: 5,
          confidence: 0.8,
          metadata: {
            subject: fact.subject,
            originalCategory: fact.category,
            extractedBy: 'llm',
          },
        });
        this.logger.debug({ fact: searchableContent, subject: fact.subject, store: 'scallop' }, 'Stored new fact in ScallopMemory');
      } else {
        // Legacy storage
        this.memoryStore.add({
          content: searchableContent,
          type: 'fact',
          sessionId: userId,  // Use userId as sessionId for facts
          timestamp: new Date(),
          metadata: {
            subject: fact.subject,
            category: fact.category,
            userId,
            extractedBy: 'llm',
          },
          tags: [fact.category, fact.subject === 'user' ? 'about-user' : `about-${fact.subject}`],
          embedding: fact.embedding,
        });
        this.logger.debug({ fact: searchableContent, subject: fact.subject }, 'Stored new fact');
      }
      return 'stored';
    } catch (error) {
      this.logger.error({ error: (error as Error).message, fact: fact.content }, 'Failed to process fact');
      return 'error';
    }
  }

  /**
   * Map fact category to ScallopMemory category
   */
  private mapToScallopCategory(category: FactCategory): MemoryCategory {
    switch (category) {
      case 'relationship':
        return 'relationship';
      case 'preference':
        return 'preference';
      case 'personal':
      case 'work':
      case 'project':
      case 'location':
      case 'general':
      default:
        return 'fact';
    }
  }

  /**
   * Parse LLM response, handling potential JSON issues
   */
  private parseResponse(content: string): { facts: ExtractedFactWithEmbedding[] } {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { facts: [] };
    } catch {
      this.logger.warn({ content: content.substring(0, 100) }, 'Failed to parse LLM response');
      return { facts: [] };
    }
  }

  /**
   * Get pending extractions count
   */
  getPendingCount(): number {
    return this.processingQueue.size;
  }
}

/**
 * Helper function to extract facts without full extractor setup
 */
export async function extractFactsWithLLM(
  provider: LLMProvider,
  message: string,
  context?: string
): Promise<{ facts: ExtractedFactWithEmbedding[] }> {
  let prompt = FACT_EXTRACTION_PROMPT + '\n\n';
  if (context) {
    prompt += `Context from previous messages:\n${context}\n\n`;
  }
  prompt += `User message:\n${message}\n\nExtract facts (JSON only):`;

  const response = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
  });

  // Handle ContentBlock[] response
  const responseText = Array.isArray(response.content)
    ? response.content.map(block => 'text' in block ? block.text : '').join('')
    : String(response.content);

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        facts: (parsed.facts || []).map((f: { content: string; subject?: string; category?: string }) => ({
          content: f.content,
          subject: f.subject || 'user',
          category: (f.category as FactCategory) || 'general',
        })),
      };
    }
  } catch {
    // Parsing failed
  }

  return { facts: [] };
}
