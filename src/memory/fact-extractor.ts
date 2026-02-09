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
import type { MemoryCategory, RecurringSchedule } from './db.js';
import {
  type RelationshipClassifier,
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
  /** Callback to resolve IANA timezone for a user (defaults to server timezone) */
  getTimezone?: (userId: string) => string;
}

/**
 * The prompt used to extract facts from messages
 */
const FACT_AND_TRIGGER_EXTRACTION_PROMPT = `You are a fact extraction system. Extract factual information, detect memory actions, AND identify proactive triggers from the user's message.

CURRENT DATE: {{CURRENT_DATE}}
CURRENT TIME: {{CURRENT_TIME}}

ACTION TYPES:
- "fact" (default): Store as new knowledge
- "forget": User wants to REMOVE stored information (forget, delete, remove, don't remember)
- "correction": User is CORRECTING previous information (actually, no I meant, that's wrong)
- "preference_update": User is explicitly stating a preference comparison (prefer X over Y)

Rules:
1. Only extract CONCRETE, DURABLE facts — NOT questions, greetings, opinions, temporary states, or conversational filler
2. NEVER extract: "hey how are you", "what do you know", "what time is it", "good morning", casual chat, rhetorical questions, or messages that contain no factual information about the user
3. A valid fact is something worth remembering long-term: name, job, location, family, preferences, projects, skills, relationships
4. For each fact, identify WHO it's about:
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

PROACTIVE TRIGGERS (for agent-initiated follow-ups):
Extract time-sensitive items that warrant proactive follow-up:
- Upcoming events: "meeting tomorrow", "dentist next week", "flight on Friday"
- Commitments: "I'll finish the report", "planning to start gym", "need to call mom"
- Goals: "trying to lose weight", "learning Spanish", "saving for vacation"
- Deadlines: "due Friday", "need to submit by EOD", "expires next month"
- Appointments: "dentist at 2pm", "doctor appointment", "scheduled for 3pm"

Format each trigger as:
{
  "type": "event_prep" | "commitment_check" | "goal_checkin" | "follow_up",
  "description": "Brief description of what to follow up on",
  "trigger_time": "MUST include specific time - use ISO datetime with time (e.g., '2026-02-07T09:00:00') OR relative ('+2h', '+1d 9am', 'tomorrow 10:00')",
  "context": "Context for generating the proactive message",
  "guidance": "Specific instructions for the bot on what to do to help the user when the trigger fires (e.g., 'Search for directions and check weather', 'Look up flight status')",
  "recurring": "null if one-time, OR an object: { \"type\": \"daily\" | \"weekly\" | \"weekdays\" | \"weekends\", \"hour\": 0-23, \"minute\": 0-59, \"dayOfWeek\": 0-6 (Sunday=0, only for weekly) }"
}

RECURRING RULES:
- If the user says "daily", "every day", "every morning", "every evening", etc. → set recurring with type "daily"
- If the user says "every weekday", "monday to friday" → type "weekdays"
- If the user says "every weekend" → type "weekends"
- If the user says "every Monday", "every Tuesday", etc. → type "weekly" with the correct dayOfWeek
- ALWAYS set hour and minute in the recurring object to match the intended time (24h format)
- Do NOT leave recurring as null when the user explicitly asks for a repeating schedule!

Trigger time guidelines:
- event_prep: 2 hours before the event (for same-day) or morning of (8-9am for future days)
- commitment_check: Next day morning (9am) or after stated deadline
- goal_checkin: 1 week for short-term, 2 weeks for long-term goals, at 10am
- follow_up: Based on context, usually next day at 9am

IMPORTANT: Extract ALL facts from a message. If someone mentions a relationship AND another fact about that person, extract BOTH.

Respond with JSON only:
{
  "facts": [
    { "content": "fact text", "subject": "user|agent|name", "category": "category", "confidence": 0.0-1.0, "action": "fact|forget|correction|preference_update", "old_value": "optional", "replaces": "optional" }
  ],
  "proactive_triggers": [
    { "type": "event_prep|commitment_check|goal_checkin|follow_up", "description": "text", "trigger_time": "ISO or relative", "context": "text", "guidance": "text or null", "recurring": "null or {type, hour, minute, dayOfWeek?}" }
  ]
}

Notes:
- "action" defaults to "fact" if not specified
- "old_value" only for corrections
- "replaces" only for preference_update
- Set confidence based on how certain the extraction is (0.9+ for explicit statements, 0.6-0.8 for inferred facts)
- If no facts can be extracted, return EMPTY facts array — this is the CORRECT response for greetings, questions, small talk, and messages with no factual content
- If nothing time-sensitive found, return empty proactive_triggers array
- NEVER store questions the user asked (e.g., "what do you know about me") — those are queries, not facts
- NEVER store greetings or filler ("hey", "hi", "thanks", "good morning")
- Each fact should be a concise statement under 100 characters
- CRITICAL: trigger_time MUST include a specific time (hour:minute), not just a date!
- "TODAY" alone is NOT valid - must be "TODAY 2pm" or similar with time
- Only create triggers for EXPLICIT time-sensitive items, not vague statements`;

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
  private getTimezone: (userId: string) => string;
  /** Counter for throttling consolidateMemory — runs every N extractions */
  private extractionCount = 0;
  private static readonly CONSOLIDATION_INTERVAL = 5;

  constructor(options: LLMFactExtractorOptions) {
    // Wrap provider with cost tracking if available
    this.provider = options.costTracker
      ? options.costTracker.wrapProvider(options.provider, 'fact-extractor')
      : options.provider;
    this.scallopStore = options.scallopStore;
    this.logger = options.logger.child({ component: 'fact-extractor' });
    this.embedder = options.embedder;
    this.deduplicationThreshold = options.deduplicationThreshold ?? 0.95;
    this.getTimezone = options.getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

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
      // Build prompt with current date injected and optional context
      const now = new Date();
      const tz = this.getTimezone(userId);
      const tzOptions = { timeZone: tz };
      const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...tzOptions });
      const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOptions });
      let prompt = FACT_AND_TRIGGER_EXTRACTION_PROMPT.replace('{{CURRENT_DATE}}', currentDate).replace('{{CURRENT_TIME}}', currentTime) + '\n\n';
      if (context) {
        prompt += `Context from previous messages:\n${context}\n\n`;
      }
      prompt += `User message:\n${message}\n\nExtract facts and triggers (JSON only):`;

      // Call LLM to extract facts and triggers
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
        // Still process triggers even when no facts found
        if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
          this.processExtractedTriggers(parsed.proactive_triggers, userId);
        }
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

      // Process triggers from combined extraction (fire-and-forget)
      if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
        this.processExtractedTriggers(parsed.proactive_triggers, userId);
      }

      // Process facts with batch classification for efficiency
      const processResults = await this.processFactsBatch(result.facts, userId, message, sourceMessageId);
      result.factsStored = processResults.stored;
      result.factsUpdated = processResults.updated;
      result.factsDeleted = processResults.deleted;
      result.duplicatesSkipped = processResults.duplicates;

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
   * Extract proactive triggers from a message (assistant messages only).
   * User message triggers are now extracted via the combined fact+trigger prompt in extractFacts().
   * This method is kept for assistant message extraction (called from agent.ts).
   */
  async extractTriggersFromMessage(
    message: string,
    userId: string,
    source: 'user' | 'assistant' = 'user'
  ): Promise<void> {
    if (!this.scallopStore) return;

    const now = new Date();
    const tz = this.getTimezone(userId);
    const tzOptions = { timeZone: tz };
    const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...tzOptions });
    const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOptions });

    const prompt = `You are a proactive trigger extractor. Analyze this message for time-sensitive items that warrant follow-up.

CURRENT DATE: ${currentDate}
CURRENT TIME: ${currentTime}

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
  "context": "Context for generating the proactive message",
  "guidance": "Specific instructions for the bot on what to do to help the user when the trigger fires (e.g., 'Search for directions and check weather', 'Look up flight status'). null if none.",
  "recurring": "null if one-time, OR an object: { \"type\": \"daily\" | \"weekly\" | \"weekdays\" | \"weekends\", \"hour\": 0-23, \"minute\": 0-59, \"dayOfWeek\": 0-6 (Sunday=0, only for weekly) }"
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
- If recurring, set the recurring object with the correct type, hour, and minute. Do NOT leave it null for repeating events.
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
          guidance?: string | null;
          recurring?: RecurringSchedule | null;
        }>;
      };

      if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
        this.processExtractedTriggers(parsed.proactive_triggers, userId);
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

    // Step 2: Single merged search per fact (dedup + classification in one pass)
    // Run all searches in parallel since SQLite WAL mode supports concurrent reads
    const searchResults = await Promise.all(
      facts_to_process.map(fact =>
        this.scallopStore.search(fact.content, {
          userId,
          limit: 10,
          minProminence: 0.1,
          queryEmbedding: fact.embedding,
        })
      )
    );

    // Step 3: Dedup check against search results
    const factsToClassify: ExtractedFactWithEmbedding[] = [];
    const factSearchResults: Map<ExtractedFactWithEmbedding, typeof searchResults[0]> = new Map();
    // Collect all candidate memory IDs from searches for consolidation
    const allCandidateMemoryIds = new Set<string>();

    for (let i = 0; i < facts_to_process.length; i++) {
      const fact = facts_to_process[i];
      const scallopResults = searchResults[i];

      // Track candidate IDs for consolidation
      for (const r of scallopResults) {
        allCandidateMemoryIds.add(r.memory.id);
      }

      // Check for exact duplicates using embeddings
      let isDuplicate = false;
      if (fact.embedding && scallopResults.length > 0) {
        for (const r of scallopResults) {
          if (r.memory.embedding) {
            const similarity = cosineSimilarity(fact.embedding, r.memory.embedding);
            if (similarity >= this.deduplicationThreshold) {
              isDuplicate = true;
              // Reinforce the existing memory: bump confidence, prominence, times_confirmed
              const db = this.scallopStore.getDatabase();
              db.reinforceMemory(r.memory.id);
              this.logger.debug(
                { memoryId: r.memory.id, content: fact.content },
                'Duplicate fact reinforced existing memory'
              );
              break;
            }
          }
        }
      }

      if (isDuplicate) {
        result.duplicates++;
      } else {
        factsToClassify.push(fact);
        factSearchResults.set(fact, scallopResults);
      }
    }

    // Collect stored memory IDs for batch consolidation at the end
    const storedMemories: { id: string; content: string }[] = [];

    // Helper to store and collect memory IDs
    const storeAndCollect = async (fact: ExtractedFactWithEmbedding, src?: string, srcId?: string) => {
      const mem = await this.storeNewFact(fact, userId, src, srcId);
      if (mem) storedMemories.push(mem);
    };

    // Step 4: Batch classification with single LLM call
    // Build relevant facts from pre-fetched search results (no re-searching)
    if (this.relationshipClassifier && factsToClassify.length > 0) {
      const relevantFactIds = new Set<string>();
      const relevantFacts: { id: string; content: string; subject: string; category: string }[] = [];

      for (const fact of factsToClassify) {
        const similar = factSearchResults.get(fact) ?? [];
        for (const r of similar) {
          if (!relevantFactIds.has(r.memory.id)) {
            relevantFactIds.add(r.memory.id);
            relevantFacts.push({
              id: r.memory.id,
              content: r.memory.content,
              subject: (r.memory.metadata?.subject as string) || 'user',
              category: (r.memory.metadata?.originalCategory as string) || r.memory.category || 'general',
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

          // Step 5: Apply classifications and store
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

    // Immediate agent profile update: when user configures the bot, don't wait for consolidation
    const agentFacts = facts.filter(f => f.subject === 'agent');
    if (agentFacts.length > 0) {
      this.applyAgentProfileImmediately(agentFacts);
    }

    // Throttled fire-and-forget: run consolidation every N extractions to save LLM calls
    if (storedMemories.length > 0) {
      this.extractionCount++;
      if (this.extractionCount >= LLMFactExtractor.CONSOLIDATION_INTERVAL) {
        this.extractionCount = 0;
        // Wrap with a 30s timeout to prevent zombie processes if LLM hangs
        const consolidationPromise = this.consolidateMemory(
          storedMemories.map(m => m.id),
          userId,
          storedMemories.map(m => m.content),
          sourceMessage,
          Array.from(allCandidateMemoryIds),
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Consolidation timed out after 30s')), 30_000)
        );
        Promise.race([consolidationPromise, timeoutPromise]).catch(err => {
          this.logger.warn({ error: (err as Error).message }, 'Background consolidation failed');
        });
      }
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
    sourceMessageId?: string,
    learnedFrom: string = 'conversation'
  ): Promise<{ id: string; content: string } | null> {
    // Reject facts that are too long (real facts are concise)
    if (fact.content.length > 200) {
      this.logger.debug({ contentLength: fact.content.length }, 'Fact too long, skipping');
      return null;
    }

    // Reject facts that are too short (single words, greetings)
    const lower = fact.content.toLowerCase().trim();
    if (lower.length < 5) {
      this.logger.debug({ content: fact.content }, 'Fact too short, skipping');
      return null;
    }

    // Reject facts that look like questions, greetings, or commands
    if (/^(what|how|where|when|why|who|do |can |does |is |are |hey|hi |hello|good morning|good evening|thanks|thank you|show me|check out|find |search |build |analyze |gather |identify )/i.test(lower) && lower.length < 100) {
      this.logger.debug({ content: fact.content }, 'Fact looks like question/greeting/command, skipping');
      return null;
    }

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
      sourceChunk: sourceMessage ? sourceMessage.substring(0, 500) : undefined,
      metadata: provenance,
      learnedFrom,
      detectRelations: false,
      embedding: fact.embedding,
    });

    return { id: newMemory.id, content: searchableContent };
  }

  /**
   * Immediately apply agent-subject facts to the agent profile (don't wait for consolidation).
   * Handles facts like "Name is Charlie", "Personality is witty and sarcastic".
   */
  private applyAgentProfileImmediately(agentFacts: ExtractedFactWithEmbedding[]): void {
    const profileManager = this.scallopStore.getProfileManager();

    for (const fact of agentFacts) {
      const lower = fact.content.toLowerCase();

      // Extract name: "Name is X" or "Name: X"
      const nameMatch = lower.match(/^name\s+(?:is\s+)?(.+)/i);
      if (nameMatch) {
        const name = fact.content.slice(fact.content.length - nameMatch[1].length).trim();
        profileManager.setStaticValue('agent', 'name', name);
        this.logger.info({ name }, 'Agent name set immediately');
      }

      // Extract personality: "Personality is X" or "Personality: X"
      const personalityMatch = lower.match(/^personality\s+(?:is\s+)?(.+)/i);
      if (personalityMatch) {
        const personality = fact.content.slice(fact.content.length - personalityMatch[1].length).trim();
        profileManager.setStaticValue('agent', 'personality', personality);
        this.logger.info({ personality }, 'Agent personality set immediately');
      }

      // Generic key-value: "X is Y" pattern for other agent fields
      if (!nameMatch && !personalityMatch) {
        const kvMatch = lower.match(/^(\w+)\s+is\s+(.+)/i);
        if (kvMatch) {
          const key = kvMatch[1].trim();
          const value = fact.content.slice(fact.content.indexOf(kvMatch[2])).trim();
          if (key && value && !['it', 'he', 'she', 'this', 'that', 'there'].includes(key)) {
            profileManager.setStaticValue('agent', key, value);
            this.logger.info({ key, value }, 'Agent profile field set immediately');
          }
        }
      }
    }
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
    // Build search queries — search for both old value and the category to cast a wider net
    const searchQuery = correction.oldValue || correction.replaces || correction.content;

    // Search with multiple queries to find all related facts that should be superseded
    const candidateSets = await Promise.all([
      this.scallopStore.search(searchQuery, { userId, limit: 5, minProminence: 0.1 }),
      // Also search by category keywords (e.g., for "Works at Google" → search "works at")
      correction.category ? this.scallopStore.search(correction.category, { userId, limit: 5, minProminence: 0.1 }) : Promise.resolve([]),
    ]);

    // Deduplicate candidates
    const seenIds = new Set<string>();
    const candidates = [];
    for (const set of candidateSets) {
      for (const c of set) {
        if (!seenIds.has(c.memory.id)) {
          seenIds.add(c.memory.id);
          candidates.push(c);
        }
      }
    }

    // Store the correction as new fact with high confidence first (to get the new ID)
    const newMemory = await this.storeNewFact(
      {
        ...correction,
        confidence: 0.95, // High confidence for explicit corrections
      },
      userId,
      sourceMessage,
      sourceMessageId,
      'correction'
    );

    // Supersede matching memories and set contradiction tracking
    let superseded = 0;
    const db = this.scallopStore.getDatabase();
    for (const candidate of candidates) {
      if (candidate.score > 0.4) {
        this.scallopStore.update(candidate.memory.id, { isLatest: false });
        // Bidirectional contradiction tracking
        if (newMemory) {
          db.addContradiction(candidate.memory.id, newMemory.id);
          db.addContradiction(newMemory.id, candidate.memory.id);
        }
        superseded++;
        this.logger.info(
          { oldId: candidate.memory.id, oldContent: candidate.memory.content, newContent: correction.content },
          'Memory superseded by correction'
        );
      }
    }

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
    /** Pre-fetched candidate memory IDs from the merged search pass */
    candidateMemoryIds?: string[],
  ): Promise<void> {
    if (!this.scallopStore) return;

    const profileManager = this.scallopStore.getProfileManager();
    const newIdSet = new Set(newMemoryIds);
    const db = this.scallopStore.getDatabase();

    // Use pre-fetched candidates if available, otherwise fall back to searching
    const allCandidates = new Map<string, { id: string; content: string }>();
    if (candidateMemoryIds && candidateMemoryIds.length > 0) {
      for (const id of candidateMemoryIds) {
        if (newIdSet.has(id)) continue;
        const mem = db.getMemory(id);
        if (mem && mem.isLatest) {
          allCandidates.set(id, { id, content: mem.content });
        }
      }
    } else {
      // Fallback: search for similar existing memories
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

    const prompt = `You are a memory manager. Given new facts extracted from a user message, do FOUR things.

1. CONSOLIDATE: Which existing memories are superseded (replaced/updated) by the new facts?
2. USER PROFILE: Update user profile based on the new facts AND the original message.
3. AGENT PROFILE: If the user is telling the AI about itself (name, personality, behavior), update the agent profile.
4. PREFERENCES LEARNED: Extract preference patterns from the message (especially from corrections or comparisons).
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

RULES:
- superseded: IDs of memories replaced by new facts. Empty array if none.
- user_profile: Only fields that CHANGED or are NEW based on the message. Empty object if no updates.
- agent_profile: Only if user is addressing the bot about its identity. Empty object if not.
- preferences_learned: Array of preference objects. Empty array if no clear preferences.
- Do NOT echo back unchanged profile values.

Respond with JSON only:
{"superseded": [], "user_profile": {}, "agent_profile": {}, "preferences_learned": []}`;

    try {
      const response = await this.provider.complete({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 400,
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

      // 2. Update user profile (with validation)
      if (parsed.user_profile && typeof parsed.user_profile === 'object') {
        // Only allow known profile fields
        const allowedFields = new Set(['name', 'location', 'timezone', 'language', 'occupation', 'personality', 'mood', 'focus']);
        for (const [key, value] of Object.entries(parsed.user_profile)) {
          if (typeof value !== 'string' || !value.trim()) continue;
          if (!allowedFields.has(key)) continue;
          const trimmed = value.trim();

          // Validate timezone is a real IANA timezone
          if (key === 'timezone') {
            const { ProfileManager: PM } = await import('./profiles.js');
            if (!PM.isValidTimezone(trimmed)) {
              this.logger.debug({ timezone: trimmed }, 'Invalid timezone from LLM, skipping');
              continue;
            }
          }

          // Truncate focus to max 5 items to prevent bloat
          if (key === 'focus') {
            const items = trimmed.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
            profileManager.setStaticValue('default', key, items.join(', '));
            this.logger.info({ key, value: items.join(', ') }, 'User profile updated via LLM');
            continue;
          }

          // Reject mood values that describe bot behavior rather than user state
          if (key === 'mood' && /\b(assist|help|check|remind|offer|execute|search)\b/i.test(trimmed)) {
            this.logger.debug({ mood: trimmed }, 'Mood describes bot behavior, skipping');
            continue;
          }

          profileManager.setStaticValue('default', key, trimmed);
          this.logger.info({ key, value: trimmed }, 'User profile updated via LLM');
        }
      }

      // 3. Update agent profile (only accept known fields)
      if (parsed.agent_profile && typeof parsed.agent_profile === 'object') {
        const allowedAgentFields = new Set(['name', 'personality', 'tone', 'style', 'language']);
        for (const [key, value] of Object.entries(parsed.agent_profile)) {
          if (typeof value === 'string' && value.trim() && allowedAgentFields.has(key)) {
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
                extractedAt: new Date().toISOString(),
              },
              learnedFrom: 'inference',
            });
            this.logger.info(
              { prefers: pref.prefers, over: pref.over, domain: pref.domain },
              'Preference learned from user feedback'
            );
          }
        }
      }

    } catch (err) {
      this.logger.debug({ error: (err as Error).message }, 'Memory consolidation LLM call failed');
    }
  }

  /**
   * Process extracted triggers: store as scheduled items with guidance and recurring support.
   * Called from extractFacts() (user messages) and extractTriggersFromMessage() (assistant messages).
   */
  private processExtractedTriggers(
    triggers: Array<{
      type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
      description: string;
      trigger_time: string;
      context: string;
      guidance?: string | null;
      recurring?: RecurringSchedule | null;
      recurring_pattern?: string | null; // legacy fallback
    }>,
    userId: string,
    sourceMemoryId?: string | null,
  ): void {
    if (!this.scallopStore || triggers.length === 0) return;

    const db = this.scallopStore.getDatabase();
    for (const trigger of triggers) {
      if (!trigger.description || !trigger.trigger_time || !trigger.context) continue;

      const triggerAt = this.parseTriggerTime(trigger.trigger_time);
      if (!triggerAt) {
        this.logger.debug({ trigger_time: trigger.trigger_time }, 'Invalid trigger time, skipping');
        continue;
      }

      if (db.hasSimilarPendingScheduledItem(userId, trigger.description)) {
        this.logger.debug({ description: trigger.description }, 'Similar scheduled item already exists, skipping');
        continue;
      }

      // Build context: store guidance as structured JSON alongside original context
      let storedContext: string;
      if (trigger.guidance) {
        storedContext = JSON.stringify({
          original_context: trigger.context,
          guidance: trigger.guidance,
        });
      } else {
        storedContext = trigger.context;
      }

      // Use recurring schedule directly from LLM structured output
      // Validate it has required fields; fall back to null if malformed
      let recurring: RecurringSchedule | null = null;
      if (trigger.recurring && typeof trigger.recurring === 'object' && trigger.recurring.type && typeof trigger.recurring.hour === 'number') {
        recurring = trigger.recurring;
      }

      db.addScheduledItem({
        userId,
        sessionId: null,
        source: 'agent',
        type: trigger.type || 'follow_up',
        message: trigger.description,
        context: storedContext,
        triggerAt,
        recurring,
        sourceMemoryId: sourceMemoryId ?? null,
      });
      this.logger.info(
        {
          type: trigger.type,
          description: trigger.description,
          triggerAt: new Date(triggerAt).toISOString(),
          hasGuidance: !!trigger.guidance,
          recurring: recurring?.type ?? null,
        },
        'Scheduled item created from extraction'
      );
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
   * Parse LLM response, handling potential JSON issues.
   * Distinguishes between empty responses (normal) and parse failures (warnings).
   */
  private parseResponse(content: string): {
    facts: ExtractedFactWithEmbedding[];
    proactive_triggers?: Array<{
      type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
      description: string;
      trigger_time: string;
      context: string;
      guidance?: string | null;
      recurring?: RecurringSchedule | null;
      recurring_pattern?: string | null; // legacy fallback
    }>;
  } {
    if (!content || content.trim().length === 0) {
      this.logger.warn('LLM returned empty response during fact extraction');
      return { facts: [] };
    }

    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(
        { contentPreview: content.substring(0, 200) },
        'LLM response contained no JSON object — facts may have been lost'
      );
      return { facts: [] };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message, contentPreview: content.substring(0, 200) },
        'Failed to parse JSON from LLM response — facts were lost'
      );
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
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  let prompt = FACT_AND_TRIGGER_EXTRACTION_PROMPT.replace('{{CURRENT_DATE}}', currentDate).replace('{{CURRENT_TIME}}', currentTime) + '\n\n';
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
