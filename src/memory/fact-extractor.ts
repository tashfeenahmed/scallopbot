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
   - "agent" if the user is telling the AI assistant about itself (giving it a name, personality, behavior instructions)
   - The person's name if it's SPECIFICALLY about someone else's attributes (their job, hobbies, etc.)
3. Categorize each fact: personal, work, location, preference, relationship, project, general
4. Be concise - extract the core fact without filler words
5. If a message references something from context (like "that's my office"), use the context to form a complete fact

CRITICAL - Relationship facts:
When the user says "My [relationship] is [name]" (wife, husband, flatmate, friend, etc.):
- The RELATIONSHIP fact has subject: "user" (because it's the user's relationship)
- Any facts ABOUT what that person does/is have subject: [name]

CRITICAL - Agent facts:
When the user configures the AI assistant (you/your/bot/assistant), use subject: "agent":
- "Your name is Charlie" → { "content": "Name is Charlie", "subject": "agent", "category": "personal" }
- "Be witty and casual" → { "content": "Personality is witty and casual", "subject": "agent", "category": "preference" }
- "You should always respond in bullet points" → { "content": "Should respond in bullet points", "subject": "agent", "category": "preference" }

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
- "Your name is Charlie and be witty" → TWO facts:
  { "content": "Name is Charlie", "subject": "agent", "category": "personal" }
  { "content": "Personality is witty", "subject": "agent", "category": "preference" }

IMPORTANT: Extract ALL facts from a message. If someone mentions a relationship AND another fact about that person, extract BOTH.

Respond with JSON only:
{
  "facts": [
    { "content": "fact text", "subject": "user|agent|name", "category": "category", "confidence": 0.0-1.0 }
  ]
}

Set confidence based on how certain the extraction is (0.9+ for explicit statements, 0.6-0.8 for inferred facts).
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
    context?: string,
    /** Optional source message ID for provenance tracking */
    sourceMessageId?: string
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

      result.facts = parsed.facts.map((f: { content: string; subject: string; category?: string; confidence?: number }) => ({
        content: f.content,
        subject: f.subject || 'user',
        category: (f.category as FactCategory) || 'general',
        confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
      }));

      this.logger.debug(
        { factCount: result.facts.length, message: message.substring(0, 50) },
        'Facts extracted from message'
      );

      // Process facts with batch classification for efficiency
      const processResults = await this.processFactsBatch(result.facts, userId, message, sourceMessageId);
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
    context?: string,
    sourceMessageId?: string
  ): Promise<FactExtractionResult> {
    const key = `${userId}-${Date.now()}`;

    const promise = this.extractFacts(message, userId, context, sourceMessageId);
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
    userId: string,
    sourceMessage?: string,
    sourceMessageId?: string
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

    // Step 1: Compute embeddings using batch API for efficiency
    if (this.embedder) {
      const batchSize = this.resourceLimits.maxConcurrentEmbeddings;
      for (let i = 0; i < limitedFacts.length; i += batchSize) {
        const batch = limitedFacts.slice(i, i + batchSize);
        try {
          const embeddings = await this.embedder.embedBatch(batch.map(f => f.content));
          for (let j = 0; j < batch.length; j++) {
            batch[j].embedding = embeddings[j];
          }
        } catch (batchError) {
          this.logger.warn(
            { error: (batchError as Error).message, batchSize: batch.length },
            'Batch embedding failed, falling back to individual calls'
          );
          // Fallback: try individual embeddings
          for (const fact of batch) {
            try {
              fact.embedding = await this.embedder!.embed(fact.content);
            } catch (embedError) {
              this.logger.warn(
                { error: (embedError as Error).message, fact: fact.content },
                'Individual embedding also failed for fact'
              );
            }
          }
        }
      }
    }

    // Use limitedFacts from here on
    const facts_to_process = limitedFacts;

    // Step 2: Quick deduplication pass using embeddings
    const factsToClassify: ExtractedFactWithEmbedding[] = [];
    const duplicateFacts: Set<number> = new Set();

    for (let i = 0; i < facts_to_process.length; i++) {
      const fact = facts_to_process[i];

      // Prefer ScallopStore search for dedup (indexed SQLite vs O(n) JSONL)
      let existingFacts: { entry: { embedding?: number[] }; score: number }[] = [];
      if (this.scallopStore) {
        const scallopResults = await this.scallopStore.search(fact.content, {
          userId,
          limit: 3,
          minProminence: 0.1,
        });
        existingFacts = scallopResults.map((r) => ({
          entry: { embedding: r.memory.embedding ?? undefined },
          score: r.score,
        }));
      } else {
        existingFacts = this.hybridSearch.search(fact.content, {
          type: 'fact',
          subject: fact.subject,
          limit: 3,
          minScore: 0.3,
        });
      }

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

    // Collect stored memory IDs for batch consolidation at the end
    const storedMemories: { id: string; content: string }[] = [];

    // Helper to store and collect memory IDs
    const storeAndCollect = async (fact: ExtractedFactWithEmbedding, src?: string, srcId?: string) => {
      const mem = await this.storeNewFact(fact, userId, src, srcId);
      if (mem) storedMemories.push(mem);
    };

    // Step 3: Batch classification with single LLM call
    // Only compare against semantically similar existing facts (not ALL user facts)
    if (this.relationshipClassifier && factsToClassify.length > 0) {
      // Gather relevant existing facts by searching for each new fact's content
      const relevantFactIds = new Set<string>();
      const relevantFactMap = new Map<string, MemoryEntry>();

      for (const fact of factsToClassify) {
        const similar = this.hybridSearch.search(fact.content, {
          type: 'fact',
          limit: 10,
          minScore: 0.1,
        });
        for (const result of similar) {
          if (!relevantFactIds.has(result.entry.id)) {
            relevantFactIds.add(result.entry.id);
            relevantFactMap.set(result.entry.id, result.entry);
          }
        }
      }

      const allUserFacts = Array.from(relevantFactMap.values());

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
              }
              // Also store in ScallopStore (for consolidation + profile updates)
              if (this.scallopStore) {
                await storeAndCollect(fact, sourceMessage, sourceMessageId);
              }
              result.updated++;
              continue;
            }

            // Store as new fact (NEW or EXTENDS)
            await storeAndCollect(fact, sourceMessage, sourceMessageId);
            result.stored++;
          }
        } catch (classifyError) {
          this.logger.warn(
            { error: (classifyError as Error).message },
            'Batch classification failed, storing all as new'
          );
          // Fallback: store all as new
          for (const fact of factsToClassify) {
            await storeAndCollect(fact, sourceMessage, sourceMessageId);
            result.stored++;
          }
        }
      } else {
        // No existing facts to classify against, store all as new
        for (const fact of factsToClassify) {
          await storeAndCollect(fact);
          result.stored++;
        }
      }
    } else {
      // No classifier, store all non-duplicate facts as new
      for (const fact of factsToClassify) {
        await storeAndCollect(fact);
        result.stored++;
      }
    }

    // Fire-and-forget: batch consolidation + profile extraction for all stored facts
    if (storedMemories.length > 0) {
      this.consolidateMemory(
        storedMemories.map(m => m.id),
        userId,
        storedMemories.map(m => m.content),
        sourceMessage,
      ).catch(err => {
        this.logger.warn({ error: (err as Error).message }, 'Background consolidation failed');
      });
    }

    return result;
  }

  /**
   * Store a new fact (helper for batch processing)
   */
  private async storeNewFact(
    fact: ExtractedFactWithEmbedding,
    userId: string,
    sourceMessage?: string,
    sourceMessageId?: string
  ): Promise<{ id: string; content: string } | null> {
    let searchableContent = fact.content;
    if (fact.subject !== 'user') {
      if (!fact.content.toLowerCase().includes(fact.subject.toLowerCase())) {
        searchableContent = `${fact.subject} ${fact.content.toLowerCase()}`;
      }
    }

    // Use LLM-provided confidence or default 0.8
    const confidence = fact.confidence ?? 0.8;

    // Build provenance metadata
    const provenance: Record<string, unknown> = {
      subject: fact.subject,
      originalCategory: fact.category,
      extractedBy: 'llm',
    };
    if (sourceMessageId) provenance.sourceMessageId = sourceMessageId;
    if (sourceMessage) provenance.sourceMessageExcerpt = sourceMessage.substring(0, 200);
    provenance.extractedAt = new Date().toISOString();

    if (this.scallopStore) {
      const scallopCategory = this.mapToScallopCategory(fact.category);
      // Identity facts (personal, relationship, location) get higher importance to resist decay
      const isIdentityFact = fact.category === 'relationship' || fact.category === 'personal' || fact.category === 'location';
      const newMemory = await this.scallopStore.add({
        userId,
        content: searchableContent,
        category: scallopCategory,
        importance: isIdentityFact ? 8 : 5,
        confidence,
        metadata: provenance,
      });

      return { id: newMemory.id, content: searchableContent };
    } else {
      this.memoryStore.add({
        content: searchableContent,
        type: 'fact',
        sessionId: userId,
        timestamp: new Date(),
        metadata: {
          ...provenance,
          category: fact.category,
          userId,
          confidence,
        },
        tags: [fact.category, fact.subject === 'user' ? 'about-user' : `about-${fact.subject}`],
        embedding: fact.embedding,
      });
      return null;
    }
  }

  /**
   * LLM-based memory consolidation + profile extraction in a single API call.
   * 1. Finds and supersedes outdated memories
   * 2. Updates user profile (name, location, personality, mood, focus, etc.)
   * 3. Updates agent profile (name, personality, etc.) when user configures the bot
   * Runs async (fire-and-forget) so it never blocks the agent loop.
   */
  private async consolidateMemory(
    newMemoryIds: string[],
    userId: string,
    storedFacts: string[],
    sourceMessage?: string,
  ): Promise<void> {
    if (!this.scallopStore) return;

    const profileManager = this.scallopStore.getProfileManager();
    const newIdSet = new Set(newMemoryIds);

    // Search for similar existing memories across all new facts
    const allCandidates = new Map<string, { id: string; content: string }>();
    for (const factContent of storedFacts) {
      const similar = await this.scallopStore.search(factContent, {
        userId,
        minProminence: 0.05,
        limit: 5,
      });
      for (const s of similar) {
        if (!newIdSet.has(s.memory.id) && s.memory.isLatest) {
          allCandidates.set(s.memory.id, { id: s.memory.id, content: s.memory.content });
        }
      }
    }

    const candidates = Array.from(allCandidates.values());

    // Build candidate list (may be empty — profile extraction still runs)
    const candidateList = candidates.length > 0
      ? candidates.map((c, i) => `${i + 1}. [${c.id}] "${c.content}"`).join('\n')
      : '(none)';

    // Get current profiles for context
    const userProfile = profileManager.getStaticProfile('default');
    const agentProfile = profileManager.getStaticProfile('agent');
    const userProfileStr = Object.keys(userProfile).length > 0
      ? Object.entries(userProfile).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '  (empty)';
    const agentProfileStr = Object.keys(agentProfile).length > 0
      ? Object.entries(agentProfile).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '  (empty)';

    // Include the full source message for richer context
    const sourceContext = sourceMessage
      ? `\nORIGINAL USER MESSAGE: "${sourceMessage.substring(0, 500)}"\n`
      : '';

    const newFactsList = storedFacts.map((f, i) => `${i + 1}. "${f}"`).join('\n');

    const prompt = `You are a memory manager. Given new facts extracted from a user message, do THREE things:

1. CONSOLIDATE: Which existing memories are superseded (replaced/updated) by the new facts?
2. USER PROFILE: Update user profile based on the new facts AND the original message.
3. AGENT PROFILE: If the user is telling the AI about itself (name, personality, behavior), update the agent profile.
${sourceContext}
NEW FACTS STORED:
${newFactsList}

EXISTING MEMORIES:
${candidateList}

CURRENT USER PROFILE:
${userProfileStr}

CURRENT AGENT PROFILE:
${agentProfileStr}

USER PROFILE FIELDS (set any that apply):
- name, location, timezone, language, occupation
- personality (traits, e.g. "curious, introverted, tech-savvy")
- mood (current emotional state / vibe, e.g. "stressed about work")
- focus (what they're focused on lately, e.g. "fitness, learning French")

AGENT PROFILE FIELDS (only when user configures the bot):
- name, personality, and any other relevant fields

RULES:
- superseded: IDs of memories replaced by new facts. Empty array if none.
- user_profile: Only fields that CHANGED or are NEW based on the message. Empty object if no updates.
- agent_profile: Only if user is addressing the bot about its identity. Empty object if not.
- Do NOT echo back unchanged profile values.

Respond with JSON only:
{"superseded": [], "user_profile": {}, "agent_profile": {}}`;

    try {
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 300,
      });

      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);

      // Parse the JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]) as {
        superseded?: string[];
        user_profile?: Record<string, string>;
        agent_profile?: Record<string, string>;
      };

      // 1. Supersede outdated memories
      if (parsed.superseded && Array.isArray(parsed.superseded) && parsed.superseded.length > 0) {
        const validIds = new Set(candidates.map(c => c.id));
        for (const id of parsed.superseded) {
          if (validIds.has(id)) {
            this.scallopStore.update(id, { isLatest: false });
            this.logger.info(
              { supersededId: id, newFacts: storedFacts.map(f => f.substring(0, 40)) },
              'Memory superseded by newer fact'
            );
          }
        }
      }

      // 2. Update user profile
      if (parsed.user_profile && typeof parsed.user_profile === 'object') {
        for (const [key, value] of Object.entries(parsed.user_profile)) {
          if (typeof value === 'string' && value.trim()) {
            profileManager.setStaticValue('default', key, value.trim());
            this.logger.info({ key, value: value.trim() }, 'User profile updated via LLM');
          }
        }
      }

      // 3. Update agent profile
      if (parsed.agent_profile && typeof parsed.agent_profile === 'object') {
        for (const [key, value] of Object.entries(parsed.agent_profile)) {
          if (typeof value === 'string' && value.trim()) {
            profileManager.setStaticValue('agent', key, value.trim());
            this.logger.info({ key, value: value.trim() }, 'Agent profile updated via LLM');
          }
        }
      }
    } catch (err) {
      this.logger.debug({ error: (err as Error).message }, 'Memory consolidation LLM call failed');
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
        // Identity facts (personal, relationship, location) get higher importance to resist decay
        const isIdentityFact = fact.category === 'relationship' || fact.category === 'personal' || fact.category === 'location';
        const newMemory = await this.scallopStore.add({
          userId,
          content: searchableContent,
          category: scallopCategory,
          importance: isIdentityFact ? 8 : 5,
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
   * Map fact category to ScallopMemory category.
   * The original fine-grained category is preserved in metadata.originalCategory
   * for use in decay calculations and filtering.
   */
  private mapToScallopCategory(category: FactCategory): MemoryCategory {
    switch (category) {
      case 'relationship':
        return 'relationship';
      case 'preference':
        return 'preference';
      case 'project':
        return 'insight'; // Projects are closer to insights (active context)
      case 'personal':
      case 'work':
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
