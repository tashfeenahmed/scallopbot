/**
 * LLM-based Fact Extractor
 *
 * Extracts facts from user messages using an LLM, with semantic deduplication
 * to avoid storing redundant information. Runs asynchronously to not block
 * the main conversation flow.
 */

import type { Logger } from 'pino';
import type { CompletionRequest, LLMProvider } from '../providers/types.js';
import type { CostTracker } from '../routing/cost.js';
import { resolveStateUserId } from '../utils/state-user-id.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';
import type { ScallopMemoryStore } from './scallop-store.js';
import type { MemoryCategory, RecurringSchedule } from './db.js';
import {
  type RelationshipClassifier,
  createRelationshipClassifier,
  type ExistingFact,
} from './relation-classifier.js';
import { sanitizeProactiveMessage } from '../proactive/message-safety.js';
import { assessProactiveMessage } from '../proactive/message-quality.js';
import { TemporalExtractor } from './temporal.js';

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
  /** Deterministically inferred occurrence time; never supplied by the LLM. */
  eventDate?: number | null;
  /** User-local occurrence day used to keep repeated episodes distinct. */
  eventDay?: string | null;
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

interface FactSlot {
  slot: string;
  value: string;
}

function normalizeFactPart(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract only high-confidence single-valued attributes. Unknown shapes are
 * deliberately left unclassified: two semantically related facts may both be
 * true and must not be superseded merely because an LLM found them similar.
 */
function extractFactSlot(content: string): FactSlot | null {
  const text = normalizeFactPart(content);
  const locationOrWork = text.match(/^(lives?|works?)\s+(in|at|for|as)\s+(.+)$/u);
  if (locationOrWork) {
    return { slot: `${locationOrWork[1].replace(/s$/, '')}:${locationOrWork[2]}`, value: locationOrWork[3] };
  }

  const namedAttribute = text.match(
    /^(?:(?:the|user s|users)\s+)?(name|age|location|city|country|timezone|language|employer|job|role|office|mood|focus|wife|husband|partner|flatmate|manager|boss)\s+(?:is|are)\s+(.+)$/u,
  );
  if (namedAttribute) return { slot: namedAttribute[1], value: namedAttribute[2] };

  const quantified = text.match(/^has\s+(\d+)\s+(.+)$/u);
  if (quantified) return { slot: `has:${quantified[2]}`, value: quantified[1] };
  return null;
}

/** True only when both facts occupy a known single-valued slot with different values. */
export function factsClearlyContradict(newFact: string, existingFact: string): boolean {
  const next = extractFactSlot(newFact);
  const previous = extractFactSlot(existingFact);
  return !!next && !!previous && next.slot === previous.slot && next.value !== previous.value;
}

/**
 * An LLM-provided old value is only a locator, never sufficient authority to
 * supersede a fact by substring. Both facts must occupy the same known,
 * single-valued slot and the old value must identify that slot's prior value.
 */
export function explicitCorrectionTargetsSameSlot(
  newFact: string,
  existingFact: string,
  oldValue: string,
): boolean {
  const next = extractFactSlot(newFact);
  const previous = extractFactSlot(existingFact);
  const normalizedOld = normalizeFactPart(oldValue);
  if (!next || !previous || next.slot !== previous.slot || normalizedOld.length < 2) return false;
  if (next.value === previous.value) return false;
  return previous.value === normalizedOld
    || previous.value.startsWith(`${normalizedOld} `)
    || previous.value.endsWith(` ${normalizedOld}`)
    || previous.value.includes(` ${normalizedOld} `);
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
  /** Explicit aliases for this deployment's single canonical state owner. */
  canonicalSingleUserIds?: readonly string[];
  /** Total wall-clock budget for each strict JSON provider call (default: 10s). */
  requestTimeoutMs?: number;
  /** Injectable clock for deterministic durable circuit tests. */
  now?: () => number;
}

interface StructuredRouteCircuitStore {
  getStructuredRouteCircuit(route: string): { nextRetryAt: number } | null;
  recordStructuredRouteFailure(route: string, errorCode: string, now?: number): unknown;
  clearStructuredRouteCircuit(route: string): void;
}

const nullableStringSchema = { type: ['string', 'null'] } as const;

export const FACT_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'proactive_triggers'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'subject', 'category', 'confidence', 'action', 'old_value', 'replaces'],
        properties: {
          content: { type: 'string' },
          subject: { type: 'string' },
          category: { type: 'string', enum: ['personal', 'work', 'location', 'preference', 'relationship', 'project', 'general'] },
          confidence: { type: 'number' },
          action: { type: 'string', enum: ['fact', 'forget', 'correction', 'preference_update'] },
          old_value: nullableStringSchema,
          replaces: nullableStringSchema,
        },
      },
    },
    proactive_triggers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'kind', 'consent', 'description', 'trigger_time', 'context', 'guidance', 'goal', 'tools', 'recurring'],
        properties: {
          type: { type: 'string', enum: ['event_prep', 'commitment_check', 'goal_checkin', 'follow_up'] },
          kind: { type: 'string', enum: ['nudge', 'task'] },
          consent: { type: 'string', enum: ['explicit', 'inferred'] },
          description: { type: 'string' },
          trigger_time: { type: 'string' },
          context: { type: 'string' },
          guidance: nullableStringSchema,
          goal: nullableStringSchema,
          tools: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
          recurring: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'hour', 'minute', 'dayOfWeek', 'dayOfMonth'],
                properties: {
                  type: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'weekdays', 'weekends'] },
                  hour: { type: 'integer' },
                  minute: { type: 'integer' },
                  dayOfWeek: { type: ['integer', 'null'] },
                  dayOfMonth: { type: ['integer', 'null'] },
                },
              },
            ],
          },
        },
      },
    },
  },
};

export const FACT_ONLY_SCHEMA: Record<string, unknown> = {
  ...FACT_EXTRACTION_SCHEMA,
  required: ['facts'],
  properties: { facts: (FACT_EXTRACTION_SCHEMA.properties as Record<string, unknown>).facts },
};

export const MEMORY_CONSOLIDATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['superseded', 'user_profile', 'agent_profile', 'preferences_learned', 'recent_topics'],
  properties: {
    superseded: { type: 'array', items: { type: 'string' } },
    user_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'location', 'timezone', 'language', 'occupation', 'personality', 'mood', 'focus'],
      properties: Object.fromEntries(
        ['name', 'location', 'timezone', 'language', 'occupation', 'personality', 'mood', 'focus']
          .map(key => [key, nullableStringSchema]),
      ),
    },
    agent_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'personality', 'tone', 'style', 'language'],
      properties: Object.fromEntries(
        ['name', 'personality', 'tone', 'style', 'language']
          .map(key => [key, nullableStringSchema]),
      ),
    },
    preferences_learned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['domain', 'prefers', 'over', 'strength'],
        properties: {
          domain: { type: 'string' }, prefers: { type: 'string' }, over: { type: 'string' }, strength: { type: 'number' },
        },
      },
    },
    recent_topics: { type: 'array', items: { type: 'string' } },
  },
};

async function completeWithinDeadline(
  provider: LLMProvider,
  request: CompletionRequest,
  timeoutMs: number,
  timeoutCode: string,
): Promise<Awaited<ReturnType<LLMProvider['complete']>>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.complete({ ...request, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error(timeoutCode));
          reject(new Error(timeoutCode));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * The prompt used to extract facts from messages
 */
// Exported for fine-tune dataset construction (scripts/ft/) — the builder
// re-renders historical prompts with the exact production template.
export const FACT_AND_TRIGGER_EXTRACTION_PROMPT = `You are a fact extraction system. Extract factual information, detect memory actions, AND identify proactive triggers from the user's message.

CURRENT DATE: {{CURRENT_DATE}}
CURRENT TIME: {{CURRENT_TIME}}

ACTION TYPES:
- "fact" (default): Store as new knowledge
- "forget": User wants to REMOVE stored information (forget, delete, remove, don't remember)
- "correction": User is CORRECTING previous information (actually, no I meant, that's wrong)
- "preference_update": User is explicitly stating a preference comparison (prefer X over Y)

Rules:
1. Extract CONCRETE facts — NOT questions, greetings, opinions, or conversational filler
2. NEVER extract: "hey how are you", "what do you know", "what time is it", "good morning", casual chat, rhetorical questions, or messages that contain no factual information about the user
3. NEVER extract TRANSIENT TASK REQUESTS as facts. These are one-off instructions, not durable information about the user:
   - BAD: "Wants TODO comments summarized", "Has a project they want help with", "Wants to know about Docker"
   - BAD: "Has a codebase", "Has a boss", "Will be late tomorrow" (trivially obvious or ephemeral)
   - GOOD: "Works on a TypeScript codebase called ScallopBot" (specific, durable)
   - Only extract facts that would still be relevant and useful to recall in a FUTURE conversation
4. A valid fact includes BOTH long-term info (name, job, location, family, preferences, projects, skills, relationships) AND short-term plans/activities the user states for today (e.g., "going to the gym", "working from home", "having lunch with Sarah"). Today's plans ARE valid facts — they form the user's agenda and should be remembered within the current day.
4. For each fact, identify WHO it's about:
   - "user" if it's about the person speaking (their name, job, preferences, relationships, location)
   - "agent" if the user is telling the AI assistant about itself (giving it a name, personality, behavior instructions)
   - The person's name if it's SPECIFICALLY about someone else's attributes (their job, hobbies, etc.)
3. Categorize each fact: personal, work, location, preference, relationship, project, general
4. Be concise - extract the core fact without filler words
5. If a message references something from context (like "that's my office"), use the context to form a complete fact
6. DETECT ACTIONS: Look for forget requests, corrections, and preference updates

CRITICAL - Never extract meta-analysis about the assistant's own behavior:
Do NOT create "facts" that describe how the assistant should behave, what patterns
work well in conversation, or observations about the user's communication style.
These are not facts the user stated — they're self-reflection that pollutes memory.
- BAD: "User responds well to binary confirmation prompts" (meta-analysis)
- BAD: "Progressive task disclosure keeps focus managed" (assistant coaching itself)
- BAD: "Greeting-only openings should propose 2-3 next actions" (prompt engineering)
- GOOD: "Prefers concise, direct answers" (a preference the user stated)
If an input looks like an assistant's internal reasoning about itself, extract nothing.

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
- "Forget that I work at Acme Corp" → { "action": "forget", "content": "Works at Acme Corp", "subject": "user", "category": "work" }
- "Delete my location data" → { "action": "forget", "content": "location", "subject": "user", "category": "location" }
- "Don't remember my wife's name" → { "action": "forget", "content": "Wife", "subject": "user", "category": "relationship" }

CRITICAL - Corrections:
When user corrects previous information (actually, no, that's wrong, I meant):
- "Actually I live in Metropolis now, not Springfield" → { "action": "correction", "content": "Lives in Metropolis", "old_value": "Springfield", "subject": "user", "category": "location" }
- "No, I said Python not JavaScript" → { "action": "correction", "content": "Prefers Python", "old_value": "JavaScript", "subject": "user", "category": "preference" }
- "That's wrong, my wife's name is Jamie not Sarah" → { "action": "correction", "content": "Wife is Jamie", "old_value": "Sarah", "subject": "user", "category": "relationship" }

CRITICAL - Preference updates:
When user explicitly compares preferences (prefer X over Y, like X better than Y):
- "I prefer dark mode over light mode" → { "action": "preference_update", "content": "Prefers dark mode", "replaces": "light mode", "subject": "user", "category": "preference" }
- "I like Python better than JavaScript for scripting" → { "action": "preference_update", "content": "Prefers Python for scripting", "replaces": "JavaScript", "subject": "user", "category": "preference" }

Regular fact examples (action defaults to "fact"):
- "I work at Acme Corp" → { "content": "Works at Acme Corp", "subject": "user", "category": "work" }
- "My wife is Jamie" → { "content": "Wife is Jamie", "subject": "user", "category": "relationship" }
- "I live in Springfield" → { "content": "Lives in Springfield", "subject": "user", "category": "location" }

Daily plan/activity examples (ALWAYS extract these — they are the user's agenda):
- "I'm going to the gym" → { "content": "Going to the gym today", "subject": "user", "category": "general", "confidence": 0.9 }
- "Working from home today" → { "content": "Working from home today", "subject": "user", "category": "work", "confidence": 0.9 }
- "I'm going to the gym. Then have to build the agent proto" → extract BOTH: gym activity AND the project task as separate facts

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
  "kind": "nudge" | "task",
  "consent": "explicit" | "inferred",
  "description": "Brief description of what to follow up on",
  "trigger_time": "MUST include specific time - use ISO datetime with time (e.g., '2026-02-07T09:00:00') OR relative ('+2h', '+1d 9am', 'tomorrow 10:00')",
  "context": "Context for generating the proactive message",
  "guidance": "Specific instructions for the bot on what to do to help the user when the trigger fires (e.g., 'Search for directions and check weather', 'Look up flight status')",
  "goal": "What the sub-agent should accomplish (required for task kind, e.g., 'Look up flight EK204 status and check for delays')",
  "tools": ["optional array of tool names for task kind, e.g., 'web_search', 'bash'"],
  "recurring": "null if one-time, OR an object: { \"type\": \"daily\" | \"weekly\" | \"monthly\" | \"weekdays\" | \"weekends\", \"hour\": 0-23, \"minute\": 0-59, \"dayOfWeek\": 0-6 (Sunday=0, only for weekly), \"dayOfMonth\": 1-31 (only for monthly) }"
}

KIND RULES:
- "nudge": A pre-written message delivered directly to the user (default). Use for reminders, check-ins, and simple follow-ups where the description IS the message sent to the user.
- "task": Background work by a sub-agent before messaging the user. Use when the bot needs to DO something (search, look up, check, compute) before responding.
- When kind is "task", the "goal" field describes what the sub-agent should do, and "description" is the fallback message if the task fails
- Default to "nudge" unless the trigger clearly requires the bot to perform research or actions

CONSENT RULES:
- "explicit": the user directly asked to be reminded, notified, checked in on, or asked for the recurring/task action.
- "inferred": the user mentioned an event, commitment, deadline, or goal but did not ask for outreach.
- Create a recurring trigger only when the user explicitly asks for repeating
  outreach; label that trigger "explicit". A recurring routine or plan by
  itself never grants consent for recurring messages.

NUDGE TONE — CRITICAL:
The description is a delivery-time intent and safe fallback. Write it as a natural, respectful AI assistant — warm without pretending to be a friend or having human feelings.
- Use natural, conversational language with one concrete focus.
- The description must be the exact user-facing text. Do NOT write instructions like "ask the user...", "send a message...", or "check in with the user...".
- BAD: "Eir fibre appointment tomorrow between 10am and 5pm"
- GOOD: "Your Eir fibre appointment is tomorrow between 10 and 5."
- BAD: "Ask the user how the agent mode proto is going"
- GOOD: "Did the agent mode prototype review go ahead?"
- BAD: "Check progress on agent mode proto for Dan"
- GOOD: "The agent mode prototype for Dan was due today. Is it still on track?"
- BAD: "Dentist appointment at 2pm"
- GOOD: "Your dentist appointment is at 2 today."
- Never default to "Hey", "just checking in", "wanted to check in", or "hope you're well".
- Do not mention reduced activity, shorter replies, or that the user has been quiet.
- Do not use guilt, pressure, faux intimacy, diagnosis, or more than one question.
- Keep it brief and specific. No emojis, bullet points, or structured formatting.

PROACTIVE RESTRAINT — CRITICAL:
- Silence is correct when there is no concrete reason to interrupt at that time.
- Do not create a trigger merely because a conversation ended, the user mentioned a vague goal, or a casual plan might be interesting to ask about.
- A trigger needs a specific event/commitment/deadline, a useful delivery time, and a clear benefit to the user.
- Do not create generic morning/evening recaps or "how was your day" check-ins unless the user explicitly requested that recurring check-in.
- Recurring triggers require explicit recurrence language from the user.

RECURRING RULES:
- If the user says "daily", "every day", "every morning", "every evening", etc. → set recurring with type "daily"
- If the user says "every weekday", "monday to friday" → type "weekdays"
- If the user says "every weekend" → type "weekends"
- If the user says "every Monday", "every Tuesday", etc. → type "weekly" with the correct dayOfWeek
- If the user says "monthly", "every month", or "on the Nth each month" → type "monthly" with the correct dayOfMonth
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
    { "type": "event_prep|commitment_check|goal_checkin|follow_up", "kind": "nudge|task", "consent": "explicit|inferred", "description": "text", "trigger_time": "ISO or relative", "context": "text", "guidance": "text or null", "goal": "text or null (required for task)", "tools": ["optional tool names"], "recurring": "null or {type, hour, minute, dayOfWeek?}" }
  ]
}

Notes:
- "action" defaults to "fact" if not specified
- "old_value" only for corrections
- "replaces" only for preference_update
- Set confidence based on how certain the extraction is (0.9+ for explicit statements, 0.6-0.8 for inferred facts)
- If no facts can be extracted, return EMPTY facts array — this is the CORRECT response for greetings, questions, small talk, and messages with no factual content
- If nothing time-sensitive found, return empty proactive_triggers array
- NEVER store greetings or filler ("hey", "hi", "thanks", "good morning")
- ALWAYS extract stated plans/activities for today — these are the user's agenda (gym, errands, meetings, tasks)
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
  private canonicalSingleUserIds: readonly string[];
  private requestTimeoutMs: number;
  private now: () => number;
  /** Counter for throttling consolidateMemory — runs every N extractions */
  private extractionCount = 0;
  private static readonly CONSOLIDATION_INTERVAL = 5;

  private localDay(epochMs: number, userId: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.getTimezone(userId),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(epochMs));
      const value = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find(part => part.type === type)?.value ?? '';
      return `${value('year')}-${value('month')}-${value('day')}`;
    } catch {
      return new Date(epochMs).toISOString().slice(0, 10);
    }
  }

  private inferFactOccurrence(fact: ExtractedFactWithEmbedding, userId: string): void {
    const now = this.now();
    const extracted = new TemporalExtractor().extract(fact.content, now).eventDate;
    const episodic = /\b(?:completed|did|performed|logged|attended|visited|went|ran|walked|cycled|worked\s+out|trained|slept|ate|drank|took)\b/i.test(fact.content)
      || /\b\d+\s*(?:kg|kgs|lb|lbs|minutes?|mins?|reps?|sets?)\b/i.test(fact.content);
    const eventDate = extracted ?? (episodic ? now : null);
    fact.eventDate = eventDate;
    fact.eventDay = eventDate == null ? null : this.localDay(eventDate, userId);
  }

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
    this.canonicalSingleUserIds = [...(options.canonicalSingleUserIds ?? [])];
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
    this.now = options.now ?? Date.now;

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
    sourceMessageId?: string,
    /** Conversation that originated any extracted proactive intent. */
    sourceSessionId?: string,
  ): Promise<FactExtractionResult> {
    const channelUserId = userId;
    userId = resolveStateUserId(userId, this.canonicalSingleUserIds);
    const result: FactExtractionResult = {
      facts: [],
      factsStored: 0,
      factsUpdated: 0,
      factsDeleted: 0,
      duplicatesSkipped: 0,
    };

    const route = this.structuredRoute('fact_extract');
    if (this.structuredRouteIsBackedOff(route)) {
      result.error = 'fact_extraction_provider_backoff';
      this.logger.debug({ route }, 'Fact extraction skipped during durable provider backoff');
      return result;
    }

    try {
      // Build prompt with current date injected and optional context
      const now = new Date();
      const tz = this.getTimezone(channelUserId);
      const tzOptions = { timeZone: tz };
      const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...tzOptions });
      const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOptions });
      let prompt = FACT_AND_TRIGGER_EXTRACTION_PROMPT.replace('{{CURRENT_DATE}}', currentDate).replace('{{CURRENT_TIME}}', currentTime) + '\n\n';
      prompt += `Authoritative user timezone: ${tz}. Treat clocks without an explicit timezone as local wall-clock times in ${tz}. Do not append Z or a UTC offset unless the user explicitly supplied that timezone.\n\n`;
      if (context) {
        prompt += `Context from previous messages:\n${context}\n\n`;
      }
      prompt += `User message:\n${message}\n\nExtract facts and triggers (JSON only):`;

      // Call LLM to extract facts and triggers. Cap max_tokens so thinking-heavy
      // models (qwen3.6) don't burn the entire budget on reasoning_content and
      // return empty JSON. 1500 is plenty for even a long facts+triggers payload.
      let response: Awaited<ReturnType<LLMProvider['complete']>>;
      try {
        response = await completeWithinDeadline(this.provider, {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          maxTokens: 1500,
          enableThinking: false,
          structuredOutput: {
            name: 'fact_and_trigger_extraction',
            schema: FACT_EXTRACTION_SCHEMA,
            strict: true,
          },
          purpose: 'fact_extract',
        }, this.requestTimeoutMs, 'fact_extraction_timeout');
      } catch (error) {
        this.recordStructuredRouteFailure(route, error);
        throw error;
      }

      // Parse response - handle ContentBlock[] response
      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);
      const parsed = this.parseResponse(responseText);
      if (!parsed || !Array.isArray(parsed.facts)) {
        const error = new Error('fact_extraction_invalid_json');
        this.recordStructuredRouteFailure(route, error);
        throw error;
      }
      this.clearStructuredRouteFailure(route);

      result.facts = parsed.facts.map((f: {
        content: string;
        subject: string;
        category?: string;
        confidence?: number;
        action?: string;
        old_value?: string | null;
        replaces?: string | null;
      }) => ({
        content: f.content,
        subject: f.subject || 'user',
        category: (f.category as FactCategory) || 'general',
        confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
        action: (f.action as FactAction) || 'fact',
        oldValue: f.old_value ?? undefined,
        replaces: f.replaces ?? undefined,
      }));

      // Post-extraction noise filter: remove low-value facts before storing
      const beforeFilter = result.facts.length;
      result.facts = result.facts.filter(f => {
        const lower = f.content.toLowerCase();

        // Filter out transient task requests (one-off instructions, not durable user info)
        if (/^(?:wants?|needs?|asked?|requesting?)\s+(?:to\s+)?(?:know|help|check|see|find|get|summarize|explain|look|search|run|debug|fix|test|review|create|build|write|read|list|show)\b/i.test(lower)) {
          return false;
        }

        // Filter out trivially vague "has a ..." statements
        if (/^has\s+(?:a|an|the|some)\s+(?:codebase|project|app|bot|tool|system|job|boss|team|meeting|computer|laptop|phone|problem|issue|question|idea|file|folder|repo|database|server)\b/i.test(lower)) {
          return false;
        }

        // Filter out ephemeral statements about current conversation activity
        if (/^(?:is\s+(?:asking|chatting|talking|testing|trying|working|looking|debugging|checking)\s+(?:about|with|on|at|for))\b/i.test(lower)) {
          return false;
        }

        // Filter out facts that are too short to be meaningful
        if (f.content.trim().length < 8) {
          return false;
        }

        // Filter out "will be late tomorrow"-style ephemeral statements
        if (/^(?:will\s+be\s+(?:late|early|busy|free|away|back|out))\b/i.test(lower)) {
          return false;
        }

        return true;
      });

      if (beforeFilter > result.facts.length) {
        this.logger.debug(
          { before: beforeFilter, after: result.facts.length },
          'Noise filter removed low-value facts'
        );
      }

      this.logger.debug(
        { factCount: result.facts.length, message: message.substring(0, 50) },
        'Facts extracted from message'
      );

      // Process triggers from combined extraction (fire-and-forget)
      if (parsed.proactive_triggers && Array.isArray(parsed.proactive_triggers) && parsed.proactive_triggers.length > 0) {
        this.processExtractedTriggers(
          parsed.proactive_triggers,
          userId,
          message,
          null,
          sourceSessionId,
          this.getTimezone(channelUserId),
        );
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
    sourceMessageId?: string,
    sourceSessionId?: string,
  ): Promise<FactExtractionResult> {
    const key = `${userId}-${Date.now()}`;

    const promise = this.extractFacts(message, userId, context, sourceMessageId, sourceSessionId);
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
    for (const fact of facts_to_process) this.inferFactOccurrence(fact, userId);

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
              const existingEventDay = r.memory.metadata?.eventDay as string | undefined
                ?? (r.memory.eventDate == null ? undefined : this.localDay(r.memory.eventDate, userId));
              // A repeated activity on a different local day is a distinct
              // episode. Do not reinforce the older row and erase the new date.
              if (fact.eventDay && fact.eventDay !== existingEventDay) continue;
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

          // Step 5: Apply classifications, store, and persist relation edges
          const db = this.scallopStore.getDatabase();
          for (let i = 0; i < factsToClassify.length; i++) {
            const fact = factsToClassify[i];
            const classification = classifications[i];

            if (classification.classification === 'UPDATES' && classification.targetId) {
              const target = relevantFacts.find(candidate => candidate.id === classification.targetId);
              const safeUpdate = classification.confidence >= 0.8
                && !!target
                && normalizeFactPart(target.subject) === normalizeFactPart(fact.subject)
                && target.category === fact.category
                && factsClearlyContradict(fact.content, target.content);
              if (safeUpdate) {
                // Mark old fact as superseded only after deterministic
                // same-slot contradiction verification.
                this.scallopStore.update(classification.targetId, { isLatest: false });
                await storeAndCollect(fact, sourceMessage, sourceMessageId);
                const newMem = storedMemories[storedMemories.length - 1];
                if (newMem) {
                  db.addRelation(newMem.id, classification.targetId, 'UPDATES', classification.confidence);
                }
                result.updated++;
                continue;
              }

              this.logger.warn(
                { targetId: classification.targetId, confidence: classification.confidence },
                'Rejected unverified memory supersession; storing both facts',
              );
              await storeAndCollect(fact, sourceMessage, sourceMessageId);
              result.stored++;
              continue;
            }

            if (classification.classification === 'EXTENDS' && classification.targetId) {
              // Store new fact and link it to the existing one
              await storeAndCollect(fact, sourceMessage, sourceMessageId);
              const newMem = storedMemories[storedMemories.length - 1];
              if (newMem) {
                db.addRelation(newMem.id, classification.targetId, 'EXTENDS', classification.confidence);
              }
              result.stored++;
              continue;
            }

            // Store as new fact (NEW)
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
        // Wrap with a 90s timeout to prevent zombie processes if LLM hangs.
        // Bumped from 30s because background fact-extractor now routes through the
        // 2nd provider (OpenRouter qwen3.6-plus) which can take 30-60s when thinking
        // tokens are heavy. 30s was tripping on legitimate slow responses.
        const consolidationPromise = this.consolidateMemory(
          storedMemories.map(m => m.id),
          userId,
          storedMemories.map(m => m.content),
          sourceMessage,
          Array.from(allCandidateMemoryIds),
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Consolidation timed out after 90s')), 90_000)
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
    if (fact.eventDay) provenance.eventDay = fact.eventDay;

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
      ...(fact.eventDate != null ? { eventDate: fact.eventDate } : {}),
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

    const db = this.scallopStore.getDatabase();
    let deleted = 0;
    for (const match of matches) {
      // Only delete if semantic similarity is high enough
      if (match.score > 0.5) {
        this.scallopStore.delete(match.memory.id);
        deleted++;

        // Cascade: cancel any scheduled items linked to this memory
        const cancelledById = db.cancelScheduledItemsBySourceMemory(match.memory.id);
        // Also cancel by text similarity (many items have null sourceMemoryId)
        const cancelledByText = db.cancelSimilarScheduledItems(userId, match.memory.content);
        // Cascade: clean stale profile entries derived from this memory
        const profilesCleaned = db.cleanStaleProfileEntries(userId, match.memory.content);
        this.logger.info(
          { id: match.memory.id, content: match.memory.content, score: match.score,
            cancelledScheduledItems: cancelledById + cancelledByText, profilesCleaned },
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
      const explicitOldValue = normalizeFactPart(correction.oldValue || correction.replaces || '');
      const matchesExplicitOldValue = explicitCorrectionTargetsSameSlot(
        correction.content,
        candidate.memory.content,
        explicitOldValue,
      );
      const verifiedContradiction = factsClearlyContradict(correction.content, candidate.memory.content);
      const candidateSubject = normalizeFactPart(
        typeof candidate.memory.metadata?.subject === 'string'
          ? candidate.memory.metadata.subject
          : 'user',
      );
      const sameSubject = candidateSubject === normalizeFactPart(correction.subject);
      const candidateCategory = typeof candidate.memory.metadata?.originalCategory === 'string'
        ? candidate.memory.metadata.originalCategory
        : candidate.memory.category;
      const sameCategory = candidateCategory === correction.category;
      if (candidate.score > 0.4 && sameSubject && sameCategory
        && (matchesExplicitOldValue || verifiedContradiction)) {
        this.scallopStore.update(candidate.memory.id, { isLatest: false });
        // Bidirectional contradiction tracking + relation edge
        if (newMemory) {
          db.addContradiction(candidate.memory.id, newMemory.id);
          db.addContradiction(newMemory.id, candidate.memory.id);
          db.addRelation(newMemory.id, candidate.memory.id, 'UPDATES', 0.95);
        }
        // Cascade: cancel scheduled items tied to the superseded memory
        db.cancelScheduledItemsBySourceMemory(candidate.memory.id);
        db.cancelSimilarScheduledItems(userId, candidate.memory.content);
        // Cascade: clean stale profile entries derived from superseded memory
        const profilesCleaned = db.cleanStaleProfileEntries(userId, candidate.memory.content);

        superseded++;
        this.logger.info(
          { oldId: candidate.memory.id, profilesCleaned },
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
    userId = resolveStateUserId(userId, this.canonicalSingleUserIds);

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
    const userProfile = profileManager.getStaticProfile(userId);
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

RECENT TOPICS:
- 1-3 SPECIFIC entities/concepts this message is about (noun phrases, lowercase, <=25 chars each).
- Prefer concrete named things over broad categories:
  GOOD: "notion", "leg press", "qatar flight", "tyre service", "calf raises", "parents travel"
  BAD:  "fitness", "work", "travel" (too broad)
  BAD:  "the user discussed their workout" (whole sentences)
- Empty array if the message has no distinctive topic (greetings, acks, yes/no).

RULES:
- superseded: IDs of memories replaced by new facts. Empty array if none.
- user_profile: Only fields that CHANGED or are NEW based on the message. Empty object if no updates.
- agent_profile: Only if user is addressing the bot about its identity. Empty object if not.
- preferences_learned: Array of preference objects. Empty array if no clear preferences.
- recent_topics: Array of 1-3 short topic strings (see above). Empty array if none.
- Do NOT echo back unchanged profile values.

Respond with JSON only:
{"superseded": [], "user_profile": {}, "agent_profile": {}, "preferences_learned": [], "recent_topics": []}`;

    const route = this.structuredRoute('memory_manage');
    if (this.structuredRouteIsBackedOff(route)) {
      this.logger.debug({ route }, 'Memory consolidation skipped during durable provider backoff');
      return;
    }

    let structuredResponseValid = false;
    try {
      const response = await completeWithinDeadline(this.provider, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 800,
        enableThinking: false,
        structuredOutput: {
          name: 'memory_consolidation',
          schema: MEMORY_CONSOLIDATION_SCHEMA,
          strict: true,
        },
        purpose: 'memory_manage',
      }, this.requestTimeoutMs, 'memory_consolidation_timeout');

      const responseText = Array.isArray(response.content)
        ? response.content.map(block => 'text' in block ? block.text : '').join('')
        : String(response.content);

      // Parse the JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('memory_consolidation_invalid_json');

      const parsed = JSON.parse(jsonMatch[0]) as {
        superseded?: string[];
        user_profile?: Record<string, string | null>;
        agent_profile?: Record<string, string | null>;
        preferences_learned?: Array<{
          domain?: string;
          prefers: string;
          over: string;
          strength?: number;
        }>;
        recent_topics?: string[];
      };
      if (!Array.isArray(parsed.superseded)
        || !parsed.user_profile || typeof parsed.user_profile !== 'object'
        || !parsed.agent_profile || typeof parsed.agent_profile !== 'object'
        || !Array.isArray(parsed.preferences_learned)
        || !Array.isArray(parsed.recent_topics)) {
        throw new Error('memory_consolidation_invalid_json');
      }
      structuredResponseValid = true;
      this.clearStructuredRouteFailure(route);

      // 1. Supersede outdated memories
      if (parsed.superseded && Array.isArray(parsed.superseded) && parsed.superseded.length > 0) {
        const validIds = new Set(candidates.map(c => c.id));
        const candidateMap = new Map(candidates.map(c => [c.id, c]));
        const db = this.scallopStore.getDatabase();
        for (const id of parsed.superseded) {
          if (validIds.has(id)) {
            const mem = candidateMap.get(id);
            const verified = !!mem && storedFacts.some(fact => factsClearlyContradict(fact, mem.content));
            if (!verified) {
              this.logger.warn({ supersededId: id }, 'Ignored unverified memory-manager supersession');
              continue;
            }
            this.scallopStore.update(id, { isLatest: false });
            // Cascade only after deterministic contradiction verification.
            db.cancelScheduledItemsBySourceMemory(id);
            db.cancelSimilarScheduledItems(userId, mem.content);
            db.cleanStaleProfileEntries(userId, mem.content);
            this.logger.info(
              { supersededId: id },
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

          // Focus stability: only update if the new value is meaningfully different
          // and not just a transient task topic from the current conversation
          if (key === 'focus') {
            // Cap each item to 25 chars so one long run-on doesn't dominate the field.
            const capItem = (s: string) => s.length > 25 ? s.slice(0, 22).trim() + '…' : s;
            const items = trimmed.split(',').map(s => s.trim()).filter(Boolean).map(capItem).slice(0, 5);
            const newFocus = items.join(', ');

            // Skip if new focus looks like a transient task request
            const transientPattern = /\b(?:summariz|debug|fix|test|review|help with|asked about|check|look at)\b/i;
            if (transientPattern.test(newFocus)) {
              this.logger.debug({ focus: newFocus }, 'Skipping transient focus update');
              continue;
            }

            // Supermemory-style aging: if existing focus hasn't been touched for
            // FOCUS_TTL_MS (14 days), treat it as stale and fully replace instead of
            // merging. Each successful update effectively reinforces the whole field
            // by refreshing user_profiles.updated_at.
            const FOCUS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
            const currentEntry = this.scallopStore.getDatabase().getProfileValue(userId, 'focus');
            const currentFocus = currentEntry?.value ?? null;
            const isStale = currentEntry ? (Date.now() - currentEntry.updatedAt > FOCUS_TTL_MS) : true;

            if (currentFocus && !isStale) {
              const currentSet = new Set(currentFocus.toLowerCase().split(',').map(s => s.trim()));
              const newSet = new Set(newFocus.toLowerCase().split(',').map(s => s.trim()));
              const genuinelyNew = [...newSet].filter(item => !currentSet.has(item));
              if (genuinelyNew.length === 0) {
                // Still touch updated_at to reinforce the existing focus as fresh
                profileManager.setStaticValue(userId, key, currentFocus);
                this.logger.debug({ focus: newFocus }, 'Focus unchanged, reinforced freshness');
                continue;
              }
              // Merge existing + new, re-cap per item, cap total to 5
              const merged = [...new Set([
                ...currentFocus.split(',').map(s => s.trim()).map(capItem),
                ...genuinelyNew.map(capItem),
              ])].filter(Boolean).slice(0, 5);
              profileManager.setStaticValue(userId, key, merged.join(', '));
              this.logger.info({ key, value: merged.join(', '), added: genuinelyNew }, 'User focus merged via LLM');
              continue;
            }

            // No existing focus OR stale focus → replace wholesale with the new value
            profileManager.setStaticValue(userId, key, newFocus);
            this.logger.info({ key, value: newFocus, replacedStale: isStale && !!currentFocus }, 'User focus set via LLM');
            continue;
          }

          // Reject mood values that describe bot behavior rather than user state
          if (key === 'mood' && /\b(assist|help|check|remind|offer|execute|search)\b/i.test(trimmed)) {
            this.logger.debug({ mood: trimmed }, 'Mood describes bot behavior, skipping');
            continue;
          }

          profileManager.setStaticValue(userId, key, trimmed);
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
            const supersededPrefIds: string[] = [];
            for (const existing of existingPrefs) {
              if (existing.score > 0.6 && existing.memory.category === 'preference') {
                this.scallopStore.update(existing.memory.id, { isLatest: false });
                supersededPrefIds.push(existing.memory.id);
                this.logger.debug(
                  { oldPref: existing.memory.content },
                  'Old preference superseded by learned preference'
                );
              }
            }

            // Store the new preference
            const newPref = await this.scallopStore.add({
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
            // Persist UPDATES relation edges for superseded preferences
            const prefDb = this.scallopStore.getDatabase();
            for (const oldId of supersededPrefIds) {
              prefDb.addRelation(newPref.id, oldId, 'UPDATES', 0.85);
            }
            this.logger.info(
              { prefers: pref.prefers, over: pref.over, domain: pref.domain },
              'Preference learned from user feedback'
            );
          }
        }
      }

      // 5. Update dynamic profile recent_topics (piggybacking on this LLM call
      // instead of making a separate one — topics come from the same prompt).
      if (parsed.recent_topics && Array.isArray(parsed.recent_topics) && parsed.recent_topics.length > 0) {
        for (const raw of parsed.recent_topics) {
          if (typeof raw !== 'string') continue;
          const topic = raw.trim().toLowerCase().slice(0, 25);
          if (!topic || topic.length < 2) continue;
          profileManager.addRecentTopic(userId, topic);
        }
      }

    } catch (err) {
      if (!structuredResponseValid) this.recordStructuredRouteFailure(route, err);
      this.logger.debug({ error: (err as Error).message }, 'Memory consolidation LLM call failed');
    }
  }

  /**
   * Process extracted triggers: store as scheduled items with guidance and recurring support.
   * Called from extractFacts() after the combined fact+trigger extraction.
   */
  private processExtractedTriggers(
    triggers: Array<{
      type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
      kind?: 'nudge' | 'task';
      consent?: 'explicit' | 'inferred';
      description: string;
      trigger_time: string;
      context: string;
      guidance?: string | null;
      goal?: string | null;
      tools?: string[] | null;
      recurring?: RecurringSchedule | null;
      recurring_pattern?: string | null; // legacy fallback
      priority?: 'urgent' | 'high' | 'medium' | 'low';
    }>,
    userId: string,
    sourceUserMessage: string,
    sourceMemoryId?: string | null,
    sourceSessionId?: string,
    sourceTimezone?: string,
  ): void {
    if (!this.scallopStore || triggers.length === 0) return;

    const db = this.scallopStore.getDatabase();

    // Limit one extraction burst, while leaving the actual interruption budget
    // to the delivery layer. Counting creation time was wrong for future
    // reminders (five events next week could exhaust today's budget).
    const MAX_TRIGGERS_PER_EXTRACTION = 3;
    let remainingBudget = MAX_TRIGGERS_PER_EXTRACTION;
    const messageHasExplicitRequest = this.hasExplicitProactiveRequest(sourceUserMessage);

    for (const trigger of triggers) {
      // A single direct request is deterministic. When one message yields
      // several different intents, also require the model's per-intent label
      // so "remind me about X; I also mentioned Y" does not privilege Y.
      const explicitConsent = messageHasExplicitRequest && (
        triggers.length === 1 || trigger.consent === 'explicit'
      );
      // Enforce daily budget per trigger
      if (remainingBudget <= 0) {
        this.logger.debug(
          { skipped: trigger.description },
          'Per-message trigger cap reached, skipping remaining triggers'
        );
        break;
      }

      if (!trigger.description || !trigger.trigger_time || !trigger.context) continue;

      // A task means unattended worker execution and therefore needs an actual
      // execution plan. A timed user-facing statement with no goal/guidance is
      // a nudge, even when a model labels the intent as event_prep.
      const hasExecutionPlan = !!trigger.goal?.trim()
        || !!trigger.guidance?.trim()
        || (Array.isArray(trigger.tools) && trigger.tools.length > 0);
      const kind = trigger.kind === 'task' && hasExecutionPlan
        ? 'task'
        : !trigger.kind && trigger.type === 'event_prep' && hasExecutionPlan
          ? 'task'
          : 'nudge';
      const message = sanitizeProactiveMessage(trigger.description);
      if (!message) {
        this.logger.warn(
          { description: trigger.description.slice(0, 120) },
          'Skipping unsafe proactive trigger description'
        );
        continue;
      }
      if (kind === 'nudge' && !assessProactiveMessage(message).acceptable) {
        this.logger.debug(
          { description: message.slice(0, 120) },
          'Skipping low-quality proactive nudge intent',
        );
        continue;
      }

      const timezone = sourceTimezone ?? this.getTimezone(userId);
      const triggerAt = this.correctMislabelledUtcWallClock(
        trigger.trigger_time,
        sourceUserMessage,
        timezone,
      ) ?? this.parseTriggerTime(trigger.trigger_time, timezone);
      if (!triggerAt) {
        this.logger.debug({ trigger_time: trigger.trigger_time }, 'Invalid trigger time, skipping');
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
      // Validate every wall-clock field; malformed model output must not create
      // an impossible or silently drifting recurrence.
      let recurring: RecurringSchedule | null = null;
      if (trigger.recurring && typeof trigger.recurring === 'object') {
        const candidate = trigger.recurring;
        const validType = ['daily', 'weekly', 'monthly', 'weekdays', 'weekends'].includes(candidate.type);
        const validHour = Number.isInteger(candidate.hour) && candidate.hour >= 0 && candidate.hour <= 23;
        const validMinute = Number.isInteger(candidate.minute) && candidate.minute >= 0 && candidate.minute <= 59;
        const validWeekday = candidate.type !== 'weekly'
          || (Number.isInteger(candidate.dayOfWeek) && candidate.dayOfWeek! >= 0 && candidate.dayOfWeek! <= 6);
        const validMonthday = candidate.type !== 'monthly'
          || (Number.isInteger(candidate.dayOfMonth) && candidate.dayOfMonth! >= 1 && candidate.dayOfMonth! <= 31);
        if (validType && validHour && validMinute && validWeekday && validMonthday) recurring = candidate;
      }

      // Repeating interruptions always require explicit user consent. Fail
      // closed if a model invents a recurrence from a routine statement such
      // as "I take medication every morning" without a reminder request.
      if (recurring && !explicitConsent) {
        this.logger.warn(
          { type: trigger.type },
          'Skipping recurring proactive trigger without explicit consent',
        );
        continue;
      }

      // Build taskConfig for task-kind items
      const taskConfig = kind === 'task'
        ? {
            goal: trigger.goal || trigger.guidance || message,
            tools: Array.isArray(trigger.tools) ? trigger.tools : undefined,
          }
        : null;

      // Extract priority from trigger if available (urgent/high/medium/low)
      const priority = (trigger.priority && ['urgent', 'high', 'medium', 'low'].includes(trigger.priority) ? trigger.priority : 'medium') as 'urgent' | 'high' | 'medium' | 'low';
      // Consent is derived from the user's own words, not trusted model output.
      // The structured model field remains useful for evaluation/diagnostics,
      // but it cannot grant itself a higher delivery privilege.
      const consent = explicitConsent ? 'explicit' : 'inferred';

      db.addScheduledItem({
        userId,
        sessionId: sourceSessionId ?? null,
        // Explicit user requests keep their requested cadence and are never
        // counted/deduped as autonomous outreach. The text is still generated,
        // so messageProvenance remains generated and is rendered safely.
        source: consent === 'explicit' ? 'user' : 'agent',
        kind,
        type: trigger.type || 'follow_up',
        message,
        context: storedContext,
        triggerAt,
        recurring,
        sourceMemoryId: sourceMemoryId ?? null,
        taskConfig,
        boardStatus: 'inbox',
        priority,
      });
      remainingBudget--;
      this.logger.info(
        {
          type: trigger.type,
          kind,
          description: message,
          triggerAt: new Date(triggerAt).toISOString(),
          hasGuidance: !!trigger.guidance,
          hasGoal: !!trigger.goal,
          recurring: recurring?.type ?? null,
        },
        'Scheduled item created from extraction'
      );
    }
  }

  private hasExplicitProactiveRequest(message: string): boolean {
    const normalized = message.replace(/[\u2018\u2019]/g, "'");
    return (
      /\b(?:please\s+)?(?:remind|notify|message|text|ping|nudge)\s+me\b/i.test(normalized) ||
      /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:remind|notify|message|text|ping|nudge|check|follow|look\s+up|find|send)\b/i.test(normalized) ||
      /\bplease\s+(?:check|follow\s+up|look\s+up|find|send)\b/i.test(normalized) ||
      /\b(?:check|follow)\s+(?:in|up)\s+with\s+me\b/i.test(normalized) ||
      /\b(?:let\s+me\s+know|tell\s+me)\s+(?:at|when|if|about|tomorrow|later)\b/i.test(normalized) ||
      /\bi(?:'d|\s+would)\s+like\s+(?:a\s+)?(?:reminder|notification|check[- ]?in)\b/i.test(normalized) ||
      /\bset\s+(?:a\s+)?(?:reminder|notification)\b/i.test(normalized) ||
      /\b(?:don't\s+let\s+me\s+forget|make\s+sure\s+(?:you\s+)?(?:remind|notify)\s+me)\b/i.test(normalized)
    );
  }

  /**
   * Structured models sometimes copy a local clock ("7pm") into an ISO string
   * and incorrectly append Z. When the source contains exactly one explicit
   * clock and its hour matches the ISO components, reinterpret those components
   * in the user's timezone. Genuine UTC/GMT requests remain absolute.
   */
  private correctMislabelledUtcWallClock(
    triggerTime: string,
    sourceUserMessage: string,
    timezone: string,
  ): number | null {
    if (/\b(?:UTC|GMT)\b/i.test(sourceUserMessage)) return null;
    const iso = triggerTime.trim().match(
      /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z$/i,
    );
    if (!iso) return null;

    const clocks = sourceUserMessage.match(
      /\b(?:(?:0?\d|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d)\b/gi,
    ) ?? [];
    if (clocks.length !== 1) return null;
    const sourceClock = this.parseTimeOfDay(clocks[0]);
    if (!sourceClock) return null;

    const [, year, month, day, hour, minute] = iso.map(Number);
    if (sourceClock.hour !== hour || sourceClock.minute !== minute) return null;
    const absolute = new Date(triggerTime);
    if (Number.isNaN(absolute.getTime())) return null;
    try {
      const rendered = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(absolute);
      const value = (type: string) => Number(rendered.find(part => part.type === type)?.value);
      if (value('hour') === sourceClock.hour && value('minute') === sourceClock.minute) return null;
    } catch {
      return null;
    }
    return this.wallClockToEpoch(year, month, day, hour, minute, timezone);
  }

  /**
   * Parse trigger time from ISO or relative format
   * Supports: ISO datetime with time, '+2h', '+1d', '+1w', 'tomorrow 9am', '+1d morning', 'Monday 10:00', etc.
   * REJECTS: date-only strings like "2026-02-07" or "TODAY" without time
   */
  private parseTriggerTime(timeStr: string, timezone?: string): number | null {
    const now = Date.now();
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localNow = this.getLocalCalendarParts(now, tz);

    // Reject "TODAY" without specific time
    if (/^today$/i.test(timeStr.trim())) {
      return null;
    }

    // Try ISO format - but ONLY if it includes time component (T or space followed by time)
    // Reject date-only formats like "2026-02-07"
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(timeStr)) {
      const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
      if (!match || !this.isValidWallClockComponents(
        Number(match[1]), Number(match[2]), Number(match[3]),
        Number(match[4]), Number(match[5]),
      )) {
        return null;
      }
      // Explicit offsets/Z are absolute. Offset-less ISO strings are wall
      // clock values in the user's timezone, not the server's timezone.
      if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(timeStr.trim())) {
        const isoDate = new Date(timeStr);
        if (!isNaN(isoDate.getTime())) return isoDate.getTime();
      } else {
        return this.wallClockToEpoch(
          Number(match[1]), Number(match[2]), Number(match[3]),
          Number(match[4]), Number(match[5]), tz,
        );
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

      const targetDate = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + daysToAdd));

      // Parse time of day
      const timeOfDayLower = timeOfDay.toLowerCase().trim();
      if (timeOfDayLower === 'morning') {
        targetDate.setUTCHours(9, 0, 0, 0);
      } else if (timeOfDayLower === 'afternoon') {
        targetDate.setUTCHours(14, 0, 0, 0);
      } else if (timeOfDayLower === 'evening') {
        targetDate.setUTCHours(18, 0, 0, 0);
      } else if (timeOfDayLower === 'night') {
        targetDate.setUTCHours(20, 0, 0, 0);
      } else {
        // Try parsing as specific time (9am, 10:30, etc.)
        const specificTime = this.parseTimeOfDay(timeOfDay);
        if (specificTime) {
          targetDate.setUTCHours(specificTime.hour, specificTime.minute, 0, 0);
        } else {
          targetDate.setUTCHours(9, 0, 0, 0); // Default to morning
        }
      }

      return this.wallClockToEpoch(
        targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, targetDate.getUTCDate(),
        targetDate.getUTCHours(), targetDate.getUTCMinutes(), tz,
      );
    }

    // Day of week patterns: Monday, next Tuesday, etc.
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < dayNames.length; i++) {
      if (lowerStr.includes(dayNames[i])) {
        const targetDate = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
        const currentDay = targetDate.getUTCDay();
        let daysUntil = i - currentDay;
        if (daysUntil <= 0) daysUntil += 7; // Next occurrence

        targetDate.setUTCDate(targetDate.getUTCDate() + daysUntil);

        // Try to parse time from the string
        const specificTime = this.parseTimeOfDay(timeStr);
        if (specificTime) {
          targetDate.setUTCHours(specificTime.hour, specificTime.minute, 0, 0);
        } else {
          targetDate.setUTCHours(9, 0, 0, 0); // Default to 9am
        }

        return this.wallClockToEpoch(
          targetDate.getUTCFullYear(), targetDate.getUTCMonth() + 1, targetDate.getUTCDate(),
          targetDate.getUTCHours(), targetDate.getUTCMinutes(), tz,
        );
      }
    }

    // Today with time pattern (e.g., "today 2pm", "today 14:30")
    if (lowerStr.includes('today')) {
      const specificTime = this.parseTimeOfDay(timeStr);
      if (specificTime) {
        const today = this.wallClockToEpoch(
          localNow.year, localNow.month, localNow.day,
          specificTime.hour, specificTime.minute, tz,
        );
        // Only valid if the time is in the future
        if (today !== null && today > now) return today;
      }
      // "today" without valid future time - reject
      return null;
    }

    // Tomorrow patterns
    if (lowerStr.includes('tomorrow')) {
      const tomorrow = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1));
      const specificTime = this.parseTimeOfDay(timeStr);
      if (specificTime) {
        tomorrow.setUTCHours(specificTime.hour, specificTime.minute, 0, 0);
      } else {
        tomorrow.setUTCHours(9, 0, 0, 0);
      }
      return this.wallClockToEpoch(
        tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(),
        tomorrow.getUTCHours(), tomorrow.getUTCMinutes(), tz,
      );
    }

    return null;
  }

  private getLocalCalendarParts(epochMs: number, timezone: string): { year: number; month: number; day: number } {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(epochMs));
      const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
      const year = value('year');
      const month = value('month');
      const day = value('day');
      if ([year, month, day].every(Number.isFinite)) return { year, month, day };
    } catch { /* invalid timezone falls back to server calendar */ }
    const date = new Date(epochMs);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }

  private isValidWallClockComponents(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ): boolean {
    if (![year, month, day, hour, minute].every(Number.isInteger)) return false;
    if (month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return false;
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day >= 1 && day <= daysInMonth;
  }

  /**
   * Convert a user-local wall clock to epoch milliseconds, including DST.
   * Invalid calendar dates and DST-skipped local times are rejected instead
   * of being silently normalized to a different date or hour.
   */
  private wallClockToEpoch(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timezone: string,
  ): number | null {
    if (!this.isValidWallClockComponents(year, month, day, hour, minute)) return null;
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    let guess = desiredAsUtc;
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      // Two passes handle offset changes around DST boundaries.
      for (let pass = 0; pass < 2; pass++) {
        const parts = formatter.formatToParts(new Date(guess));
        const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
        const renderedAsUtc = Date.UTC(
          value('year'), value('month') - 1, value('day'),
          value('hour') % 24, value('minute'),
        );
        guess += desiredAsUtc - renderedAsUtc;
      }

      const finalParts = formatter.formatToParts(new Date(guess));
      const finalValue = (type: string) => Number(finalParts.find(part => part.type === type)?.value);
      if (
        finalValue('year') !== year ||
        finalValue('month') !== month ||
        finalValue('day') !== day ||
        finalValue('hour') % 24 !== hour ||
        finalValue('minute') !== minute
      ) {
        return null;
      }
      return guess;
    } catch {
      return null;
    }
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
  private structuredRoute(purpose: string): string {
    return `${purpose}:${this.provider.name}`;
  }

  /** ScallopDatabase implements this interface; light test/custom stores may not. */
  private getCircuitStore(): StructuredRouteCircuitStore | null {
    const candidate = this.scallopStore.getDatabase() as unknown as Partial<StructuredRouteCircuitStore>;
    return typeof candidate.getStructuredRouteCircuit === 'function'
      && typeof candidate.recordStructuredRouteFailure === 'function'
      && typeof candidate.clearStructuredRouteCircuit === 'function'
      ? candidate as StructuredRouteCircuitStore
      : null;
  }

  private structuredRouteIsBackedOff(route: string): boolean {
    try {
      return (this.getCircuitStore()?.getStructuredRouteCircuit(route)?.nextRetryAt ?? 0) > this.now();
    } catch {
      return false;
    }
  }

  private recordStructuredRouteFailure(route: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('timeout')
      ? 'timeout'
      : message.includes('invalid_json') ? 'invalid_json' : 'provider_error';
    try {
      this.getCircuitStore()?.recordStructuredRouteFailure(route, code, this.now());
    } catch {
      // A diagnostics write must not replace the original extraction error.
    }
  }

  private clearStructuredRouteFailure(route: string): void {
    try {
      this.getCircuitStore()?.clearStructuredRouteCircuit(route);
    } catch {
      // A valid response remains safe to process; clearing can retry next run.
    }
  }

  private parseResponse(content: string): {
    facts: ExtractedFactWithEmbedding[];
    proactive_triggers?: Array<{
      type: 'event_prep' | 'commitment_check' | 'goal_checkin' | 'follow_up';
      kind?: 'nudge' | 'task';
      consent?: 'explicit' | 'inferred';
      description: string;
      trigger_time: string;
      context: string;
      guidance?: string | null;
      goal?: string | null;
      tools?: string[] | null;
      recurring?: RecurringSchedule | null;
      recurring_pattern?: string | null; // legacy fallback
      priority?: 'urgent' | 'high' | 'medium' | 'low';
    }>;
  } | null {
    if (!content || content.trim().length === 0) {
      this.logger.warn('LLM returned empty response during fact extraction');
      return null;
    }

    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(
        { contentPreview: content.substring(0, 200) },
        'LLM response contained no JSON object — facts may have been lost'
      );
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message, contentPreview: content.substring(0, 200) },
        'Failed to parse JSON from LLM response — facts were lost'
      );
      return null;
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
  context?: string,
  requestTimeoutMs: number = 10_000,
): Promise<{ facts: ExtractedFactWithEmbedding[] }> {
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const currentTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  let prompt = FACT_AND_TRIGGER_EXTRACTION_PROMPT.replace('{{CURRENT_DATE}}', currentDate).replace('{{CURRENT_TIME}}', currentTime) + '\n\n';
  if (context) {
    prompt += `Context from previous messages:\n${context}\n\n`;
  }
  prompt += `User message:\n${message}\n\nExtract facts (JSON only):`;

  const response = await completeWithinDeadline(provider, {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    maxTokens: 1200,
    enableThinking: false,
    structuredOutput: {
      name: 'fact_extraction',
      schema: FACT_ONLY_SCHEMA,
      strict: true,
    },
    purpose: 'fact_extract',
  }, requestTimeoutMs, 'fact_extraction_timeout');

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
