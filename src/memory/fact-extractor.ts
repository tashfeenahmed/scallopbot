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
 * Options for LLMFactExtractor
 */
export interface LLMFactExtractorOptions {
  provider: LLMProvider;
  memoryStore: MemoryStore;
  hybridSearch: HybridSearch;
  logger: Logger;
  embedder?: EmbeddingProvider;
  /** Similarity threshold for deduplication (0-1, default 0.85) */
  deduplicationThreshold?: number;
  /** Whether to update existing facts with more specific info */
  enableFactUpdates?: boolean;
  /** ScallopMemoryStore for enhanced fact storage (optional) */
  scallopStore?: ScallopMemoryStore;
}

/**
 * The prompt used to extract facts from messages
 */
const FACT_EXTRACTION_PROMPT = `You are a fact extraction system. Extract factual information from the user's message.

Rules:
1. Only extract concrete facts, not opinions or temporary states
2. For each fact, identify WHO it's about:
   - "user" if it's about the person speaking
   - The person's name if it's about someone else (e.g., "Hamza", "John")
3. Categorize each fact: personal, work, location, preference, relationship, project, general
4. Be concise - extract the core fact without filler words
5. If a message references something from context (like "that's my office"), use the context to form a complete fact

Examples:
- "I work at Microsoft" → { "content": "Works at Microsoft", "subject": "user", "category": "work" }
- "My flatmate Hamza works at Google" → { "content": "Works at Google", "subject": "Hamza", "category": "work" }
- "Yes that's my office" (context: One Microsoft Court) → { "content": "Office is One Microsoft Court", "subject": "user", "category": "location" }
- "I prefer dark mode" → { "content": "Prefers dark mode", "subject": "user", "category": "preference" }

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
  private enableFactUpdates: boolean;
  private processingQueue: Map<string, Promise<FactExtractionResult>> = new Map();
  private scallopStore?: ScallopMemoryStore;

  constructor(options: LLMFactExtractorOptions) {
    this.provider = options.provider;
    this.memoryStore = options.memoryStore;
    this.hybridSearch = options.hybridSearch;
    this.logger = options.logger.child({ component: 'fact-extractor' });
    this.embedder = options.embedder;
    this.deduplicationThreshold = options.deduplicationThreshold ?? 0.85;
    this.enableFactUpdates = options.enableFactUpdates ?? true;
    this.scallopStore = options.scallopStore;
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

      // Process each fact: deduplicate and store
      for (const fact of result.facts) {
        const storeResult = await this.processAndStoreFact(fact, userId);
        if (storeResult === 'stored') {
          result.factsStored++;
        } else if (storeResult === 'updated') {
          result.factsUpdated++;
        } else if (storeResult === 'duplicate') {
          result.duplicatesSkipped++;
        }
      }

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
        for (const result of existingFacts) {
          if (result.score > this.deduplicationThreshold) {
            isDuplicate = true;
            if (result.score > highestSimilarity) {
              highestSimilarity = result.score;
              mostSimilarFact = result.entry;
            }
          }
        }
      }

      // If exact duplicate but new fact is more detailed, update
      if (isDuplicate && this.enableFactUpdates && mostSimilarFact) {
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
        return 'duplicate';
      }

      if (isDuplicate) {
        this.logger.debug(
          { fact: fact.content, similarity: highestSimilarity },
          'Skipping duplicate fact'
        );
        return 'duplicate';
      }

      // FACT ENRICHMENT: Search for related facts by category+subject
      // This catches corrections like "office in Wicklow" → "office in Dublin"
      if (this.enableFactUpdates) {
        const categoryFacts = this.findFactsByCategoryAndSubject(fact.category, fact.subject);

        if (categoryFacts.length > 0 && newEmbedding) {
          // Find the most semantically related fact in the same category
          let mostRelatedFact: MemoryEntry | null = null;
          let highestRelation = 0;
          const ENRICHMENT_THRESHOLD = 0.5; // Lower threshold for same-category enrichment

          for (const existingFact of categoryFacts) {
            let existingEmbedding = existingFact.embedding;
            if (!existingEmbedding && this.embedder) {
              try {
                existingEmbedding = await this.embedder.embed(existingFact.content);
              } catch {
                // Skip this fact if embedding fails
                continue;
              }
            }

            if (existingEmbedding) {
              const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

              if (similarity > highestRelation && similarity >= ENRICHMENT_THRESHOLD) {
                highestRelation = similarity;
                mostRelatedFact = existingFact;
              }
            }
          }

          // If we found a related fact, UPDATE it with the new info (newer takes precedence)
          if (mostRelatedFact) {
            this.memoryStore.update(mostRelatedFact.id, {
              content: fact.content,
              timestamp: new Date(),
              embedding: fact.embedding,
            });
            this.logger.info(
              {
                old: mostRelatedFact.content,
                new: fact.content,
                category: fact.category,
                similarity: highestRelation.toFixed(2)
              },
              'Enriched existing fact with updated info'
            );
            return 'updated';
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
