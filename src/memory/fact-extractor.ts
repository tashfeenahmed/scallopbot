/**
 * LLM-based Fact Extractor
 *
 * Extracts facts from user messages using an LLM, with semantic deduplication
 * to avoid storing redundant information. Runs asynchronously to not block
 * the main conversation flow.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '../providers/types.js';
import type { CostTracker } from '../routing/cost.js';
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
 * Action types for extracted items
 */
export type FactAction = 'fact' | 'forget' | 'correction' | 'preference_update';

/**
 * A fact extracted by the LLM
 */
export interface ExtractedFactWithEmbedding {
  content: string;
  subject: string;  // 'user' or person's name
  category: FactCategory;
  confidence?: number;
  embedding?: number[];
  /** Action type - defaults to 'fact' for regular storage */
  action?: FactAction;
  /** For corrections: the old value being replaced */
  oldValue?: string;
  /** For preference updates: what this preference replaces */
  replaces?: string;
}

/**
 * Result of fact extraction
 */
export interface FactExtractionResult {
  facts: ExtractedFactWithEmbedding[];
  factsStored: number;
  factsUpdated: number;
  factsDeleted: number;
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
  scallopStore: ScallopMemoryStore;
  logger: Logger;
  embedder?: EmbeddingProvider;
  /** Cost tracker for recording LLM usage from background extraction */
  costTracker?: CostTracker;
  /** Similarity threshold for deduplication (0-1, default 0.95) */
  deduplicationThreshold?: number;
  /** Whether to use LLM for relationship classification (recommended) */
  useRelationshipClassifier?: boolean;
  /** Resource limits for memory-constrained environments */
  resourceLimits?: ResourceLimits;
}

/**
 * The prompt used to extract facts from messages
 */
const FACT_EXTRACTION_PROMPT = `You are a fact extraction system. Extract factual information AND detect memory actions from the user's message.

ACTION TYPES:
- "fact" (default): Store as new knowledge
- "forget": User wants to REMOVE stored information (forget, delete, remove, don't remember)
- "correction": User is CORRECTING previous information (actually, no I meant, that's wrong)
- "preference_update": User is explicitly stating a preference comparison (prefer X over Y)

Rules:
1. Only extract concrete facts, not opinions or temporary states
2. For each fact, identify WHO it's about:
   - "user" if it's about the person speaking (their name, job, preferences, relationships, location)
   - "agent" if the user is telling the AI assistant about itself (giving it a name, personality, behavior instructions)
   - The person's name if it's SPECIFICALLY about someone else's attributes (their job, hobbies, etc.)
3. Categorize each fact: personal, work, location, preference, relationship, project, general
4. Be concise - extract the core fact without filler words
5. If a message references something from context (like "that's my office"), use the context to form a complete fact
6. DETECT ACTIONS: Look for forget requests, corrections, and preference updates

CRITICAL - Relationship facts:
When the user says "My [relationship] is [name]" (wife, husband, flatmate, friend, etc.):
- The RELATIONSHIP fact has subject: "user" (because it's the user's relationship)
- Any facts ABOUT what that person does/is have subject: [name]

CRITICAL - Agent facts:
When the user configures the AI assistant (you/your/bot/assistant), use subject: "agent":
- "Your name is Charlie" → { "content": "Name is Charlie", "subject": "agent", "category": "personal" }
- "Be witty and casual" → { "content": "Personality is witty and casual", "subject": "agent", "category": "preference" }

CRITICAL - Forget requests:
When user asks to forget/delete/remove information:
- "Forget that I work at Microsoft" → { "action": "forget", "content": "Works at Microsoft", "subject": "user", "category": "work" }
- "Delete my location data" → { "action": "forget", "content": "location", "subject": "user", "category": "location" }
- "Don't remember my wife's name" → { "action": "forget", "content": "Wife", "subject": "user", "category": "relationship" }

CRITICAL - Corrections:
When user corrects previous information (actually, no, that's wrong, I meant):
- "Actually I live in Dublin now, not Wicklow" → { "action": "correction", "content": "Lives in Dublin", "old_value": "Wicklow", "subject": "user", "category": "location" }
- "No, I said Python not JavaScript" → { "action": "correction", "content": "Prefers Python", "old_value": "JavaScript", "subject": "user", "category": "preference" }
- "That's wrong, my wife's name is Hayat not Sarah" → { "action": "correction", "content": "Wife is Hayat", "old_value": "Sarah", "subject": "user", "category": "relationship" }

CRITICAL - Preference updates:
When user explicitly compares preferences (prefer X over Y, like X better than Y):
- "I prefer dark mode over light mode" → { "action": "preference_update", "content": "Prefers dark mode", "replaces": "light mode", "subject": "user", "category": "preference" }
- "I like Python better than JavaScript for scripting" → { "action": "preference_update", "content": "Prefers Python for scripting", "replaces": "JavaScript", "subject": "user", "category": "preference" }

Regular fact examples (action defaults to "fact"):
- "I work at Microsoft" → { "content": "Works at Microsoft", "subject": "user", "category": "work" }
- "My wife is Hayat" → { "content": "Wife is Hayat", "subject": "user", "category": "relationship" }
- "I live in Wicklow" → { "content": "Lives in Wicklow", "subject": "user", "category": "location" }

IMPORTANT: Extract ALL facts from a message. If someone mentions a relationship AND another fact about that person, extract BOTH.

Respond with JSON only:
{
  "facts": [
    { "content": "fact text", "subject": "user|agent|name", "category": "category", "confidence": 0.0-1.0, "action": "fact|forget|correction|preference_update", "old_value": "optional", "replaces": "optional" }
  ]
}

Notes:
- "action" defaults to "fact" if not specified
- "old_value" only for corrections
- "replaces" only for preference_update
- Set confidence based on how certain the extraction is (0.9+ for explicit statements, 0.6-0.8 for inferred facts)
- If no facts can be extracted, return: { "facts": [] }`;

/**
 * LLM-based fact extractor with semantic deduplication
 */
export class LLMFactExtractor {
  private provider: LLMProvider;
  private scallopStore: ScallopMemoryStore;
  private logger: Logger;
  private embedder?: EmbeddingProvider;
  private deduplicationThreshold: number;
  private relationshipClassifier?: RelationshipClassifier;
  private processingQueue: Map<string, Promise<FactExtractionResult>> = new Map();
  private resourceLimits: Required<ResourceLimits>;

  constructor(options: LLMFactExtractorOptions) {
    // Wrap provider with cost tracking if available
    this.provider = options.costTracker
      ? options.costTracker.wrapProvider(options.provider, 'fact-extractor')
      : options.provider;
    this.scallopStore = options.scallopStore;
    this.logger = options.logger.child({ component: 'fact-extractor' });
    this.embedder = options.embedder;
    this.deduplicationThreshold = options.deduplicationThreshold ?? 0.95;

    // Set resource limits with defaults suitable for 4GB RAM
    this.resourceLimits = {
      maxFactsPerMessage: options.resourceLimits?.maxFactsPerMessage ?? 20,
      maxConcurrentEmbeddings: options.resourceLimits?.maxConcurrentEmbeddings ?? 5,
      maxClassificationBatchSize: options.resourceLimits?.maxClassificationBatchSize ?? 10,
      disableClassificationOnLowMemory: options.resourceLimits?.disableClassificationOnLowMemory ?? false,
    };

    // Use LLM-based relationship classifier by default (uses the same wrapped provider)
    if (options.useRelationshipClassifier !== false) {
      this.relationshipClassifier = createRelationshipClassifier(this.provider, {
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
      factsDeleted: 0,
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

      result.facts = parsed.facts.map((f: {
        content: string;
        subject: string;
        category?: string;
        confidence?: number;
        action?: string;
        old_value?: string;
        replaces?: string;
      }) => ({
        content: f.content,
        subject: f.subject || 'user',
        category: (f.category as FactCategory) || 'general',
        confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
        action: (f.action as FactAction) || 'fact',
        oldValue: f.old_value,
        replaces: f.replaces,
      }));

      this.logger.debug(
        { factCount: result.facts.length, message: message.substring(0, 50) },
        'Facts extracted from message'
      );

      // Process facts with batch classification for efficiency
      const processResults = await this.processFactsBatch(result.facts, userId, message, sourceMessageId);
      result.factsStored = processResults.stored;
      result.factsUpdated = processResults.updated;
      result.factsDeleted = processResults.deleted;
      result.duplicatesSkipped = processResults.duplicates;

      // If no facts were stored, still extract triggers from the source message
      // This handles temporal events like "I have a dentist appointment tomorrow"
      // which don't produce static facts but should create proactive triggers
      if (result.factsStored === 0 && message) {
        this.extractTriggersFromMessage(message, userId, 'user').catch(err => {
          this.logger.debug({ error: (err as Error).message }, 'Background trigger extraction failed');
        });
      }

      this.logger.info(
        {
          stored: result.factsStored,
          updated: result.factsUpdated,
          deleted: result.factsDeleted,
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
   * Extract proactive triggers from a message (user or assistant)
   * This is a lighter-weight extraction focused only on time-sensitive events.
   * Called for both user messages (when no facts found) and assistant messages.
   */
  async extractTriggersFromMessage(
    message: string,
    userId: string,
    source: 'user' | 'assistant' = 'user'
  ): Promise<void> {
    if (!this.scallopStore) return;

    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = `You are a proactive trigger extractor. Analyze this message for time-sensitive items that warrant follow-up.

CURRENT DATE: ${currentDate}

MESSAGE (from ${source}):
"${message}"

EXTRACT PROACTIVE TRIGGERS for:
- Upcoming events: "meeting tomorrow", "dentist next week", "flight on Friday"
- Commitments: "I'll finish the report", "planning to start gym", "need to call mom"
- Goals: "trying to lose weight", "learning Spanish", "saving for vacation"
- Deadlines: "due Friday", "need to submit by EOD", "expires next month"
- Appointments: "dentist at 2pm", "doctor appointment", "scheduled for 3pm"

${source === 'assistant' ? `Note: This is from the AI assistant. Extract triggers for events/commitments the assistant mentioned or confirmed.` : ''}

Format each trigger as:
{
  "type": "event_prep" | "commitment_check" | "goal_checkin" | "follow_up",
  "description": "Brief description of what to follow up on",
  "trigger_time": "MUST include specific time - use ISO datetime with time (e.g., '2026-02-07T09:00:00') OR relative ('+2h', '+1d 9am', 'tomorrow 10:00')",
  "context": "Context for generating the proactive message"
}

Trigger time guidelines:
- event_prep: 2 hours before the event (for same-day) or morning of (8-9am for future days)
- commitment_check: Next day morning (9am) or after stated deadline
- goal_checkin: 1 week for short-term, 2 weeks for long-term goals, at 10am
- follow_up: Based on context, usually next day at 9am

RULES:
- CRITICAL: trigger_time MUST include a specific time (hour:minute), not just a date!
- "TODAY" alone is NOT valid - must be "TODAY 2pm" or similar with time
- Only create triggers for EXPLICIT time-sensitive items, not vague statements
- Return empty array if nothing time-sensitive found or if no specific time can be determined

Respond with JSON only:
{"proactive_triggers": []}`;

    try {
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 400,
      });

      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]) as {
        proactive_triggers?: Array<{
          type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
          description: string;
          trigger_time: string;
          context: string;
        }>;
      };

      if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
        const db = this.scallopStore.getDatabase();
        for (const trigger of parsed.proactive_triggers) {
          if (trigger.description && trigger.trigger_time && trigger.context) {
            const triggerAt = this.parseTriggerTime(trigger.trigger_time);
            if (!triggerAt) {
              this.logger.debug({ trigger_time: trigger.trigger_time }, 'Invalid trigger time, skipping');
              continue;
            }

            if (db.hasSimilarPendingScheduledItem(userId, trigger.description)) {
              this.logger.debug({ description: trigger.description }, 'Similar scheduled item already exists, skipping');
              continue;
            }

            db.addScheduledItem({
              userId,
              sessionId: null,
              source: 'agent',
              type: trigger.type || 'follow_up',
              message: trigger.description,
              context: trigger.context,
              triggerAt,
              recurring: null,
              sourceMemoryId: null,
            });
            this.logger.info(
              { type: trigger.type, description: trigger.description, source, triggerAt: new Date(triggerAt).toISOString() },
              'Scheduled item created from message'
            );
          }
        }
      }
    } catch (err) {
      this.logger.debug({ error: (err as Error).message }, 'Trigger extraction failed');
    }
  }

  /**
   * Process multiple facts in a batch with single LLM classification call
   * Efficiently processes all facts with a single LLM classification call
   */
  private async processFactsBatch(
    facts: ExtractedFactWithEmbedding[],
    userId: string,
    sourceMessage?: string,
    sourceMessageId?: string
  ): Promise<{ stored: number; updated: number; duplicates: number; deleted: number }> {
    const result = { stored: 0, updated: 0, duplicates: 0, deleted: 0 };

    if (facts.length === 0) {
      return result;
    }

    // Step 0: Route action-based items first (forget, correction, preference_update)
    const regularFacts: ExtractedFactWithEmbedding[] = [];

    for (const fact of facts) {
      const action = fact.action || 'fact';

      if (action === 'forget') {
        // Handle forget request - delete matching memories
        const forgetResult = await this.handleForgetRequest(fact, userId);
        result.deleted += forgetResult.deleted;
        continue;
      }

      if (action === 'correction' || action === 'preference_update') {
        // Handle correction - supersede old and store new
        await this.handleCorrection(fact, userId, sourceMessage, sourceMessageId);
        result.updated++;
        continue;
      }

      // Regular fact - continue to normal processing
      regularFacts.push(fact);
    }

    // If no regular facts remain, we're done
    if (regularFacts.length === 0) {
      return result;
    }

    // Continue with regular fact processing
    const factsToProcess = regularFacts;

    // Apply resource limit: cap facts per message
    const limitedFacts = factsToProcess.slice(0, this.resourceLimits.maxFactsPerMessage);
    if (factsToProcess.length > this.resourceLimits.maxFactsPerMessage) {
      this.logger.warn(
        { total: factsToProcess.length, processed: limitedFacts.length },
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

      // Search ScallopStore for dedup
      const scallopResults = await this.scallopStore.search(fact.content, {
        userId,
        limit: 3,
        minProminence: 0.1,
      });
      const existingFacts = scallopResults.map((r) => ({
        entry: { embedding: r.memory.embedding ?? undefined },
        score: r.score,
      }));

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
      // Gather relevant existing facts by searching ScallopStore
      const relevantFactIds = new Set<string>();
      const relevantFacts: { id: string; content: string; subject: string; category: string }[] = [];

      for (const fact of factsToClassify) {
        const similar = await this.scallopStore.search(fact.content, {
          userId,
          limit: 10,
          minProminence: 0.1,
        });
        for (const result of similar) {
          if (!relevantFactIds.has(result.memory.id)) {
            relevantFactIds.add(result.memory.id);
            relevantFacts.push({
              id: result.memory.id,
              content: result.memory.content,
              subject: (result.memory.metadata?.subject as string) || 'user',
              category: (result.memory.metadata?.originalCategory as string) || result.memory.category || 'general',
            });
          }
        }
      }

      if (relevantFacts.length > 0) {
        const existingFactsForClassifier: ExistingFact[] = relevantFacts;

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
              // Mark old fact as superseded and store new version
              this.scallopStore.update(classification.targetId, { isLatest: false });
              await storeAndCollect(fact, sourceMessage, sourceMessageId);
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
  }

  /**
   * Handle a forget request - delete matching memories
   */
  private async handleForgetRequest(
    request: ExtractedFactWithEmbedding,
    userId: string
  ): Promise<{ deleted: number }> {
    // Build search query - include subject if not 'user'
    let searchQuery = request.content;
    if (request.subject && request.subject !== 'user') {
      searchQuery = `${request.subject} ${request.content}`;
    }

    // Search for matching memories
    const matches = await this.scallopStore.search(searchQuery, {
      userId,
      limit: 10,
      minProminence: 0.05, // Include low-prominence memories too
    });

    let deleted = 0;
    for (const match of matches) {
      // Only delete if semantic similarity is high enough
      if (match.score > 0.5) {
        this.scallopStore.delete(match.memory.id);
        deleted++;
        this.logger.info(
          { id: match.memory.id, content: match.memory.content, score: match.score },
          'Memory deleted per user forget request'
        );
      }
    }

    if (deleted === 0) {
      this.logger.debug({ searchQuery }, 'No matching memories found to forget');
    }

    return { deleted };
  }

  /**
   * Handle a correction - supersede old memory and store new one
   */
  private async handleCorrection(
    correction: ExtractedFactWithEmbedding,
    userId: string,
    sourceMessage?: string,
    sourceMessageId?: string
  ): Promise<{ updated: boolean; newMemoryId?: string }> {
    // Build search query from old_value if available, otherwise use content
    const searchQuery = correction.oldValue || correction.replaces || correction.content;

    // Find memories that might be corrected
    const candidates = await this.scallopStore.search(searchQuery, {
      userId,
      limit: 5,
      minProminence: 0.1,
    });

    // Supersede matching memories
    let superseded = 0;
    for (const candidate of candidates) {
      if (candidate.score > 0.4) {
        this.scallopStore.update(candidate.memory.id, { isLatest: false });
        superseded++;
        this.logger.info(
          { oldId: candidate.memory.id, oldContent: candidate.memory.content, newContent: correction.content },
          'Memory superseded by correction'
        );
      }
    }

    // Store the correction as new fact with high confidence
    const newMemory = await this.storeNewFact(
      {
        ...correction,
        confidence: 0.95, // High confidence for explicit corrections
      },
      userId,
      sourceMessage,
      sourceMessageId
    );

    return { updated: superseded > 0, newMemoryId: newMemory?.id };
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

    // Include current date for accurate trigger time calculation
    const now = new Date();
    const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = `You are a memory manager. Given new facts extracted from a user message, do FIVE things.

CURRENT DATE: ${currentDate}

1. CONSOLIDATE: Which existing memories are superseded (replaced/updated) by the new facts?
2. USER PROFILE: Update user profile based on the new facts AND the original message.
3. AGENT PROFILE: If the user is telling the AI about itself (name, personality, behavior), update the agent profile.
4. PREFERENCES LEARNED: Extract preference patterns from the message (especially from corrections or comparisons).
5. PROACTIVE TRIGGERS: Extract time-sensitive items that warrant proactive follow-up.
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

PREFERENCES LEARNED:
- When user says "I prefer X over Y" or corrects from Y to X, record the preference
- When user shows a pattern (e.g., always chooses concise responses), record it
- Format: { "domain": "category", "prefers": "X", "over": "Y", "strength": 0.5-1.0 }
- Domains: communication, technology, lifestyle, work, food, entertainment, etc.

PROACTIVE TRIGGERS (for agent-initiated follow-ups):
Look for time-sensitive items in the ORIGINAL USER MESSAGE:
- Upcoming events: "meeting tomorrow", "dentist next week", "flight on Friday"
- Commitments: "I'll finish the report", "planning to start gym", "need to call mom"
- Goals: "trying to lose weight", "learning Spanish", "saving for vacation"
- Deadlines: "due Friday", "need to submit by EOD", "expires next month"

Format: {
  "type": "event_prep" | "commitment_check" | "goal_checkin" | "follow_up",
  "description": "Brief description of what to follow up on",
  "trigger_time": "MUST include specific time - use ISO datetime with time (e.g., '2026-02-07T09:00:00') OR relative ('+2h', '+1d 9am', 'tomorrow 10:00')",
  "context": "Context for generating the proactive message"
}

Trigger time guidelines:
- event_prep: 2 hours before the event (for same-day) or morning of (8-9am for future days)
- commitment_check: Next day morning (9am) or after stated deadline
- goal_checkin: 1 week for short-term, 2 weeks for long-term goals, at 10am
- follow_up: Based on context, usually next day at 9am

RULES:
- superseded: IDs of memories replaced by new facts. Empty array if none.
- user_profile: Only fields that CHANGED or are NEW based on the message. Empty object if no updates.
- agent_profile: Only if user is addressing the bot about its identity. Empty object if not.
- preferences_learned: Array of preference objects. Empty array if no clear preferences.
- proactive_triggers: Array of trigger objects. Empty array if nothing time-sensitive.
- Do NOT echo back unchanged profile values.
- Only create triggers for EXPLICIT time-sensitive items, not vague statements.
- CRITICAL: trigger_time MUST include a specific time (hour:minute), not just a date!
- "TODAY" alone is NOT valid - must include time like "TODAY 2pm".

Respond with JSON only:
{"superseded": [], "user_profile": {}, "agent_profile": {}, "preferences_learned": [], "proactive_triggers": []}`;

    try {
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 500, // Increased for proactive triggers
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
        preferences_learned?: Array<{
          domain?: string;
          prefers: string;
          over: string;
          strength?: number;
        }>;
        proactive_triggers?: Array<{
          type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
          description: string;
          trigger_time: string;
          context: string;
        }>;
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

      // 4. Store learned preferences
      if (parsed.preferences_learned && Array.isArray(parsed.preferences_learned) && parsed.preferences_learned.length > 0) {
        for (const pref of parsed.preferences_learned) {
          if (pref.prefers && pref.over) {
            // First, check if a similar preference already exists and supersede it
            const existingPrefs = await this.scallopStore.search(`Prefers ${pref.over}`, {
              userId,
              limit: 3,
              minProminence: 0.1,
            });
            for (const existing of existingPrefs) {
              if (existing.score > 0.6 && existing.memory.category === 'preference') {
                this.scallopStore.update(existing.memory.id, { isLatest: false });
                this.logger.debug(
                  { oldPref: existing.memory.content },
                  'Old preference superseded by learned preference'
                );
              }
            }

            // Store the new preference
            await this.scallopStore.add({
              userId,
              content: `Prefers ${pref.prefers} over ${pref.over}`,
              category: 'preference',
              importance: 7, // High importance for explicit preferences
              confidence: pref.strength || 0.8,
              metadata: {
                preferenceType: 'learned',
                domain: pref.domain || 'general',
                prefers: pref.prefers,
                over: pref.over,
                learnedFrom: 'feedback',
                extractedAt: new Date().toISOString(),
              },
            });
            this.logger.info(
              { prefers: pref.prefers, over: pref.over, domain: pref.domain },
              'Preference learned from user feedback'
            );
          }
        }
      }

      // 5. Store proactive triggers
      if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
        const db = this.scallopStore.getDatabase();
        for (const trigger of parsed.proactive_triggers) {
          if (trigger.description && trigger.trigger_time && trigger.context) {
            // Parse trigger time (ISO or relative)
            const triggerAt = this.parseTriggerTime(trigger.trigger_time);
            if (!triggerAt) {
              this.logger.debug({ trigger_time: trigger.trigger_time }, 'Invalid trigger time, skipping');
              continue;
            }

            // Check for duplicate scheduled items
            if (db.hasSimilarPendingScheduledItem(userId, trigger.description)) {
              this.logger.debug({ description: trigger.description }, 'Similar scheduled item already exists, skipping');
              continue;
            }

            // Store the scheduled item
            db.addScheduledItem({
              userId,
              sessionId: null,
              source: 'agent',
              type: trigger.type || 'follow_up',
              message: trigger.description,
              context: trigger.context,
              triggerAt,
              recurring: null,
              sourceMemoryId: newMemoryIds[0] || null,
            });
            this.logger.info(
              { type: trigger.type, description: trigger.description, triggerAt: new Date(triggerAt).toISOString() },
              'Scheduled item created'
            );
          }
        }
      }
    } catch (err) {
      this.logger.debug({ error: (err as Error).message }, 'Memory consolidation LLM call failed');
    }
  }

  /**
   * Parse trigger time from ISO or relative format
   * Supports: ISO datetime with time, '+2h', '+1d', '+1w', 'tomorrow 9am', '+1d morning', 'Monday 10:00', etc.
   * REJECTS: date-only strings like "2026-02-07" or "TODAY" without time
   */
  private parseTriggerTime(timeStr: string): number | null {
    const now = Date.now();

    // Reject "TODAY" without specific time
    if (/^today$/i.test(timeStr.trim())) {
      return null;
    }

    // Try ISO format - but ONLY if it includes time component (T or space followed by time)
    // Reject date-only formats like "2026-02-07"
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(timeStr)) {
      const isoDate = new Date(timeStr);
      if (!isNaN(isoDate.getTime())) {
        return isoDate.getTime();
      }
    }

    const lowerStr = timeStr.toLowerCase();

    // Relative time patterns: +1d, +2h, +1w, +1m
    const relativeMatch = timeStr.match(/^\+(\d+)(h|d|w|m)$/i);
    if (relativeMatch) {
      const [, amount, unit] = relativeMatch;
      const value = parseInt(amount, 10);
      switch (unit.toLowerCase()) {
        case 'h':
          return now + value * 60 * 60 * 1000;
        case 'd':
          return now + value * 24 * 60 * 60 * 1000;
        case 'w':
          return now + value * 7 * 24 * 60 * 60 * 1000;
        case 'm':
          return now + value * 30 * 24 * 60 * 60 * 1000; // Approximate month
      }
    }

    // Relative time with time of day: +1d morning, +2d evening, +1d 9am
    const relativeWithTimeMatch = timeStr.match(/^\+(\d+)(d|w)\s+(.+)$/i);
    if (relativeWithTimeMatch) {
      const [, amount, unit, timeOfDay] = relativeWithTimeMatch;
      const value = parseInt(amount, 10);
      const daysToAdd = unit.toLowerCase() === 'w' ? value * 7 : value;

      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + daysToAdd);

      // Parse time of day
      const timeOfDayLower = timeOfDay.toLowerCase().trim();
      if (timeOfDayLower === 'morning') {
        targetDate.setHours(9, 0, 0, 0);
      } else if (timeOfDayLower === 'afternoon') {
        targetDate.setHours(14, 0, 0, 0);
      } else if (timeOfDayLower === 'evening') {
        targetDate.setHours(18, 0, 0, 0);
      } else if (timeOfDayLower === 'night') {
        targetDate.setHours(20, 0, 0, 0);
      } else {
        // Try parsing as specific time (9am, 10:30, etc.)
        const specificTime = this.parseTimeOfDay(timeOfDay);
        if (specificTime) {
          targetDate.setHours(specificTime.hour, specificTime.minute, 0, 0);
        } else {
          targetDate.setHours(9, 0, 0, 0); // Default to morning
        }
      }

      return targetDate.getTime();
    }

    // Day of week patterns: Monday, next Tuesday, etc.
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < dayNames.length; i++) {
      if (lowerStr.includes(dayNames[i])) {
        const targetDate = new Date(now);
        const currentDay = targetDate.getDay();
        let daysUntil = i - currentDay;
        if (daysUntil <= 0) daysUntil += 7; // Next occurrence

        targetDate.setDate(targetDate.getDate() + daysUntil);

        // Try to parse time from the string
        const specificTime = this.parseTimeOfDay(timeStr);
        if (specificTime) {
          targetDate.setHours(specificTime.hour, specificTime.minute, 0, 0);
        } else {
          targetDate.setHours(9, 0, 0, 0); // Default to 9am
        }

        return targetDate.getTime();
      }
    }

    // Today with time pattern (e.g., "today 2pm", "today 14:30")
    if (lowerStr.includes('today')) {
      const specificTime = this.parseTimeOfDay(timeStr);
      if (specificTime) {
        const today = new Date(now);
        today.setHours(specificTime.hour, specificTime.minute, 0, 0);
        // Only valid if the time is in the future
        if (today.getTime() > now) {
          return today.getTime();
        }
      }
      // "today" without valid future time - reject
      return null;
    }

    // Tomorrow patterns
    if (lowerStr.includes('tomorrow')) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const specificTime = this.parseTimeOfDay(timeStr);
      if (specificTime) {
        tomorrow.setHours(specificTime.hour, specificTime.minute, 0, 0);
      } else {
        tomorrow.setHours(9, 0, 0, 0);
      }
      return tomorrow.getTime();
    }

    return null;
  }

  /**
   * Parse time of day from string (e.g., "9am", "14:30", "2:30pm")
   */
  private parseTimeOfDay(str: string): { hour: number; minute: number } | null {
    // Match patterns like "9am", "9:30am", "14:00", "2:30pm"
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3]?.toLowerCase();

      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      // Validate hour
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute };
      }
    }
    return null;
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
