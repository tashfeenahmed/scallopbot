/**
 * SQLite Database Layer for ScallopMemory
 *
 * Provides persistent storage with:
 * - Memory entries with temporal grounding
 * - Relationship graph (UPDATES/EXTENDS/DERIVES)
 * - User profiles (static/dynamic/behavioral)
 * - Decay system support
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { nanoid } from 'nanoid';
import type {
  MessageFrequencySignal,
  SessionEngagementSignal,
  TopicSwitchSignal,
  ResponseLengthSignal,
} from './behavioral-signals.js';
import type { AffectEMAState, SmoothedAffect } from './affect-smoothing.js';
import {
  buildSemanticLshProbes,
  computeSemanticLshBuckets,
  SEMANTIC_CANDIDATE_LIMIT,
  SEMANTIC_LSH_VERSION,
} from './semantic-index.js';

/** Parse a JSON detail blob, returning null on malformed input. */
function parseDetailJSON(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Shared stop words for scheduled-item text similarity matching.
 * Used by consolidation, dedup, and cascade cancellation.
 */
const SCHEDULED_ITEM_STOP_WORDS = new Set([
  'the', 'a', 'an', 'at', 'on', 'in', 'to', 'for', 'of', 'and', 'is', 'are', 'was', 'were', 'been',
  'my', 'me', 'i', 'you', 'your', 'its', 'his', 'her', 'our', 'their',
  'with', 'from', 'has', 'have', 'had', 'will', 'can', 'not', 'but', 'this', 'that', 'about',
  'remind', 'reminder', 'remember', 'check', 'follow', 'up', 'user', 'upcoming', 'scheduled',
  'prepare', 'notes', 'ready', 'get', 'time', 'just', 'now', 'today', 'tomorrow',
  // Additional words to improve dedup between board-created and agent-created items
  'commitment', 'needs', 'need', 'should', 'must', 'gonna', 'going', 'plan', 'planning',
  'mentioned', 'said', 'told', 'wants', 'want', 'also', 'dont', 'forget', 'make', 'sure',
]);

/** Normalize text to significant word set for similarity matching */
function normalizeForSimilarity(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !SCHEDULED_ITEM_STOP_WORDS.has(word))
  );
}

/** Strict similarity: |intersection| / |smaller set| threshold */
const DEDUP_SIMILARITY_STRICT = 0.8;
/** Lenient similarity: either side has this fraction overlap.
 *  Lowered from 0.4 → 0.3 to catch LLM-generated wording variations like
 *  "Day 6: Kitchen area + 1 cupboard" vs "Day 7: Kitchen area + 1 cupboard"
 *  that previously slipped through and caused proactive-message bursts. */
const DEDUP_SIMILARITY_LENIENT = 0.3;

/**
 * Memory types for decay calculation
 */
export type ScallopMemoryType =
  | 'static_profile'
  | 'dynamic_profile'
  | 'regular'
  | 'derived'
  | 'superseded';

/**
 * Memory categories
 */
export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'event'
  | 'relationship'
  | 'insight';

/**
 * Relationship types between memories
 */
export type RelationType = 'UPDATES' | 'EXTENDS' | 'DERIVES';

/**
 * Lightweight memory entry — same as ScallopMemoryEntry but without the
 * embedding vector.  Used for BM25/keyword scoring where loading and
 * JSON-parsing the 768-dim float[] per row is unnecessary overhead.
 */
export type ScallopMemoryEntryLight = Omit<ScallopMemoryEntry, 'embedding'> & { embedding: null };

/**
 * Core memory entry in SQLite
 */
export interface ScallopMemoryEntry {
  id: string;
  userId: string;
  content: string;
  category: MemoryCategory;
  memoryType: ScallopMemoryType;
  importance: number; // 1-10
  confidence: number; // 0.0-1.0
  isLatest: boolean;

  // Source attribution (defaults to 'user' if not specified)
  source?: 'user' | 'assistant';

  // Temporal grounding
  documentDate: number; // epoch ms - when recorded
  eventDate: number | null; // epoch ms - when event occurs

  // Decay system
  prominence: number;
  lastAccessed: number | null;
  accessCount: number;

  // Source chunk for hybrid retrieval
  sourceChunk: string | null;

  // Embedding (stored as JSON string in SQLite)
  embedding: number[] | null;

  // Metadata (stored as JSON string)
  metadata: Record<string, unknown> | null;

  // Source memory tracking (optional with defaults for backward compatibility)
  /** How the memory was learned: conversation, correction, inference, consolidation */
  learnedFrom?: string;
  /** Number of times this fact has been re-stated/confirmed */
  timesConfirmed?: number;
  /** JSON array of memory IDs that contradict this one */
  contradictionIds?: string[] | null;

  createdAt: number;
  updatedAt: number;
}

/** Filters applied inside the SQLite LSH candidate lookup. */
export interface SemanticCandidateOptions {
  userId?: string;
  category?: MemoryCategory;
  minProminence?: number;
  isLatest?: boolean;
  eventDateRange?: { start: number; end: number };
  documentDateRange?: { start: number; end: number };
  maxCandidates: number;
  /**
   * IDs already admitted by the caller's light-memory query. Passing this
   * avoids repeating category/date/prominence joins for every LSH probe.
   */
  eligibleIds?: Pick<ReadonlySet<string>, 'has'>;
  /** Optional tie-break metadata for eligible candidates. */
  candidatePriorities?: ReadonlyMap<string, { prominence: number; documentDate: number }>;
}

/**
 * Memory relation entry
 */
export interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: RelationType;
  confidence: number;
  createdAt: number;
}

/**
 * User profile entry (key-value static facts)
 */
export interface UserProfileEntry {
  userId: string;
  key: string;
  value: string;
  confidence: number;
  updatedAt: number;
}

/**
 * Dynamic profile for a user
 */
export interface DynamicProfile {
  userId: string;
  recentTopics: string[];
  currentMood: string | null;
  activeProjects: string[];
  lastInteraction: number;
}

/**
 * Behavioral patterns for a user
 */
export interface BehavioralPatterns {
  userId: string;
  communicationStyle: string | null;
  expertiseAreas: string[];
  responsePreferences: Record<string, unknown>;
  activeHours: number[];
  /** EMA-smoothed daily message rate with trend (null = insufficient data) */
  messageFrequency: MessageFrequencySignal | null;
  /** EMA-smoothed session engagement with trend (null = insufficient data) */
  sessionEngagement: SessionEngagementSignal | null;
  /** Embedding-based topic switch rate (null = insufficient data) */
  topicSwitch: TopicSwitchSignal | null;
  /** EMA-smoothed message length evolution (null = insufficient data) */
  responseLength: ResponseLengthSignal | null;
  /** Affect EMA state for continuation across messages (null = no affect data yet) */
  affectState: AffectEMAState | null;
  /** Derived smoothed affect: emotion label, valence, arousal, goal signal (null = no affect data yet) */
  smoothedAffect: SmoothedAffect | null;
  updatedAt: number;
}

/**
 * Session entry
 */
export interface SessionRow {
  id: string;
  metadata: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Session message entry
 */
export interface SessionMessageRow {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Session summary entry (LLM-generated)
 */
export interface SessionSummaryRow {
  id: string;
  sessionId: string;
  userId: string;
  summary: string;
  topics: string[];
  messageCount: number;
  durationMs: number;
  embedding: number[] | null;
  createdAt: number;
}

/**
 * Bot config entry
 */
export interface BotConfigRow {
  userId: string;
  botName: string;
  personalityId: string;
  customPersonality: string | null;
  modelId: string;
  timezone: string;
  onboardingComplete: boolean;
  onboardingStep: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cost usage entry
 */
export interface CostUsageRow {
  id: number;
  model: string;
  provider: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

// ============ Unified Scheduled Items (Triggers + Reminders) ============

/**
 * Source of the scheduled item
 */
export type ScheduledItemSource = 'user' | 'agent';

/**
 * Provenance of the text stored in a scheduled item's message field.
 *
 * `source` identifies who initiated the item; it does not prove who authored
 * the stored text. Only trusted ingress that preserves text literally supplied
 * by the user may set `user_literal`. Model/tool-authored and legacy text must
 * remain `generated` so it crosses the proactive rendering boundary.
 */
export type ScheduledMessageProvenance = 'user_literal' | 'generated';

/**
 * Kind of scheduled item: nudge (pre-written message) or task (sub-agent work)
 */
export type ScheduledItemKind = 'nudge' | 'task';

/**
 * Configuration for task-kind scheduled items
 */
export interface TaskConfig {
  goal: string;
  tools?: string[];
  modelTier?: 'fast' | 'standard' | 'capable';
  /** Maximum worker attempts before the durable task is archived as failed. */
  maxAttempts?: number;
}

/**
 * Type of scheduled item
 */
export type ScheduledItemType =
  | 'reminder'         // User-set reminder
  | 'event_prep'       // Agent: prepare for upcoming event
  | 'commitment_check' // Agent: check on user's stated intention
  | 'goal_checkin'     // Agent: check in on long-term goal
  | 'follow_up';       // Agent: general follow-up

/**
 * Status of scheduled item
 */
export type ScheduledItemStatus = 'pending' | 'processing' | 'fired' | 'dismissed' | 'expired' | 'acted';

export type ProactiveSourceReplyAction = 'archive' | 'done' | 'snooze';

export interface ProactiveSourceReplyTransactionResult {
  acknowledged: boolean;
  replayed: boolean;
  sourceAction: {
    action: ProactiveSourceReplyAction;
    title: string;
    applied: boolean;
  } | null;
}

export type ProactiveDeliveryReservationResult =
  | { outcome: 'reserved'; token: string }
  | { outcome: 'daily_cap'; retryAt: number }
  | { outcome: 'min_gap'; retryAt: number };

export interface ProactiveDeliveryReceiptRow {
  id: number;
  channel: string;
  channelMessageId: string;
  scheduledItemId: string;
  ownerUserId: string;
  ambiguous: boolean;
  createdAt: number;
}

// ============ Board (Kanban) Types ============

/**
 * Board column status for kanban view
 */
export type BoardStatus = 'inbox' | 'backlog' | 'scheduled' | 'in_progress' | 'waiting' | 'done' | 'archived';

/**
 * Priority levels for board items
 */
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

/**
 * Result stored when a board item completes
 */
export interface BoardItemResult {
  response: string;
  completedAt: number;
  subAgentRunId?: string;
  iterationsUsed?: number;
  costUsd?: number;
  taskComplete?: boolean;
  notifiedAt?: number | null;
}

/**
 * Recurring schedule types
 */
export type RecurringType = 'daily' | 'weekly' | 'weekdays' | 'weekends';

/**
 * Recurring schedule configuration
 */
export interface RecurringSchedule {
  type: RecurringType;
  hour: number;       // 0-23
  minute: number;     // 0-59
  dayOfWeek?: number; // 0-6 (Sunday=0) for weekly
}

/**
 * Unified scheduled item entry - combines triggers and reminders
 */
export interface ScheduledItem {
  id: string;
  userId: string;
  sessionId: string | null;

  // Source distinction
  source: ScheduledItemSource;  // 'user' (explicit) | 'agent' (implicit)
  messageProvenance: ScheduledMessageProvenance;

  // Kind: nudge (pre-written message) or task (sub-agent work)
  kind: ScheduledItemKind;

  // Type/category
  type: ScheduledItemType;

  // Task configuration (for kind='task')
  taskConfig: TaskConfig | null;

  // Content
  message: string;              // The reminder/trigger message
  context: string | null;       // Additional context (for LLM message gen with agent items)

  // Scheduling
  triggerAt: number;            // epoch ms

  // Recurring support
  recurring: RecurringSchedule | null;

  // Status
  status: ScheduledItemStatus;
  firedAt: number | null;

  // Metadata
  sourceMemoryId: string | null; // For agent-created items
  /** Board item whose state caused this generated wrapper/nudge. */
  sourceItemId: string | null;

  // Board (kanban) fields
  boardStatus: BoardStatus | null;   // null = legacy item, compute from status
  priority: Priority;
  labels: string[] | null;
  result: BoardItemResult | null;
  dependsOn: string[] | null;        // IDs of items this depends on
  goalId: string | null;             // FK to memories.id (goal/milestone)

  // Durable task-worker ownership. Lease tokens stay internal to workers.
  workerId: string | null;
  preferredWorkerId: string | null;
  leaseToken: string | null;
  leasedAt: number | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  handedOffFrom: string | null;

  createdAt: number;
  updatedAt: number;
}

// ============ Sub-Agent Runs ============

/**
 * Sub-agent run row as stored in SQLite
 */
export interface SubAgentRunRow {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  task: string;
  label: string;
  status: string;
  allowedSkills: string | null;
  modelTier: string;
  timeoutMs: number;
  resultResponse: string | null;
  resultIterations: number | null;
  resultTaskComplete: boolean | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/**
 * SQLite Database Manager for ScallopMemory
 */
export class ScallopDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');

    // A partially initialized connection must never escape when a required
    // migration fails. Closing here also releases WAL/lock resources before
    // the startup error is reported to the caller.
    try {
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      -- Core memories table
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'regular',
        importance INTEGER DEFAULT 5,
        confidence REAL DEFAULT 0.8,
        is_latest INTEGER DEFAULT 1,

        -- Source attribution (user or assistant)
        source TEXT DEFAULT 'user',

        -- Temporal grounding
        document_date INTEGER NOT NULL,
        event_date INTEGER,

        -- Decay system
        prominence REAL DEFAULT 1.0,
        last_accessed INTEGER,
        access_count INTEGER DEFAULT 0,

        -- Source chunk for hybrid retrieval
        source_chunk TEXT,

        -- Embedding (JSON string)
        embedding TEXT,

        -- Metadata (JSON string)
        metadata TEXT,

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Relationships between memories
      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- User profiles (static facts)
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 0.9,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      -- Dynamic profiles (recent context)
      CREATE TABLE IF NOT EXISTS dynamic_profiles (
        user_id TEXT PRIMARY KEY,
        recent_topics TEXT,
        current_mood TEXT,
        active_projects TEXT,
        last_interaction INTEGER NOT NULL
      );

      -- Behavioral patterns (weekly aggregation)
      CREATE TABLE IF NOT EXISTS behavioral_patterns (
        user_id TEXT PRIMARY KEY,
        communication_style TEXT,
        expertise_areas TEXT,
        response_preferences TEXT,
        active_hours TEXT,
        updated_at INTEGER NOT NULL
      );

      -- Sessions (replaces per-session .jsonl files)
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        metadata TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Session messages
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Bot configuration (replaces bot-config.json)
      CREATE TABLE IF NOT EXISTS bot_config (
        user_id TEXT PRIMARY KEY,
        bot_name TEXT NOT NULL DEFAULT 'ScallopBot',
        personality_id TEXT NOT NULL DEFAULT 'friendly',
        custom_personality TEXT,
        model_id TEXT NOT NULL DEFAULT 'moonshot-v1-128k',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        onboarding_complete INTEGER NOT NULL DEFAULT 0,
        onboarding_step TEXT DEFAULT 'welcome',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Cost usage tracking (replaces in-memory array)
      CREATE TABLE IF NOT EXISTS cost_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      -- Unified scheduled items (triggers + reminders)
      CREATE TABLE IF NOT EXISTS scheduled_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,

        -- Source distinction
        source TEXT NOT NULL,              -- 'user' (explicit) | 'agent' (implicit)

        -- Type/category
        type TEXT NOT NULL,                -- reminder|event_prep|commitment_check|goal_checkin|follow_up

        -- Content
        message TEXT NOT NULL,             -- The reminder/trigger message
        message_provenance TEXT NOT NULL DEFAULT 'generated'
          CHECK (message_provenance IN ('user_literal', 'generated')),
        context TEXT,                      -- Additional context (for LLM message gen)

        -- Scheduling
        trigger_at INTEGER NOT NULL,       -- epoch ms

        -- Recurring support (stored as JSON)
        recurring TEXT,                    -- JSON: {type, hour, minute, dayOfWeek?}

        -- Status
        status TEXT NOT NULL DEFAULT 'pending',  -- pending|fired|dismissed|expired
        fired_at INTEGER,

        -- Metadata
        source_memory_id TEXT,             -- For agent-created items
        source_item_id TEXT,               -- Board item that caused a generated wrapper/nudge

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Session summaries (LLM-generated summaries of past sessions)
      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        summary TEXT NOT NULL,
        topics TEXT,          -- JSON array of topic strings
        message_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        embedding TEXT,       -- JSON array (embedding vector)
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries(user_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_cost_usage_timestamp ON cost_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_usage_session ON cost_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_prominence ON memories(prominence DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_event_date ON memories(event_date);
      CREATE INDEX IF NOT EXISTS idx_memories_is_latest ON memories(is_latest);
      CREATE INDEX IF NOT EXISTS idx_memories_document_date ON memories(document_date);

      -- Dependency-free ANN candidate index. The vector itself remains in the
      -- memories table; these small integer signatures make semantic lookup
      -- bounded on low-memory Raspberry Pi deployments.
      CREATE TABLE IF NOT EXISTS memory_embedding_lsh (
        memory_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        index_version INTEGER NOT NULL,
        table_id INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        PRIMARY KEY (memory_id, index_version, table_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_lsh_lookup
        ON memory_embedding_lsh(index_version, dimension, table_id, bucket, user_id);

      -- Compound indexes for light queries (getMemoriesByUserLight, getRecentMemoriesLight)
      CREATE INDEX IF NOT EXISTS idx_memories_user_latest_prom ON memories(user_id, is_latest, prominence DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_user_docdate ON memories(user_id, document_date DESC);

      CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);

      -- Indexes for scheduled_items
      CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_items(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_source ON scheduled_items(source);
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_items(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_trigger_at ON scheduled_items(trigger_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_items(status, trigger_at) WHERE status = 'pending';

      -- Sub-agent runs (tracks sub-agent execution lifecycle)
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        allowed_skills TEXT,
        model_tier TEXT NOT NULL DEFAULT 'fast',
        timeout_ms INTEGER NOT NULL,
        result_response TEXT,
        result_iterations INTEGER,
        result_task_complete INTEGER,
        error TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);

      -- Auth: single web UI user
      CREATE TABLE IF NOT EXISTS auth_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Auth: session tokens
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

      -- Runtime key vault (API keys set by agent, persisted across restarts)
      CREATE TABLE IF NOT EXISTS runtime_keys (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Transcript chunks for cross-session recall (#9)
      CREATE TABLE IF NOT EXISTS transcript_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_range_start INTEGER NOT NULL,
        message_range_end INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_session ON transcript_chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_chunks_user ON transcript_chunks(user_id);

      -- Persistent log of recently sent proactive messages so the in-memory
      -- dedup map (UnifiedScheduler.recentSends) survives restarts. Without
      -- this, every restart loses the dedup history, opening a window where
      -- recurring proactive items can fire with rephrased wording.
      CREATE TABLE IF NOT EXISTS proactive_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_send_log_user_time
        ON proactive_send_log(user_id, sent_at DESC);

      -- Cross-process delivery slots. A short-lived reservation closes the
      -- check-then-send race between scheduler instances; successful delivery
      -- atomically becomes a proactive_send_log row.
      CREATE TABLE IF NOT EXISTS proactive_delivery_reservations (
        token TEXT PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        reserved_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_reservation_user
        ON proactive_delivery_reservations(user_id, expires_at);

      -- Append-only provenance for channel deliveries. Message IDs are scoped
      -- by channel and owner because (for example) Telegram message_id values
      -- are chat-local. Multiple rows for one channel message deliberately
      -- represent ambiguity after queue combining and must never be collapsed.
      CREATE TABLE IF NOT EXISTS proactive_delivery_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        channel_message_id TEXT NOT NULL,
        scheduled_item_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
        created_at INTEGER NOT NULL,
        UNIQUE(channel, channel_message_id, scheduled_item_id, owner_user_id, ambiguous)
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_receipt_lookup
        ON proactive_delivery_receipts(channel, channel_message_id, owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_proactive_delivery_receipt_item
        ON proactive_delivery_receipts(scheduled_item_id, created_at);

      -- One trusted direct-reply action per delivered wrapper. This ledger is
      -- the idempotency key that prevents a retry from extending Snooze again.
      CREATE TABLE IF NOT EXISTS proactive_source_reply_actions (
        wrapper_id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('archive', 'done', 'snooze')),
        source_title TEXT NOT NULL,
        applied INTEGER NOT NULL,
        source_trigger_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_source_reply_source
        ON proactive_source_reply_actions(source_item_id, created_at);

      -- Observability log of proactive DECISIONS (not just sends): every time
      -- the evaluator or scheduler decides to create / skip / suppress / deliver
      -- a proactive message, it records why here. Powers the why-no-proact
      -- diagnostic so a silent "nothing fired" can be traced to the exact gate.
      CREATE TABLE IF NOT EXISTS proactive_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_decisions_at
        ON proactive_decisions(at DESC);

      -- LLM call traces for fine-tune dataset building (see trace-tap.ts).
      -- Full rendered prompt + raw response per tagged structured call
      -- (fact_extract, memory_manage, relation_classify, rerank,
      -- session_summary, tool_call). parsed_ok=0 rows are the failures the
      -- fine-tune should eliminate; parsed_ok=1 rows from strong models are
      -- training targets. Pruned by retention (pruneLlmTraces) after pull.
      CREATE TABLE IF NOT EXISTS llm_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        parsed_ok INTEGER NOT NULL,
        session_id TEXT,
        latency_ms INTEGER,
        stop_reason TEXT,
        request_max_tokens INTEGER,
        model_context_window_tokens INTEGER,
        model_max_output_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_llm_traces_ts ON llm_traces(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_traces_purpose ON llm_traces(purpose, ts DESC);

      -- Self-evolution engine — Layer 1 corpus of improvement signals captured
      -- at the end of agent turns (reusable tasks, skill failures, low-quality
      -- answers). The nightly optimizer harvests these to propose mutations.
      CREATE TABLE IF NOT EXISTS evolution_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        target_skill TEXT,
        critic_score REAL,
        tool_call_count INTEGER,
        session_id TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_signals_at
        ON evolution_signals(at DESC);

      -- Self-evolution observability log: every harvest/reflect/verify/promote/
      -- rollback decision, powering the why-evolution diagnostic.
      CREATE TABLE IF NOT EXISTS evolution_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        target TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_decisions_at
        ON evolution_decisions(at DESC);

      -- Promoted-mutation ledger: snapshots the prior version of a target before a
      -- mutation goes live, so a regressing change can be auto-rolled-back. status:
      -- active | superseded | rolled_back. snapshot is the prior artifact or null
      -- if the target did not exist before (then rollback = delete).
      CREATE TABLE IF NOT EXISTS evolution_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        baseline_fitness REAL,
        snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_versions_target
        ON evolution_versions(target, at DESC);

      -- Machine-authored prompt fragments (e.g. 'learned_guidance') appended to the
      -- system prompt when active. The optimizer's patch_prompt path writes here;
      -- the agent reads active rows each turn. One active row per fragment_id.
      CREATE TABLE IF NOT EXISTS prompt_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fragment_id TEXT NOT NULL,
        content TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_overrides_fragment
        ON prompt_overrides(fragment_id, active);
    `);

    // Existing public databases may predate the one-active-version invariant.
    // Normalize duplicates before creating the partial unique index.
    this.migrateNormalizeEvolutionVersions();

    // Migration: Add source column to existing databases
    this.migrateAddSourceColumn();

    // Migration: Add timezone column to bot_config
    this.migrateAddTimezoneColumn();

    // Migration: Add source memory columns (learned_from, times_confirmed, contradiction_ids)
    this.migrateAddSourceMemoryColumns();

    // Migration: Clean polluted memory entries (skill outputs, assistant responses stored as facts)
    this.migrateCleanPollutedMemories();

    // Migration: Add kind and task_config columns to scheduled_items
    this.migrateAddKindColumn();

    // Migration: Separate item origin from authorship of its outbound text.
    this.migrateAddScheduledMessageProvenance();

    // Migration: Add board (kanban) columns to scheduled_items
    this.migrateAddBoardColumns();

    // Migration: Link generated wrapper nudges to the board item that caused them.
    this.migrateAddScheduledSourceItem();

    // Migration: Add durable task lease/retry/handoff columns
    this.migrateAddBoardExecutionColumns();

    // Migration: Preserve and repair legacy rows whose lifecycle and board
    // columns disagree, then enforce the invariant for every future writer.
    this.migrateReconcileScheduledItemStates();

    // Migration: Create FTS5 virtual table for transcript chunk search
    this.migrateCreateTranscriptFTS();

    // Migration: Add model/token-limit diagnostics to llm_traces
    this.migrateAddLlmTraceMetadataColumns();

    // Migration: Index embeddings written before the bounded semantic index
    // existed. This is a one-time startup cost; normal writes stay indexed.
    this.migrateBackfillEmbeddingLsh();
  }

  private migrateNormalizeEvolutionVersions(): void {
    const migrate = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE evolution_versions AS current
        SET status = 'superseded'
        WHERE current.status = 'active'
          AND EXISTS (
            SELECT 1 FROM evolution_versions AS newer
            WHERE newer.target = current.target AND newer.status = 'active'
              AND (newer.at > current.at OR (newer.at = current.at AND newer.id > current.id))
          )
      `).run();
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_versions_one_active_target
        ON evolution_versions(target) WHERE status = 'active'
      `);
    });
    migrate();
  }

  /** Backfill only missing/current-version signatures in small transactions. */
  private migrateBackfillEmbeddingLsh(): void {
    try {
      this.db.prepare('DELETE FROM memory_embedding_lsh WHERE index_version != ?')
        .run(SEMANTIC_LSH_VERSION);

      const findMissing = this.db.prepare(`
        SELECT m.id, m.user_id, m.embedding
        FROM memories m
        WHERE m.embedding IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_embedding_lsh l
            WHERE l.memory_id = m.id AND l.index_version = ?
          )
        LIMIT 250
      `);
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO memory_embedding_lsh
          (memory_id, user_id, dimension, index_version, table_id, bucket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const indexBatch = this.db.transaction((rows: Array<{
        id: string;
        user_id: string;
        embedding: string;
      }>) => {
        for (const row of rows) {
          let embedding: number[];
          try {
            const parsed = JSON.parse(row.embedding) as unknown;
            if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'number')) {
              throw new Error('embedding is not a numeric array');
            }
            embedding = parsed;
          } catch {
            // A sentinel isolates a malformed legacy row instead of allowing it
            // to block every valid memory later in the one-time backfill.
            insert.run(row.id, row.user_id, 0, SEMANTIC_LSH_VERSION, -1, 0);
            continue;
          }
          const signatures = computeSemanticLshBuckets(embedding);
          if (signatures.length === 0) {
            // Sentinel prevents an empty-but-valid JSON vector from being
            // rediscovered forever by the migration loop.
            insert.run(row.id, row.user_id, 0, SEMANTIC_LSH_VERSION, -1, 0);
          }
          for (const signature of signatures) {
            insert.run(
              row.id,
              row.user_id,
              embedding.length,
              SEMANTIC_LSH_VERSION,
              signature.tableId,
              signature.bucket,
            );
          }
        }
      });

      while (true) {
        const rows = findMissing.all(SEMANTIC_LSH_VERSION) as Array<{
          id: string;
          user_id: string;
          embedding: string;
        }>;
        if (rows.length === 0) break;
        indexBatch(rows);
      }
    } catch (error) {
      // Retrieval still has lexical candidates if index migration fails.
      if (error instanceof Error) {
        console.warn(`[migration] migrateBackfillEmbeddingLsh: ${error.message}`);
      }
    }
  }

  private replaceEmbeddingLsh(memoryId: string, userId: string, embedding: number[]): void {
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_embedding_lsh WHERE memory_id = ?').run(memoryId);
      const stmt = this.db.prepare(`
        INSERT INTO memory_embedding_lsh
          (memory_id, user_id, dimension, index_version, table_id, bucket)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const signatures = computeSemanticLshBuckets(embedding);
      if (signatures.length === 0) {
        stmt.run(memoryId, userId, 0, SEMANTIC_LSH_VERSION, -1, 0);
      }
      for (const signature of signatures) {
        stmt.run(
          memoryId,
          userId,
          embedding.length,
          SEMANTIC_LSH_VERSION,
          signature.tableId,
          signature.bucket,
        );
      }
    });
    replace();
  }

  /**
   * Add source column to memories table if it doesn't exist (migration for existing DBs)
   */
  private migrateAddSourceColumn(): void {
    try {
      // Check if column exists
      const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      const hasSourceColumn = tableInfo.some(col => col.name === 'source');

      if (!hasSourceColumn) {
        this.db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'user'");
      }
    } catch (error) {
      // Column might already exist or table might not exist yet — log for visibility
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddSourceColumn: ${error.message}`);
      }
    }
  }

  /**
   * Add timezone column to bot_config table if it doesn't exist (migration for existing DBs)
   */
  private migrateAddTimezoneColumn(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(bot_config)").all() as Array<{ name: string }>;
      const hasTimezoneColumn = tableInfo.some(col => col.name === 'timezone');

      if (!hasTimezoneColumn) {
        this.db.exec("ALTER TABLE bot_config ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddTimezoneColumn: ${error.message}`);
      }
    }
  }

  /**
   * Add source memory columns: learned_from, times_confirmed, contradiction_ids
   */
  private migrateAddSourceMemoryColumns(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      const columns = new Set(tableInfo.map(col => col.name));

      if (!columns.has('learned_from')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN learned_from TEXT DEFAULT 'conversation'");
      }
      if (!columns.has('times_confirmed')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN times_confirmed INTEGER DEFAULT 1");
      }
      if (!columns.has('contradiction_ids')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN contradiction_ids TEXT DEFAULT NULL");
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('duplicate column')) {
        console.warn(`[migration] migrateAddSourceMemoryColumns: ${error.message}`);
      }
    }
  }

  /**
   * Clean polluted memory entries: skill execution outputs, assistant responses,
   * and user questions that were incorrectly stored as facts.
   * Marks them as is_latest = 0 so they're excluded from search and context.
   */
  private migrateCleanPollutedMemories(): void {
    try {
      // Check if migration already ran (use a sentinel)
      const sentinel = this.db.prepare(
        "SELECT COUNT(*) as c FROM memories WHERE source = '_cleaned_sentinel'"
      ).get() as { c: number };
      if (sentinel.c > 0) return;

      // Run entire migration in a transaction so it's all-or-nothing.
      // If the process crashes mid-migration, the transaction rolls back and
      // re-run will execute cleanly (no sentinel = migration hasn't happened).
      const migrate = this.db.transaction(() => {
        // 1. Archive all skill execution outputs (source starts with 'skill:')
        const skillResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source LIKE 'skill:%' AND is_latest = 1"
        ).run();

        // 2. Archive ALL assistant responses — they are bot outputs, not user facts
        const assistantResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source = 'assistant' AND is_latest = 1"
        ).run();

        // 3. Archive entries that look like proactive check messages or scheduled reminders
        const proactiveResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE (content LIKE '[PROACTIVE CHECK%' OR content LIKE '[SCHEDULED REMINDER%') AND is_latest = 1"
        ).run();

        // 4. Archive entries that are clearly user questions, not facts
        const questionResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE source = 'user' AND is_latest = 1 AND (content LIKE 'what %' OR content LIKE 'how %' OR content LIKE 'do %' OR content LIKE 'can %' OR content LIKE 'where %' OR content LIKE 'when %' OR content LIKE 'why %' OR content LIKE 'who %') AND LENGTH(content) < 60"
        ).run();

        // 5. Archive any remaining entries with content > 300 chars (never real facts)
        const longResult = this.db.prepare(
          "UPDATE memories SET is_latest = 0, memory_type = 'superseded' WHERE LENGTH(content) > 300 AND is_latest = 1"
        ).run();

        // Insert sentinel inside the transaction so it commits atomically with updates
        const now = Date.now();
        this.db.prepare(
          "INSERT INTO memories (id, user_id, content, category, memory_type, importance, confidence, is_latest, source, document_date, prominence, access_count, created_at, updated_at) VALUES (?, 'default', 'Memory cleanup migration completed', 'fact', 'superseded', 0, 0, 0, '_cleaned_sentinel', ?, 0, 0, ?, ?)"
        ).run(`_cleanup_${now}`, now, now, now);

        // Also clean garbage profile values
        // Remove invalid timezone values (not IANA format)
        const tzRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'timezone'"
        ).get() as { value: string } | undefined;
        if (tzRow && !tzRow.value.includes('/') && tzRow.value !== 'UTC' && tzRow.value !== 'GMT') {
          this.db.prepare("DELETE FROM user_profiles WHERE user_id = 'default' AND key = 'timezone'").run();
          console.log(`[memory-cleanup] Removed invalid timezone: "${tzRow.value}"`);
        }

        // Remove mood values that describe bot behavior
        const moodRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'mood'"
        ).get() as { value: string } | undefined;
        if (moodRow && /\b(assist|help|check|remind|offer|execute|search|follow-up)\b/i.test(moodRow.value)) {
          this.db.prepare("DELETE FROM user_profiles WHERE user_id = 'default' AND key = 'mood'").run();
          console.log(`[memory-cleanup] Removed invalid mood: "${moodRow.value}"`);
        }

        // Trim overly long focus fields (keep max 5 items)
        const focusRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'focus'"
        ).get() as { value: string } | undefined;
        if (focusRow) {
          const items = focusRow.value.split(',').map(s => s.trim()).filter(Boolean);
          if (items.length > 5) {
            const trimmed = items.slice(0, 5).join(', ');
            this.db.prepare("UPDATE user_profiles SET value = ? WHERE user_id = 'default' AND key = 'focus'").run(trimmed);
            console.log(`[memory-cleanup] Trimmed focus from ${items.length} to 5 items`);
          }
        }

        return { skillResult, assistantResult, proactiveResult, questionResult, longResult };
      });

      const { skillResult, assistantResult, proactiveResult, questionResult, longResult } = migrate();
      const total = skillResult.changes + assistantResult.changes + proactiveResult.changes + questionResult.changes + longResult.changes;
      if (total > 0) {
        console.log(`[memory-cleanup] Archived ${total} polluted entries: ${skillResult.changes} skill outputs, ${assistantResult.changes} long assistant responses, ${proactiveResult.changes} proactive messages, ${questionResult.changes} questions, ${longResult.changes} oversized entries`);
      }
    } catch (error) {
      // Migration failure is non-fatal but log for debugging
      if (error instanceof Error) {
        console.warn(`[migration] migrateCleanPollutedMemories: ${error.message}`);
      }
    }
  }

  /**
   * Add kind and task_config columns to scheduled_items table if they don't exist.
   * Backfills event_prep items as kind='task'.
   */
  private migrateAddKindColumn(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddKindColumn',
      [
        ['kind', "TEXT NOT NULL DEFAULT 'nudge'"],
        ['task_config', 'TEXT DEFAULT NULL'],
      ],
      () => {
        // Backfill: event_prep items become tasks.
        this.db.exec("UPDATE scheduled_items SET kind = 'task' WHERE type = 'event_prep'");
      },
    );
  }

  /**
   * Add fail-closed message authorship provenance. Existing rows cannot prove
   * they contain text literally supplied by a user, so the default/backfill is
   * deliberately `generated`.
   */
  private migrateAddScheduledMessageProvenance(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddScheduledMessageProvenance',
      [[
        'message_provenance',
        "TEXT NOT NULL DEFAULT 'generated' CHECK (message_provenance IN ('user_literal', 'generated'))",
      ]],
      undefined,
      columns => {
        const provenance = columns.get('message_provenance')!;
        const defaultValue = provenance.dflt_value?.trim();
        if (
          provenance.type.trim().toUpperCase() !== 'TEXT'
          || provenance.notnull !== 1
          || (defaultValue !== "'generated'" && defaultValue !== '"generated"')
        ) {
          throw new Error(
            'scheduled_items.message_provenance has an incompatible schema; '
            + "expected TEXT NOT NULL DEFAULT 'generated'",
          );
        }

        const invalid = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM scheduled_items
          WHERE message_provenance IS NULL
             OR message_provenance NOT IN ('user_literal', 'generated')
        `).get() as { count: number };
        if (invalid.count > 0) {
          throw new Error(
            `scheduled_items.message_provenance contains ${invalid.count} invalid value(s)`,
          );
        }
      },
    );
  }

  /**
   * Add board columns to scheduled_items table if they don't exist.
   * Adds: board_status, priority, labels, result, depends_on, goal_id
   */
  private migrateAddBoardColumns(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddBoardColumns',
      [
        ['board_status', 'TEXT DEFAULT NULL'],
        ['priority', "TEXT DEFAULT 'medium'"],
        ['labels', 'TEXT DEFAULT NULL'],
        ['result', 'TEXT DEFAULT NULL'],
        ['depends_on', 'TEXT DEFAULT NULL'],
        ['goal_id', 'TEXT DEFAULT NULL'],
      ],
      () => {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_board ON scheduled_items(user_id, board_status)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_priority ON scheduled_items(priority)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_goal ON scheduled_items(goal_id)');
        this.db.exec(`
          UPDATE scheduled_items
          SET board_status = CASE
            WHEN status = 'pending' AND trigger_at > 0 THEN 'scheduled'
            WHEN status = 'pending' THEN 'inbox'
            WHEN status = 'processing' THEN 'in_progress'
            -- A row old enough to lack a board projection is historical. Keep
            -- its delivered lifecycle, but do not surface it as newly done or
            -- include it in a post-upgrade completion digest.
            WHEN status IN ('fired', 'acted') THEN 'archived'
            WHEN status IN ('dismissed', 'expired') THEN 'archived'
            ELSE 'inbox'
          END
          WHERE board_status IS NULL
        `);
      },
    );
  }

  /** Add first-class provenance from a generated nudge to its source board item. */
  private migrateAddScheduledSourceItem(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddScheduledSourceItem',
      [['source_item_id', 'TEXT DEFAULT NULL']],
      () => {
        // Lossless legacy backfill: only board-gap wrappers whose JSON sourceId
        // resolves to a same-owner scheduled item are linked. Memory/session IDs
        // and cross-owner references are deliberately ignored.
        this.db.exec(`
          UPDATE scheduled_items AS wrapper
          SET source_item_id = json_extract(
            CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
            '$.sourceId'
          )
          WHERE wrapper.source_item_id IS NULL
            AND wrapper.source = 'agent'
            AND json_valid(wrapper.context)
            AND json_extract(
              CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
              '$.gapType'
            ) IN ('stale_board_item', 'blocked_item')
            AND typeof(json_extract(
              CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
              '$.sourceId'
            )) = 'text'
            AND EXISTS (
              SELECT 1
              FROM scheduled_items AS source
              WHERE source.id = json_extract(
                  CASE WHEN json_valid(wrapper.context) THEN wrapper.context ELSE '{}' END,
                  '$.sourceId'
                )
                AND source.id != wrapper.id
                AND source.user_id = wrapper.user_id
            )
        `);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_source_item ON scheduled_items(source_item_id)');
      },
    );
  }

  /** Add durable worker ownership, lease, retry, and handoff fields. */
  private migrateAddBoardExecutionColumns(): void {
    this.runRequiredScheduledItemsMigration(
      'migrateAddBoardExecutionColumns',
      [
        ['worker_id', 'TEXT DEFAULT NULL'],
        ['preferred_worker_id', 'TEXT DEFAULT NULL'],
        ['lease_token', 'TEXT DEFAULT NULL'],
        ['leased_at', 'INTEGER DEFAULT NULL'],
        ['lease_expires_at', 'INTEGER DEFAULT NULL'],
        ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
        ['last_error', 'TEXT DEFAULT NULL'],
        ['handed_off_from', 'TEXT DEFAULT NULL'],
      ],
      () => {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_task_lease ON scheduled_items(kind, status, lease_expires_at)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_preferred_worker ON scheduled_items(preferred_worker_id)');
      },
      columns => {
        for (const [name, expectedDefault] of [
          ['attempt_count', '0'],
          ['max_attempts', '3'],
        ] as const) {
          const column = columns.get(name)!;
          if (
            column.type.trim().toUpperCase() !== 'INTEGER'
            || column.notnull !== 1
            || column.dflt_value?.trim() !== expectedDefault
          ) {
            throw new Error(
              `scheduled_items.${name} has an incompatible schema; `
              + `expected INTEGER NOT NULL DEFAULT ${expectedDefault}`,
            );
          }
        }
      },
    );
  }

  /**
   * Reconcile the two scheduled-item state projections without deleting or
   * reviving anything. The full pre-repair row is retained as JSON so an
   * operator can audit or restore every historical value.
   *
   * `status` is canonical. Terminal lifecycle rows can therefore never look
   * active to the board/proactive scanner. Conversely, a pending row already
   * marked terminal by the board is quarantined as expired instead of being
   * made executable again.
   */
  private migrateReconcileScheduledItemStates(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_item_state_reconciliation_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL,
          previous_status TEXT NOT NULL,
          previous_board_status TEXT,
          reconciled_status TEXT NOT NULL,
          reconciled_board_status TEXT NOT NULL,
          reason TEXT NOT NULL,
          item_snapshot TEXT NOT NULL,
          reconciled_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_state_audit_item
          ON scheduled_item_state_reconciliation_audit(item_id, reconciled_at);
      `);

      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE NOT (
          (status = 'pending' AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting'))
          OR (status = 'processing' AND board_status = 'in_progress')
          OR (status IN ('fired', 'acted') AND board_status IN ('done', 'archived'))
          OR (status IN ('dismissed', 'expired') AND board_status = 'archived')
        )
      `).all() as Record<string, unknown>[];

      const audit = this.db.prepare(`
        INSERT INTO scheduled_item_state_reconciliation_audit (
          item_id, previous_status, previous_board_status,
          reconciled_status, reconciled_board_status,
          reason, item_snapshot, reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const repair = this.db.prepare(`
        UPDATE scheduled_items
        SET status = ?, board_status = ?,
            last_error = CASE
              WHEN ? = 'quarantined_terminal_board_conflict'
                THEN COALESCE(last_error, 'Quarantined during scheduled-item state reconciliation')
              ELSE last_error
            END
        WHERE id = ?
      `);
      const now = Date.now();

      for (const row of rows) {
        const status = String(row.status);
        const boardStatus = row.board_status == null ? null : String(row.board_status);
        let reconciledStatus: ScheduledItemStatus;
        let reconciledBoardStatus: BoardStatus;
        let reason: string;

        if (status === 'processing' && boardStatus === 'done') {
          // A terminal board projection records a user/worker completion that
          // must win over a stale processing flag. Archive the historical row
          // so startup cannot execute or digest-notify it again.
          reconciledStatus = 'fired';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_processing_done_conflict';
        } else if (status === 'processing' && boardStatus === 'archived') {
          reconciledStatus = 'dismissed';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_processing_archived_conflict';
        } else if (status === 'pending' && (boardStatus === 'done' || boardStatus === 'archived')) {
          // A terminal board action must never be undone by making the row live.
          reconciledStatus = 'expired';
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_terminal_board_conflict';
        } else if (status === 'pending') {
          reconciledStatus = 'pending';
          reconciledBoardStatus = Number(row.trigger_at) > 0 ? 'scheduled' : 'inbox';
          reason = 'repaired_pending_board_projection';
        } else if (status === 'processing') {
          // Keep in-flight/leased work in-flight; never expire or requeue it here.
          reconciledStatus = 'processing';
          reconciledBoardStatus = 'in_progress';
          reason = 'repaired_processing_board_projection';
        } else if (status === 'fired' || status === 'acted') {
          reconciledStatus = status;
          // A legacy completed row in an active-looking column is historical,
          // not newly completed. Archive it so startup cannot re-notify it in
          // a morning digest. The fired/acted delivery record remains intact.
          reconciledBoardStatus = 'archived';
          reason = 'quarantined_completed_board_conflict';
        } else {
          // Includes the real-world expired+in_progress ghost. Preserve its
          // lifecycle meaning and archive only its misleading board projection.
          reconciledStatus = status === 'dismissed' ? 'dismissed' : 'expired';
          reconciledBoardStatus = 'archived';
          reason = 'repaired_terminal_board_projection';
        }

        audit.run(
          String(row.id),
          status,
          boardStatus,
          reconciledStatus,
          reconciledBoardStatus,
          reason,
          JSON.stringify(row),
          now,
        );
        repair.run(reconciledStatus, reconciledBoardStatus, reason, row.id);
      }

      // Persisted triggers protect direct SQLite writers, including bundled
      // skills running in their own process. Completion history may be moved
      // from done to archived, but no terminal row may look active.
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_scheduled_items_state_guard_insert;
        DROP TRIGGER IF EXISTS trg_scheduled_items_state_guard_update;

        CREATE TRIGGER trg_scheduled_items_state_guard_insert
        BEFORE INSERT ON scheduled_items
        WHEN CASE NEW.status
          WHEN 'pending' THEN COALESCE(NEW.board_status, '') NOT IN ('inbox', 'backlog', 'scheduled', 'waiting')
          WHEN 'processing' THEN COALESCE(NEW.board_status, '') != 'in_progress'
          WHEN 'fired' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'acted' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'dismissed' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'expired' THEN COALESCE(NEW.board_status, '') != 'archived'
          ELSE 1
        END
        BEGIN
          SELECT RAISE(ABORT, 'scheduled_items status/board_status invariant violation');
        END;

        CREATE TRIGGER trg_scheduled_items_state_guard_update
        BEFORE UPDATE OF status, board_status ON scheduled_items
        WHEN CASE NEW.status
          WHEN 'pending' THEN COALESCE(NEW.board_status, '') NOT IN ('inbox', 'backlog', 'scheduled', 'waiting')
          WHEN 'processing' THEN COALESCE(NEW.board_status, '') != 'in_progress'
          WHEN 'fired' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'acted' THEN COALESCE(NEW.board_status, '') NOT IN ('done', 'archived')
          WHEN 'dismissed' THEN COALESCE(NEW.board_status, '') != 'archived'
          WHEN 'expired' THEN COALESCE(NEW.board_status, '') != 'archived'
          ELSE 1
        END
        BEGIN
          SELECT RAISE(ABORT, 'scheduled_items status/board_status invariant violation');
        END;
      `);
    });

    migrate.immediate();
  }

  /**
   * Apply a runtime-required scheduled_items column group atomically. Required
   * schema migrations intentionally abort startup: continuing after a failed
   * ALTER would expose application code to a partially upgraded table.
   */
  private runRequiredScheduledItemsMigration(
    name: string,
    requiredColumns: ReadonlyArray<readonly [name: string, definition: string]>,
    finalize?: () => void,
    validate?: (columns: ReadonlyMap<string, SqliteTableColumn>) => void,
  ): void {
    const migrate = this.db.transaction(() => {
      const before = this.getScheduledItemColumns();
      for (const [column, definition] of requiredColumns) {
        if (!before.has(column)) {
          this.db.exec(`ALTER TABLE scheduled_items ADD COLUMN ${column} ${definition}`);
        }
      }

      finalize?.();

      const after = this.getScheduledItemColumns();
      const missing = requiredColumns
        .map(([column]) => column)
        .filter(column => !after.has(column));
      if (missing.length > 0) {
        throw new Error(`scheduled_items is missing required column(s): ${missing.join(', ')}`);
      }
      validate?.(after);
    });

    try {
      migrate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[migration] ${name} failed: ${detail}`, { cause: error });
    }
  }

  private getScheduledItemColumns(): ReadonlyMap<string, SqliteTableColumn> {
    const rows = this.db.prepare('PRAGMA table_info(scheduled_items)').all() as SqliteTableColumn[];
    return new Map(rows.map(column => [column.name, column]));
  }

  /**
   * Create FTS5 virtual table for transcript chunk full-text search
   */
  private migrateCreateTranscriptFTS(): void {
    try {
      // FTS5 content table for BM25 keyword search over transcript chunks
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_chunks_fts
        USING fts5(content, content_rowid='rowid');
      `);
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`[migration] migrateCreateTranscriptFTS: ${error.message}`);
      }
    }
  }

  private migrateAddLlmTraceMetadataColumns(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(llm_traces)").all() as Array<{ name: string }>;
      const columns = new Set(tableInfo.map((c) => c.name));
      const additions: Array<[string, string]> = [
        ['stop_reason', 'TEXT'],
        ['request_max_tokens', 'INTEGER'],
        ['model_context_window_tokens', 'INTEGER'],
        ['model_max_output_tokens', 'INTEGER'],
      ];
      for (const [column, type] of additions) {
        if (!columns.has(column)) {
          this.db.exec(`ALTER TABLE llm_traces ADD COLUMN ${column} ${type}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`[migration] migrateAddLlmTraceMetadataColumns: ${error.message}`);
      }
    }
  }

  // ============ Memory CRUD Operations ============

  /**
   * Add a new memory
   */
  addMemory(memory: Omit<ScallopMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): ScallopMemoryEntry {
    const id = nanoid();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_id, content, category, memory_type, importance, confidence, is_latest,
        source, document_date, event_date, prominence, last_accessed, access_count,
        source_chunk, embedding, metadata, learned_from, times_confirmed, contradiction_ids,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?
      )
    `);

    stmt.run(
      id,
      memory.userId,
      memory.content,
      memory.category,
      memory.memoryType,
      memory.importance,
      memory.confidence,
      memory.isLatest ? 1 : 0,
      memory.source || 'user',
      memory.documentDate,
      memory.eventDate,
      memory.prominence,
      memory.lastAccessed,
      memory.accessCount,
      memory.sourceChunk,
      memory.embedding ? JSON.stringify(memory.embedding) : null,
      memory.metadata ? JSON.stringify(memory.metadata) : null,
      memory.learnedFrom || 'conversation',
      memory.timesConfirmed || 1,
      memory.contradictionIds ? JSON.stringify(memory.contradictionIds) : null,
      now,
      now
    );

    if (memory.embedding) {
      this.replaceEmbeddingLsh(id, memory.userId, memory.embedding);
    }

    return { ...memory, id, createdAt: now, updatedAt: now };
  }

  /**
   * Get a memory by ID
   */
  getMemory(id: string): ScallopMemoryEntry | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  /**
   * Update a memory
   */
  updateMemory(id: string, updates: Partial<ScallopMemoryEntry>): boolean {
    const memory = this.getMemory(id);
    if (!memory) return false;

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE memories SET
        content = COALESCE(?, content),
        category = COALESCE(?, category),
        memory_type = COALESCE(?, memory_type),
        importance = COALESCE(?, importance),
        confidence = COALESCE(?, confidence),
        is_latest = COALESCE(?, is_latest),
        event_date = COALESCE(?, event_date),
        prominence = COALESCE(?, prominence),
        last_accessed = COALESCE(?, last_accessed),
        access_count = COALESCE(?, access_count),
        source_chunk = COALESCE(?, source_chunk),
        embedding = COALESCE(?, embedding),
        metadata = COALESCE(?, metadata),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.content ?? null,
      updates.category ?? null,
      updates.memoryType ?? null,
      updates.importance ?? null,
      updates.confidence ?? null,
      updates.isLatest !== undefined ? (updates.isLatest ? 1 : 0) : null,
      updates.eventDate ?? null,
      updates.prominence ?? null,
      updates.lastAccessed ?? null,
      updates.accessCount ?? null,
      updates.sourceChunk ?? null,
      updates.embedding ? JSON.stringify(updates.embedding) : null,
      updates.metadata ? JSON.stringify(updates.metadata) : null,
      now,
      id
    );

    if (updates.embedding) {
      this.replaceEmbeddingLsh(id, memory.userId, updates.embedding);
    }

    return true;
  }

  /**
   * Delete a memory
   */
  deleteMemory(id: string): boolean {
    this.db.prepare('DELETE FROM memory_embedding_lsh WHERE memory_id = ?').run(id);
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get memories by user ID
   */
  getMemoriesByUser(
    userId: string,
    options: {
      category?: MemoryCategory;
      memoryType?: ScallopMemoryType;
      minProminence?: number;
      isLatest?: boolean;
      limit?: number;
      offset?: number;
      /** If true, include all sources. Default: false (exclude skill outputs and long assistant responses). */
      includeAllSources?: boolean;
    } = {}
  ): ScallopMemoryEntry[] {
    let query = 'SELECT * FROM memories WHERE user_id = ?';
    const params: unknown[] = [userId];

    // By default, only include user-extracted facts (exclude skill outputs, assistant responses, system entries)
    if (!options.includeAllSources) {
      query += " AND source = 'user'";
    }

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }
    if (options.memoryType) {
      query += ' AND memory_type = ?';
      params.push(options.memoryType);
    }
    if (options.minProminence !== undefined) {
      query += ' AND prominence >= ?';
      params.push(options.minProminence);
    }
    // Default to is_latest=1 so superseded rows don't leak into normal retrieval.
    // Callers that need superseded rows (decay, cleanup) pass isLatest: false.
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY prominence DESC, document_date DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Get memories stored within a recent time window (short-term memory buffer).
   * Returns memories ordered by recency (newest first).
   */
  getRecentMemories(
    userId: string,
    windowMs: number,
    options: { isLatest?: boolean } = {}
  ): ScallopMemoryEntry[] {
    const cutoff = Date.now() - windowMs;
    let query = 'SELECT * FROM memories WHERE user_id = ? AND document_date >= ?';
    const params: unknown[] = [userId, cutoff];

    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY document_date DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Get all memories
   */
  getAllMemories(options: { limit?: number; minProminence?: number } = {}): ScallopMemoryEntry[] {
    let query = 'SELECT * FROM memories';
    const params: unknown[] = [];

    if (options.minProminence !== undefined) {
      query += ' WHERE prominence >= ?';
      params.push(options.minProminence);
    }

    query += ' ORDER BY prominence DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemory(row));
  }

  // ============ Light (no-embedding) Memory Queries ============

  /** All columns except `embedding` — avoids loading & JSON-parsing 768-dim vectors */
  private static readonly LIGHT_COLUMNS = [
    'id', 'user_id', 'content', 'category', 'memory_type', 'importance',
    'confidence', 'is_latest', 'source', 'document_date', 'event_date',
    'prominence', 'last_accessed', 'access_count', 'source_chunk',
    'metadata', 'learned_from', 'times_confirmed', 'contradiction_ids',
    'created_at', 'updated_at',
  ].join(', ');

  /** Convert a row (without embedding column) to ScallopMemoryEntryLight */
  private rowToMemoryLight(row: Record<string, unknown>): ScallopMemoryEntryLight {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      content: row.content as string,
      category: row.category as MemoryCategory,
      memoryType: row.memory_type as ScallopMemoryType,
      importance: row.importance as number,
      confidence: row.confidence as number,
      isLatest: (row.is_latest as number) === 1,
      source: (row.source as 'user' | 'assistant') || 'user',
      documentDate: row.document_date as number,
      eventDate: row.event_date as number | null,
      prominence: row.prominence as number,
      lastAccessed: row.last_accessed as number | null,
      accessCount: row.access_count as number,
      sourceChunk: row.source_chunk as string | null,
      embedding: null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      learnedFrom: (row.learned_from as string) || 'conversation',
      timesConfirmed: (row.times_confirmed as number) || 1,
      contradictionIds: row.contradiction_ids ? JSON.parse(row.contradiction_ids as string) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Light version of getMemoriesByUser — excludes embedding column.
   */
  getMemoriesByUserLight(
    userId: string,
    options: {
      category?: MemoryCategory;
      memoryType?: ScallopMemoryType;
      minProminence?: number;
      isLatest?: boolean;
      limit?: number;
      offset?: number;
      includeAllSources?: boolean;
    } = {}
  ): ScallopMemoryEntryLight[] {
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories WHERE user_id = ?`;
    const params: unknown[] = [userId];

    if (!options.includeAllSources) {
      query += " AND source = 'user'";
    }
    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }
    if (options.memoryType) {
      query += ' AND memory_type = ?';
      params.push(options.memoryType);
    }
    if (options.minProminence !== undefined) {
      query += ' AND prominence >= ?';
      params.push(options.minProminence);
    }
    // Default is_latest=1 filter — keeps superseded rows out of retrieval.
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY prominence DESC, document_date DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Light version of getRecentMemories — excludes embedding column.
   */
  getRecentMemoriesLight(
    userId: string,
    windowMs: number,
    options: { isLatest?: boolean } = {}
  ): ScallopMemoryEntryLight[] {
    const cutoff = Date.now() - windowMs;
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories WHERE user_id = ? AND document_date >= ?`;
    const params: unknown[] = [userId, cutoff];

    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
    } else {
      query += ' AND is_latest = 1';
    }

    query += ' ORDER BY document_date DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Light version of getAllMemories — excludes embedding column.
   */
  getAllMemoriesLight(options: { limit?: number; minProminence?: number } = {}): ScallopMemoryEntryLight[] {
    let query = `SELECT ${ScallopDatabase.LIGHT_COLUMNS} FROM memories`;
    const params: unknown[] = [];

    if (options.minProminence !== undefined) {
      query += ' WHERE prominence >= ?';
      params.push(options.minProminence);
    }

    query += ' ORDER BY prominence DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToMemoryLight(row));
  }

  /**
   * Load only id + embedding for a set of memory IDs.
   * Returns a Map<id, number[]> (entries without embeddings are omitted).
   */
  getEmbeddingsByIds(ids: string[]): Map<string, number[]> {
    if (ids.length === 0) return new Map();

    const result = new Map<string, number[]>();
    // Stay below SQLite's variable limit. Hybrid retrieval may scan the full
    // filtered corpus to form an independent semantic top-K, which can exceed
    // the old single-query limit on established installations.
    const SQLITE_ID_BATCH_SIZE = 500;
    for (let offset = 0; offset < ids.length; offset += SQLITE_ID_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + SQLITE_ID_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `SELECT id, embedding FROM memories WHERE id IN (${placeholders})`
      );
      const rows = stmt.all(...batch) as Array<{ id: string; embedding: string | null }>;

      for (const row of rows) {
        if (row.embedding) {
          try {
            const parsed = JSON.parse(row.embedding) as unknown;
            if (Array.isArray(parsed) && parsed.every(value => typeof value === 'number' && Number.isFinite(value))) {
              result.set(row.id, parsed);
            }
          } catch {
            // Isolate a malformed legacy row instead of failing the whole
            // lexical/semantic union query.
          }
        }
      }
    }
    return result;
  }

  /**
   * Return a bounded, indexed set of approximate semantic neighbours.
   * Results with more LSH collisions rank first; exact-bucket collisions have
   * twice the weight of the bounded Hamming-neighbour probes.
   */
  getSemanticCandidateIds(
    queryEmbedding: number[],
    options: SemanticCandidateOptions,
  ): string[] {
    if (
      queryEmbedding.length === 0 ||
      !Number.isFinite(options.maxCandidates) ||
      options.maxCandidates <= 0
    ) return [];

    const probes = buildSemanticLshProbes(queryEmbedding);

    const requestedLimit = Math.min(
      SEMANTIC_CANDIDATE_LIMIT,
      Math.max(1, Math.floor(options.maxCandidates)),
    );

    // ScallopMemoryStore already has a filtered light corpus for BM25. Reuse it
    // when supplied. Direct database callers get the same behavior through one
    // light metadata query, rather than repeating a memories-table join for all
    // 48 LSH probes (the source of the prior 10k-corpus latency regression).
    let eligibleIds = options.eligibleIds;
    let priorities = options.candidatePriorities;
    if (!eligibleIds) {
      let eligibleSql = 'SELECT id, prominence, document_date FROM memories WHERE 1 = 1';
      const eligibleParams: unknown[] = [];
      if (options.userId) {
        eligibleSql += ' AND user_id = ?';
        eligibleParams.push(options.userId);
      }
      if (options.category) {
        eligibleSql += ' AND category = ?';
        eligibleParams.push(options.category);
      }
      if (options.minProminence !== undefined) {
        eligibleSql += ' AND prominence >= ?';
        eligibleParams.push(options.minProminence);
      }
      if (options.isLatest !== undefined) {
        eligibleSql += ' AND is_latest = ?';
        eligibleParams.push(options.isLatest ? 1 : 0);
      }
      if (options.eventDateRange) {
        eligibleSql += ' AND event_date BETWEEN ? AND ?';
        eligibleParams.push(options.eventDateRange.start, options.eventDateRange.end);
      }
      if (options.documentDateRange) {
        eligibleSql += ' AND document_date BETWEEN ? AND ?';
        eligibleParams.push(options.documentDateRange.start, options.documentDateRange.end);
      }
      const eligibleRows = this.db.prepare(eligibleSql).all(...eligibleParams) as Array<{
        id: string;
        prominence: number;
        document_date: number;
      }>;
      eligibleIds = new Set(eligibleRows.map((row) => row.id));
      priorities = new Map(eligibleRows.map((row) => [row.id, {
        prominence: row.prominence,
        documentDate: row.document_date,
      }]));
    }

    // UNION ALL keeps each probe as an explicit integer-index range scan while
    // crossing the JS/native boundary once. A VALUES CTE looks tidier but SQLite
    // materializes a slow nested join for this workload.
    const perProbeLimit = Math.max(64, requestedLimit);
    const userFilter = options.userId ? ' AND user_id = ?' : '';
    const probeSql = `
      SELECT memory_id, ? AS weight
      FROM memory_embedding_lsh INDEXED BY idx_memory_lsh_lookup
      WHERE index_version = ? AND dimension = ? AND table_id = ? AND bucket = ?
        ${userFilter}
      LIMIT ?
    `;
    const lookup = this.db.prepare(
      probes.map(() => `SELECT * FROM (${probeSql})`).join(' UNION ALL '),
    );
    const ranked = new Map<string, {
      score: number;
      prominence: number;
      documentDate: number;
    }>();

    const rows = lookup.all(
      ...probes.flatMap((probe) => [
        probe.weight,
        SEMANTIC_LSH_VERSION,
        queryEmbedding.length,
        probe.tableId,
        probe.bucket,
        ...(options.userId ? [options.userId] : []),
        perProbeLimit,
      ]),
    ) as Array<{ memory_id: string; weight: number }>;
    for (const row of rows) {
      if (!eligibleIds.has(row.memory_id)) continue;
      const existing = ranked.get(row.memory_id);
      if (existing) {
        existing.score += row.weight;
      } else {
        ranked.set(row.memory_id, {
          score: row.weight,
          prominence: priorities?.get(row.memory_id)?.prominence ?? 0,
          documentDate: priorities?.get(row.memory_id)?.documentDate ?? 0,
        });
      }
    }

    return [...ranked]
      .sort(([, a], [, b]) =>
        b.score - a.score ||
        b.prominence - a.prominence ||
        b.documentDate - a.documentDate)
      .slice(0, requestedLimit)
      .map(([id]) => id);
  }

  /**
   * Bump confirmation count and boost confidence/prominence for a re-stated fact.
   */
  reinforceMemory(id: string, confidenceBoost: number = 0.05, prominenceBoost: number = 0.1): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE memories SET
        times_confirmed = times_confirmed + 1,
        confidence = MIN(1.0, confidence + ?),
        prominence = MIN(1.0, prominence + ?),
        updated_at = ?
      WHERE id = ?
    `).run(confidenceBoost, prominenceBoost, now, id);
  }

  /**
   * Add contradiction IDs to a memory.
   */
  addContradiction(memoryId: string, contradictingId: string): void {
    const memory = this.getMemory(memoryId);
    if (!memory) return;

    const existing = memory.contradictionIds || [];
    if (!existing.includes(contradictingId)) {
      existing.push(contradictingId);
      const now = Date.now();
      this.db.prepare(
        'UPDATE memories SET contradiction_ids = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(existing), now, memoryId);
    }
  }

  /**
   * Record memory access (for decay system)
   */
  recordAccess(id: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE memories SET
        last_accessed = ?,
        access_count = access_count + 1,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, now, id);
  }

  /**
   * Update prominence for all memories (batch)
   */
  updateProminences(updates: Array<{ id: string; prominence: number }>): void {
    // Don't update updated_at — prominence decay is a system maintenance operation,
    // not a user interaction. Preserves updated_at for staleness detection.
    const stmt = this.db.prepare('UPDATE memories SET prominence = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const { id, prominence } of updates) {
        stmt.run(prominence, id);
      }
    });

    transaction();
  }

  // ============ Relationship Operations ============

  /**
   * Add a relationship between memories
   */
  addRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    confidence: number = 0.8
  ): MemoryRelation {
    const id = nanoid();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO memory_relations (id, source_id, target_id, relation_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, sourceId, targetId, relationType, confidence, now);

    // UPDATES relation records the link but keeps both memories searchable.
    // Superseding loses specific details that retrieval needs.

    return { id, sourceId, targetId, relationType, confidence, createdAt: now };
  }

  /**
   * Get relations for a memory (both incoming and outgoing)
   */
  getRelations(memoryId: string): MemoryRelation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_relations
      WHERE source_id = ? OR target_id = ?
    `);
    const rows = stmt.all(memoryId, memoryId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get outgoing relations from a memory
   */
  getOutgoingRelations(memoryId: string, relationType?: RelationType): MemoryRelation[] {
    let query = 'SELECT * FROM memory_relations WHERE source_id = ?';
    const params: unknown[] = [memoryId];

    if (relationType) {
      query += ' AND relation_type = ?';
      params.push(relationType);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get incoming relations to a memory
   */
  getIncomingRelations(memoryId: string, relationType?: RelationType): MemoryRelation[] {
    let query = 'SELECT * FROM memory_relations WHERE target_id = ?';
    const params: unknown[] = [memoryId];

    if (relationType) {
      query += ' AND relation_type = ?';
      params.push(relationType);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Get all relations
   */
  getAllRelations(): MemoryRelation[] {
    const stmt = this.db.prepare('SELECT * FROM memory_relations');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  /**
   * Delete a relation
   */
  deleteRelation(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM memory_relations WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ============ User Profile Operations ============

  /**
   * Set a static profile value
   */
  setProfileValue(userId: string, key: string, value: string, confidence: number = 0.9): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO user_profiles (user_id, key, value, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `);
    stmt.run(userId, key, value, confidence, now);
  }

  /**
   * Get a static profile value
   */
  getProfileValue(userId: string, key: string): UserProfileEntry | null {
    const stmt = this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ? AND key = ?');
    const row = stmt.get(userId, key) as Record<string, unknown> | undefined;
    return row ? this.rowToProfileEntry(row) : null;
  }

  /**
   * Get all static profile values for a user
   */
  getProfile(userId: string): UserProfileEntry[] {
    const stmt = this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ?');
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToProfileEntry(row));
  }

  /**
   * Delete a static profile value
   */
  deleteProfileValue(userId: string, key: string): boolean {
    const stmt = this.db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND key = ?');
    const result = stmt.run(userId, key);
    return result.changes > 0;
  }

  // ============ Dynamic Profile Operations ============

  /**
   * Update dynamic profile
   */
  updateDynamicProfile(userId: string, profile: Partial<Omit<DynamicProfile, 'userId'>>): void {
    const now = Date.now();

    // Check if exists
    const existing = this.db.prepare('SELECT * FROM dynamic_profiles WHERE user_id = ?').get(userId);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE dynamic_profiles SET
          recent_topics = COALESCE(?, recent_topics),
          current_mood = COALESCE(?, current_mood),
          active_projects = COALESCE(?, active_projects),
          last_interaction = ?
        WHERE user_id = ?
      `);
      stmt.run(
        profile.recentTopics ? JSON.stringify(profile.recentTopics) : null,
        profile.currentMood ?? null,
        profile.activeProjects ? JSON.stringify(profile.activeProjects) : null,
        now,
        userId
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO dynamic_profiles (user_id, recent_topics, current_mood, active_projects, last_interaction)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        userId,
        profile.recentTopics ? JSON.stringify(profile.recentTopics) : '[]',
        profile.currentMood ?? null,
        profile.activeProjects ? JSON.stringify(profile.activeProjects) : '[]',
        now
      );
    }
  }

  /**
   * Get dynamic profile
   */
  getDynamicProfile(userId: string): DynamicProfile | null {
    const stmt = this.db.prepare('SELECT * FROM dynamic_profiles WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToDynamicProfile(row) : null;
  }

  // ============ Behavioral Patterns Operations ============

  /**
   * Update behavioral patterns.
   * Signal fields (messageFrequency, sessionEngagement, topicSwitch, responseLength)
   * are stored inside the response_preferences JSON column to avoid schema migration.
   */
  updateBehavioralPatterns(userId: string, patterns: Partial<Omit<BehavioralPatterns, 'userId' | 'updatedAt'>>): void {
    const now = Date.now();

    // Merge signal fields into responsePreferences JSON for storage
    const responsePrefsToStore: Record<string, unknown> = {
      ...(patterns.responsePreferences ?? {}),
    };
    if (patterns.messageFrequency !== undefined) {
      responsePrefsToStore._sig_messageFrequency = patterns.messageFrequency;
    }
    if (patterns.sessionEngagement !== undefined) {
      responsePrefsToStore._sig_sessionEngagement = patterns.sessionEngagement;
    }
    if (patterns.topicSwitch !== undefined) {
      responsePrefsToStore._sig_topicSwitch = patterns.topicSwitch;
    }
    if (patterns.responseLength !== undefined) {
      responsePrefsToStore._sig_responseLength = patterns.responseLength;
    }
    if (patterns.affectState !== undefined) {
      responsePrefsToStore.affectState = patterns.affectState;
    }
    if (patterns.smoothedAffect !== undefined) {
      responsePrefsToStore.smoothedAffect = patterns.smoothedAffect;
    }

    const existing = this.db.prepare('SELECT * FROM behavioral_patterns WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;

    if (existing) {
      // Merge signal fields with existing response_preferences
      const existingPrefs: Record<string, unknown> = existing.response_preferences
        ? JSON.parse(existing.response_preferences as string)
        : {};
      const mergedPrefs = { ...existingPrefs, ...responsePrefsToStore };

      const stmt = this.db.prepare(`
        UPDATE behavioral_patterns SET
          communication_style = COALESCE(?, communication_style),
          expertise_areas = COALESCE(?, expertise_areas),
          response_preferences = ?,
          active_hours = COALESCE(?, active_hours),
          updated_at = ?
        WHERE user_id = ?
      `);
      stmt.run(
        patterns.communicationStyle ?? null,
        patterns.expertiseAreas ? JSON.stringify(patterns.expertiseAreas) : null,
        JSON.stringify(mergedPrefs),
        patterns.activeHours ? JSON.stringify(patterns.activeHours) : null,
        now,
        userId
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO behavioral_patterns (user_id, communication_style, expertise_areas, response_preferences, active_hours, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        userId,
        patterns.communicationStyle ?? null,
        patterns.expertiseAreas ? JSON.stringify(patterns.expertiseAreas) : '[]',
        Object.keys(responsePrefsToStore).length > 0 ? JSON.stringify(responsePrefsToStore) : '{}',
        patterns.activeHours ? JSON.stringify(patterns.activeHours) : '[]',
        now
      );
    }
  }

  /**
   * Get behavioral patterns
   */
  getBehavioralPatterns(userId: string): BehavioralPatterns | null {
    const stmt = this.db.prepare('SELECT * FROM behavioral_patterns WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToBehavioralPatterns(row) : null;
  }

  // ============ Session Operations ============

  createSession(id: string, metadata?: Record<string, unknown>): SessionRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, metadata, input_tokens, output_tokens, created_at, updated_at)
      VALUES (?, ?, 0, 0, ?, ?)
    `);
    stmt.run(id, metadata ? JSON.stringify(metadata) : null, now, now);
    return { id, metadata: metadata || null, inputTokens: 0, outputTokens: 0, createdAt: now, updatedAt: now };
  }

  getSession(id: string): SessionRow | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  deleteSession(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  listSessions(limit?: number, offset?: number): SessionRow[] {
    let query = 'SELECT * FROM sessions ORDER BY updated_at DESC';
    const params: unknown[] = [];
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }
    if (offset) {
      query += ' OFFSET ?';
      params.push(offset);
    }
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToSession(row));
  }

  updateSessionMetadata(id: string, metadata: Record<string, unknown>): void {
    const now = Date.now();
    // Merge with existing metadata
    const existing = this.getSession(id);
    const merged = { ...(existing?.metadata || {}), ...metadata };
    this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), now, id);
  }

  updateSessionTokenUsage(id: string, inputTokens: number, outputTokens: number): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE sessions SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        updated_at = ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, now, id);
  }

  addSessionMessage(sessionId: string, role: string, content: string): SessionMessageRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(sessionId, role, content, now);
    // Update session updated_at
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return { id: Number(result.lastInsertRowid), sessionId, role, content, createdAt: now };
  }

  getSessionMessages(sessionId: string): SessionMessageRow[] {
    const stmt = this.db.prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY id');
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionMessage(row));
  }

  getSessionMessagesPaginated(sessionId: string, limit: number, before?: number): { messages: SessionMessageRow[]; hasMore: boolean } {
    let rows: Record<string, unknown>[];
    if (before) {
      const stmt = this.db.prepare(
        'SELECT * FROM session_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
      );
      rows = stmt.all(sessionId, before, limit + 1) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
      );
      rows = stmt.all(sessionId, limit + 1) as Record<string, unknown>[];
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return { messages: rows.map(row => this.rowToSessionMessage(row)), hasMore };
  }

  /** Get paginated messages across ALL sessions (cross-channel unified history) */
  getAllMessagesPaginated(limit: number, before?: number): { messages: SessionMessageRow[]; hasMore: boolean } {
    let rows: Record<string, unknown>[];
    if (before) {
      const stmt = this.db.prepare(
        'SELECT * FROM session_messages WHERE id < ? ORDER BY id DESC LIMIT ?'
      );
      rows = stmt.all(before, limit + 1) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM session_messages ORDER BY id DESC LIMIT ?'
      );
      rows = stmt.all(limit + 1) as Record<string, unknown>[];
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return { messages: rows.map(row => this.rowToSessionMessage(row)), hasMore };
  }

  /**
   * Get recent messages belonging to one user across their sessions.
   *
   * Session messages do not carry a user_id themselves; the owning session
   * does. Callers may supply an explicit set of channel aliases belonging to
   * the same durable state owner. `default` is never a wildcard.
   */
  getRecentMessagesByUserId(
    userId: string,
    limit: number,
    identityCandidates?: readonly string[],
  ): SessionMessageRow[] {
    const candidates = [...new Set(
      (identityCandidates?.length ? identityCandidates : [userId])
        .map(candidate => candidate.trim())
        .filter(Boolean),
    )];
    if (candidates.length === 0) return [];
    const placeholders = candidates.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT sm.*
      FROM session_messages sm
      INNER JOIN sessions s ON s.id = sm.session_id
      WHERE json_extract(s.metadata, '$.userId') IN (${placeholders})
      ORDER BY sm.id DESC
      LIMIT ?
    `);
    const rows = stmt.all(...candidates, limit) as Record<string, unknown>[];
    rows.reverse();
    return rows.map(row => this.rowToSessionMessage(row));
  }

  findSessionByUserId(userId: string): SessionRow | null {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE json_extract(metadata, '$.userId') = ? ORDER BY updated_at DESC LIMIT 1"
    );
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  // ============ Session Summary Operations ============

  addSessionSummary(summary: Omit<SessionSummaryRow, 'id' | 'createdAt'>): SessionSummaryRow {
    const id = nanoid();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO session_summaries (id, session_id, user_id, summary, topics, message_count, duration_ms, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      summary.sessionId,
      summary.userId,
      summary.summary,
      JSON.stringify(summary.topics),
      summary.messageCount,
      summary.durationMs,
      summary.embedding ? JSON.stringify(summary.embedding) : null,
      now
    );

    return { ...summary, id, createdAt: now };
  }

  getSessionSummary(sessionId: string): SessionSummaryRow | null {
    const row = this.db.prepare(
      'SELECT * FROM session_summaries WHERE session_id = ?'
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.rowToSessionSummary(row) : null;
  }

  getSessionSummariesByUser(userId: string, limit: number = 20): SessionSummaryRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM session_summaries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionSummary(row));
  }

  getAllSessionSummaries(limit: number = 50): SessionSummaryRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToSessionSummary(row));
  }

  getSessionSummaryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
    return row.count;
  }

  private rowToSessionSummary(row: Record<string, unknown>): SessionSummaryRow {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: row.user_id as string,
      summary: row.summary as string,
      topics: row.topics ? JSON.parse(row.topics as string) : [],
      messageCount: row.message_count as number,
      durationMs: row.duration_ms as number,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
      createdAt: row.created_at as number,
    };
  }

  /**
   * Delete sessions (and their messages) older than maxAgeDays.
   * Returns the number of sessions deleted.
   */
  pruneOldSessions(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    // Delete messages first (foreign key not enforced in SQLite by default)
    this.db.prepare(
      'DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE updated_at < ?)'
    ).run(cutoff);
    const result = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff);
    return result.changes;
  }

  /**
   * Delete archived/dormant memories with prominence below threshold.
   * Returns the number of memories deleted.
   */
  pruneArchivedMemories(maxProminence: number = 0.01): number {
    // Also clean up relations pointing to deleted memories
    const ids = this.db.prepare(
      'SELECT id FROM memories WHERE prominence < ? AND is_latest = 0'
    ).all(maxProminence) as Array<{ id: string }>;
    if (ids.length === 0) return 0;

    const idList = ids.map(r => r.id);
    for (const id of idList) {
      this.db.prepare('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
    }
    const result = this.db.prepare(
      `DELETE FROM memories WHERE prominence < ? AND is_latest = 0`
    ).run(maxProminence);
    return result.changes;
  }

  // ============ Bot Config Operations ============

  getBotConfig(userId: string): BotConfigRow | null {
    const stmt = this.db.prepare('SELECT * FROM bot_config WHERE user_id = ?');
    const row = stmt.get(userId) as Record<string, unknown> | undefined;
    return row ? this.rowToBotConfig(row) : null;
  }

  upsertBotConfig(userId: string, config: Partial<Omit<BotConfigRow, 'userId'>>): BotConfigRow {
    const now = new Date().toISOString();
    const existing = this.getBotConfig(userId);

    if (existing) {
      this.db.prepare(`
        UPDATE bot_config SET
          bot_name = COALESCE(?, bot_name),
          personality_id = COALESCE(?, personality_id),
          custom_personality = ?,
          model_id = COALESCE(?, model_id),
          timezone = COALESCE(?, timezone),
          onboarding_complete = COALESCE(?, onboarding_complete),
          onboarding_step = COALESCE(?, onboarding_step),
          updated_at = ?
        WHERE user_id = ?
      `).run(
        config.botName ?? null,
        config.personalityId ?? null,
        config.customPersonality !== undefined ? config.customPersonality : existing.customPersonality,
        config.modelId ?? null,
        config.timezone ?? null,
        config.onboardingComplete !== undefined ? (config.onboardingComplete ? 1 : 0) : null,
        config.onboardingStep ?? null,
        now,
        userId
      );
      return this.getBotConfig(userId)!;
    }

    this.db.prepare(`
      INSERT INTO bot_config (user_id, bot_name, personality_id, custom_personality, model_id, timezone, onboarding_complete, onboarding_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      config.botName ?? 'ScallopBot',
      config.personalityId ?? 'friendly',
      config.customPersonality ?? null,
      config.modelId ?? 'moonshot-v1-128k',
      config.timezone ?? 'UTC',
      config.onboardingComplete ? 1 : 0,
      config.onboardingStep ?? 'welcome',
      config.createdAt ?? now,
      now
    );
    return this.getBotConfig(userId)!;
  }

  deleteBotConfig(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM bot_config WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  // ============ Cost Usage Operations ============

  recordCostUsage(record: Omit<CostUsageRow, 'id'>): CostUsageRow {
    const stmt = this.db.prepare(`
      INSERT INTO cost_usage (model, provider, session_id, input_tokens, output_tokens, cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.model, record.provider, record.sessionId,
      record.inputTokens, record.outputTokens, record.cost, record.timestamp
    );
    return { ...record, id: Number(result.lastInsertRowid) };
  }

  getCostUsageSince(sinceMs: number): CostUsageRow[] {
    const stmt = this.db.prepare('SELECT * FROM cost_usage WHERE timestamp >= ? ORDER BY timestamp');
    const rows = stmt.all(sinceMs) as Record<string, unknown>[];
    return rows.map(row => this.rowToCostUsage(row));
  }

  getCostUsageBySession(sessionId: string): CostUsageRow[] {
    const stmt = this.db.prepare('SELECT * FROM cost_usage WHERE session_id = ? ORDER BY timestamp');
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map(row => this.rowToCostUsage(row));
  }

  // ============ Scheduled Items (Unified Triggers + Reminders) ============

  /**
   * Add a scheduled item (trigger or reminder)
   * Status defaults to 'pending' if not specified
   */
  addScheduledItem(item: Omit<ScheduledItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'firedAt' | 'kind' | 'taskConfig' | 'boardStatus' | 'priority' | 'labels' | 'result' | 'dependsOn' | 'goalId' | 'workerId' | 'preferredWorkerId' | 'leaseToken' | 'leasedAt' | 'leaseExpiresAt' | 'attemptCount' | 'maxAttempts' | 'lastError' | 'handedOffFrom' | 'messageProvenance' | 'sourceItemId'> & { status?: ScheduledItemStatus; kind?: ScheduledItemKind; taskConfig?: TaskConfig | null; boardStatus?: BoardStatus | null; priority?: Priority; labels?: string[] | null; dependsOn?: string[] | null; goalId?: string | null; preferredWorkerId?: string | null; maxAttempts?: number; messageProvenance?: ScheduledMessageProvenance; sourceItemId?: string | null }): ScheduledItem {
    const id = nanoid();
    const now = Date.now();
    const status = item.status ?? (
      item.boardStatus === 'in_progress' ? 'processing'
        : item.boardStatus === 'done' ? 'fired'
          : item.boardStatus === 'archived' ? 'dismissed'
            : 'pending'
    );
    const boardStatus = item.boardStatus ?? (
      status === 'processing' ? 'in_progress'
        : status === 'fired' || status === 'acted' ? 'done'
          : status === 'dismissed' || status === 'expired' ? 'archived'
            : item.triggerAt > 0 ? 'scheduled' : 'inbox'
    );
    const messageProvenance: ScheduledMessageProvenance = item.source === 'user'
      && item.messageProvenance === 'user_literal'
      ? 'user_literal'
      : 'generated';

    // Pre-creation dedup gate (agent-source only). Prevents the cognitive
    // layer from inserting near-duplicate items in a single planning burst —
    // the most common cause of duplicate proactive messages. User-source
    // items (explicit reminders the user set) are never blocked here.
    if (item.source === 'agent') {
      const existing = this.findSimilarAgentScheduledItem(
        item.userId,
        item.message,
        item.triggerAt,
        item.sourceItemId ?? null,
      );
      if (existing) {
        return existing;
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, kind, type, message, message_provenance, context,
        trigger_at, recurring, status, source_memory_id, source_item_id, fired_at,
        task_config, board_status, priority, labels, depends_on, goal_id,
        worker_id, preferred_worker_id, lease_token, leased_at, lease_expires_at,
        attempt_count, max_attempts, last_error, handed_off_from,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      item.userId,
      item.sessionId ?? null,
      item.source,
      item.kind ?? 'nudge',
      item.type,
      item.message,
      messageProvenance,
      item.context ?? null,
      item.triggerAt,
      item.recurring ? JSON.stringify(item.recurring) : null,
      status,
      item.sourceMemoryId ?? null,
      item.sourceItemId ?? null,
      null,
      item.taskConfig ? JSON.stringify(item.taskConfig) : null,
      boardStatus,
      item.priority ?? 'medium',
      item.labels ? JSON.stringify(item.labels) : null,
      item.dependsOn ? JSON.stringify(item.dependsOn) : null,
      item.goalId ?? null,
      null,
      item.preferredWorkerId ?? null,
      null,
      null,
      null,
      0,
      Math.max(1, Math.floor(item.maxAttempts ?? item.taskConfig?.maxAttempts ?? 3)),
      null,
      null,
      now,
      now
    );

    return {
      ...item,
      id,
      messageProvenance,
      sourceItemId: item.sourceItemId ?? null,
      kind: item.kind ?? 'nudge',
      taskConfig: item.taskConfig ?? null,
      boardStatus,
      priority: item.priority ?? 'medium',
      labels: item.labels ?? null,
      result: null,
      dependsOn: item.dependsOn ?? null,
      goalId: item.goalId ?? null,
      workerId: null,
      preferredWorkerId: item.preferredWorkerId ?? null,
      leaseToken: null,
      leasedAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      maxAttempts: Math.max(1, Math.floor(item.maxAttempts ?? item.taskConfig?.maxAttempts ?? 3)),
      lastError: null,
      handedOffFrom: null,
      status,
      firedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a scheduled item by ID
   */
  getScheduledItem(id: string): ScheduledItem | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_items WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToScheduledItem(row) : null;
  }

  /**
   * Get pending items that are due (trigger_at <= now)
   */
  getDueScheduledItems(now: number = Date.now()): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE status = 'pending' AND trigger_at > 0 AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(now) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Users with durable board tasks eligible for leasing now. Unlike nudges,
   * task rows intentionally use trigger_at=0 to mean "ready whenever a worker
   * is available". Keeping this query separate prevents unscheduled inbox
   * nudges from crossing the delivery boundary.
   */
  getReadyBoardTaskUserIds(now: number = Date.now()): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id
      FROM scheduled_items
      WHERE kind = 'task' AND status = 'pending'
        AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting')
        AND (trigger_at = 0 OR trigger_at <= ?)
        AND (result IS NOT NULL OR attempt_count < max_attempts)
        AND lease_token IS NULL
      ORDER BY user_id
    `).all(now) as Array<{ user_id: string }>;
    return rows.map(row => row.user_id);
  }

  /**
   * Atomically claim due items by selecting them AND marking as 'processing'.
   * Uses a transaction to prevent duplicate processing when scheduler ticks overlap.
   */
  claimDueScheduledItems(now: number = Date.now(), kind?: ScheduledItemKind): ScheduledItem[] {
    const selectStmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE status = 'pending' AND trigger_at > 0 AND trigger_at <= ?
        AND (? IS NULL OR kind = ?)
      ORDER BY trigger_at ASC
    `);
    const updateStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'processing', board_status = 'in_progress', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    // Wrap in an IMMEDIATE transaction so the SELECT+UPDATE is atomic.
    // IMMEDIATE acquires a reserved lock upfront, preventing concurrent
    // transactions from interleaving between our SELECT and UPDATE.
    const claimTransaction = this.db.transaction(() => {
      const rows = selectStmt.all(now, kind ?? null, kind ?? null) as Record<string, unknown>[];
      const claimed: ScheduledItem[] = [];

      for (const row of rows) {
        const result = updateStmt.run(now, row.id);
        if (result.changes > 0) {
          // Override status to reflect the UPDATE we just performed
          const item = this.rowToScheduledItem(row);
          item.status = 'processing';
          item.boardStatus = 'in_progress';
          item.updatedAt = now;
          claimed.push(item);
        }
      }

      return claimed;
    });

    return claimTransaction.immediate();
  }

  /**
   * Recover nudge claims abandoned by a crashed scheduler. `updated_at` is the
   * atomic claim timestamp written by claimDueScheduledItems; a generous
   * timeout keeps a live renderer/delivery safely owned while allowing a
   * genuinely stranded row to become claimable again after restart.
   *
   * Task-kind rows are deliberately excluded because their lease/token
   * lifecycle is reclaimed separately by BoardService.
   */
  reclaimStaleProcessingNudges(
    staleAfterMs: number,
    now: number = Date.now(),
  ): number {
    const cutoff = now - Math.max(1_000, Math.floor(staleAfterMs));
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting',
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Recovered stale scheduler nudge claim'),
          updated_at = ?
      WHERE kind = 'nudge' AND status = 'processing' AND updated_at <= ?
    `).run(now, cutoff);
    return result.changes;
  }

  /**
   * Reset an item back to pending (e.g. after a processing failure)
   */
  resetScheduledItemToPending(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', updated_at = ?
      WHERE id = ? AND status = 'processing'
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Retry a claimed nudge with a bounded attempt budget. This prevents a
   * permanently unrenderable generated draft from calling the provider every
   * scheduler tick forever.
   */
  recordScheduledNudgeFailure(
    id: string,
    retryAt: number,
    error: string,
  ): 'retry' | 'expired' | 'unchanged' {
    const now = Date.now();
    const transaction = this.db.transaction((): 'retry' | 'expired' | 'unchanged' => {
      const row = this.db.prepare(`
        SELECT status, attempt_count, max_attempts FROM scheduled_items
        WHERE id = ? AND kind = 'nudge'
      `).get(id) as { status: string; attempt_count: number; max_attempts: number } | undefined;
      if (!row || row.status !== 'processing') return 'unchanged';

      const attemptCount = row.attempt_count + 1;
      if (attemptCount >= row.max_attempts) {
        this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'expired', board_status = 'archived', attempt_count = ?,
              last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'processing'
        `).run(attemptCount, error, now, id);
        return 'expired';
      }

      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', trigger_at = ?,
            attempt_count = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `).run(retryAt, attemptCount, error, now, id);
      return 'retry';
    });
    return transaction.immediate();
  }

  /**
   * Retry a transport failure for an explicit user reminder without exhausting
   * the small safety budget used by generated nudges. attempt_count remains an
   * observable delivery-attempt counter, but max_attempts is intentionally not
   * used as an expiry condition here.
   */
  recordScheduledExplicitDeliveryFailure(
    id: string,
    retryAt: number,
    error: string,
  ): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', trigger_at = ?,
          attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
      WHERE id = ? AND kind = 'nudge' AND source = 'user' AND status = 'processing'
    `).run(retryAt, error, now, id);
    return result.changes > 0;
  }

  /**
   * Atomically lease the next dependency-ready board task to a worker.
   * A lease, unlike status='processing' alone, can be safely reclaimed after
   * worker failure without allowing two workers to complete the same attempt.
   */
  claimNextBoardTask(
    userId: string,
    workerId: string,
    leaseMs: number,
    now: number = Date.now(),
  ): ScheduledItem | null {
    const duration = Math.max(1_000, Math.floor(leaseMs));
    const transaction = this.db.transaction((): ScheduledItem | null => {
      // Make expired, retryable leases eligible before selecting work.
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND (result IS NOT NULL OR attempt_count < max_attempts)
      `).run(now, now);
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'expired', board_status = 'archived', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired; retry budget exhausted'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND result IS NULL AND attempt_count >= max_attempts
      `).run(now, now);

      const rows = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE user_id = ? AND kind = 'task' AND status = 'pending'
          AND board_status IN ('inbox', 'backlog', 'scheduled', 'waiting')
          AND (trigger_at = 0 OR trigger_at <= ?)
          AND (result IS NOT NULL OR attempt_count < max_attempts)
          AND lease_token IS NULL
          AND (preferred_worker_id IS NULL OR preferred_worker_id = ?)
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at ASC
      `).all(userId, now, workerId) as Record<string, unknown>[];

      for (const row of rows) {
        const candidate = this.rowToScheduledItem(row);
        const dependenciesReady = (candidate.dependsOn ?? []).every((dependencyId) => {
          const dependency = this.getScheduledItem(dependencyId);
          return dependency?.boardStatus === 'done';
        });
        if (!dependenciesReady) continue;

        const leaseToken = nanoid();
        const claimed = this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'processing', board_status = 'in_progress', worker_id = ?,
              lease_token = ?, leased_at = ?, lease_expires_at = ?,
              attempt_count = CASE WHEN result IS NULL THEN attempt_count + 1 ELSE attempt_count END,
              last_error = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending' AND lease_token IS NULL
        `).run(workerId, leaseToken, now, now + duration, now, candidate.id);
        if (claimed.changes > 0) {
          return this.getScheduledItem(candidate.id);
        }
      }
      return null;
    });
    return transaction.immediate();
  }

  /** Extend a live lease. Stale or incorrect tokens cannot revive work. */
  heartbeatBoardTask(
    itemId: string,
    leaseToken: string,
    extendMs: number,
    now: number = Date.now(),
  ): boolean {
    const expiresAt = now + Math.max(1_000, Math.floor(extendMs));
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(expiresAt, now, itemId, leaseToken, now);
    return result.changes > 0;
  }

  /** Persist an intermediate result only while this worker still owns the lease. */
  storeBoardTaskLeaseResult(
    itemId: string,
    leaseToken: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET result = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(result), now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /**
   * Release a live lease back to waiting without discarding a computed result.
   * Administrative deferrals (for example quiet hours) can restore the attempt
   * because no worker execution actually occurred.
   */
  deferBoardTaskLease(
    itemId: string,
    leaseToken: string,
    retryAt: number,
    options: { reason?: string; restoreAttempt?: boolean } = {},
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', trigger_at = ?,
          worker_id = NULL, lease_token = NULL, leased_at = NULL,
          lease_expires_at = NULL, last_error = ?,
          attempt_count = CASE WHEN ? = 1 THEN MAX(0, attempt_count - 1) ELSE attempt_count END,
          updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(
      Math.max(now, retryAt),
      options.reason ?? null,
      options.restoreAttempt ? 1 : 0,
      now,
      itemId,
      leaseToken,
      now,
    );
    return updated.changes > 0;
  }

  /** Complete a leased task exactly once. */
  completeBoardTaskLease(
    itemId: string,
    leaseToken: string,
    result: BoardItemResult,
    now: number = Date.now(),
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done', result = ?, fired_at = ?,
          worker_id = NULL, preferred_worker_id = NULL, lease_token = NULL,
          leased_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ?
        AND lease_expires_at > ?
    `).run(JSON.stringify(result), now, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /**
   * Fail a leased attempt. Retryable tasks return to waiting with backoff;
   * exhausted or non-retryable tasks are archived with their error retained.
   */
  failBoardTaskLease(
    itemId: string,
    leaseToken: string,
    error: string,
    options: { retryable?: boolean; retryAt?: number } = {},
    now: number = Date.now(),
  ): 'retry_scheduled' | 'exhausted' | 'stale_lease' {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE id = ? AND status = 'processing' AND lease_token = ?
          AND lease_expires_at > ?
      `).get(itemId, leaseToken, now) as Record<string, unknown> | undefined;
      if (!row) return 'stale_lease' as const;

      const item = this.rowToScheduledItem(row);
      const retryable = options.retryable !== false && item.attemptCount < item.maxAttempts;
      if (retryable) {
        const retryAt = Math.max(now, options.retryAt ?? now);
        this.db.prepare(`
          UPDATE scheduled_items
          SET status = 'pending', board_status = 'waiting', trigger_at = ?,
              worker_id = NULL, lease_token = NULL, leased_at = NULL,
              lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE id = ? AND lease_token = ?
        `).run(retryAt, error, now, itemId, leaseToken);
        return 'retry_scheduled' as const;
      }

      const failureResult: BoardItemResult = { response: `Error: ${error}`, completedAt: now };
      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'expired', board_status = 'archived', result = ?,
            worker_id = NULL, lease_token = NULL, leased_at = NULL,
            lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND lease_token = ?
      `).run(JSON.stringify(failureResult), error, now, itemId, leaseToken);
      return 'exhausted' as const;
    });
    return transaction.immediate();
  }

  /** Release a live task to a named worker while retaining its audit trail. */
  handoffBoardTask(
    itemId: string,
    leaseToken: string,
    targetWorkerId: string,
    reason?: string,
    now: number = Date.now(),
  ): boolean {
    const row = this.db.prepare(
      'SELECT worker_id FROM scheduled_items WHERE id = ? AND status = ? AND lease_token = ? AND lease_expires_at > ?',
    ).get(itemId, 'processing', leaseToken, now) as { worker_id: string | null } | undefined;
    if (!row) return false;
    const updated = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', board_status = 'waiting', preferred_worker_id = ?,
          handed_off_from = ?, worker_id = NULL, lease_token = NULL,
          leased_at = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_token = ? AND lease_expires_at > ?
    `).run(targetWorkerId, row.worker_id, reason ?? null, now, itemId, leaseToken, now);
    return updated.changes > 0;
  }

  /** Reclaim every expired task lease; returns the number transitioned. */
  reclaimExpiredBoardTaskLeases(now: number = Date.now()): number {
    const transaction = this.db.transaction(() => {
      // Upgrade/restart recovery: the former scheduler marked tasks processing
      // without a lease token. No live durable worker can own such a row.
      const legacyUnleased = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Legacy unleased task reclaimed'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing' AND lease_token IS NULL
      `).run(now).changes;
      const retryable = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'pending', board_status = 'waiting', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND (result IS NOT NULL OR attempt_count < max_attempts)
      `).run(now, now).changes;
      const exhausted = this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'expired', board_status = 'archived', worker_id = NULL,
            lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Worker lease expired; retry budget exhausted'), updated_at = ?
        WHERE kind = 'task' AND status = 'processing'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
          AND result IS NULL AND attempt_count >= max_attempts
      `).run(now, now).changes;
      return legacyUnleased + retryable + exhausted;
    });
    return transaction.immediate();
  }

  /**
   * Get all scheduled items for a user (all statuses)
   */
  getScheduledItemsByUser(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ?
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get all pending items for a user
   */
  getPendingScheduledItemsByUser(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND status = 'pending'
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get pending items by source (user or agent)
   */
  getPendingScheduledItemsBySource(userId: string, source: ScheduledItemSource): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND source = ? AND status = 'pending'
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(userId, source) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Mark a scheduled item as fired
   */
  markScheduledItemFired(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'fired', board_status = 'done', fired_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.run(now, now, id);
    return result.changes > 0;
  }

  /**
   * Mark a scheduled item as dismissed
   */
  markScheduledItemDismissed(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'dismissed', board_status = 'archived', updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Close an inferred item that became stale/resolved without pretending it
   * was delivered or dismissed by the user. Expired items do not influence
   * proactive cooldown or trust feedback.
   */
  markScheduledItemExpired(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `).run(now, id);
    return result.changes > 0;
  }

  /**
   * Mark a scheduled item as acted (user engaged with proactive message)
   */
  markScheduledItemActed(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'acted', board_status = 'done', updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
  }

  /**
   * Append exact channel delivery provenance for every transport chunk.
   * Rows are never updated or deleted; duplicate retries are idempotently
   * ignored while an ambiguity marker may be appended conservatively later.
   */
  recordProactiveDeliveryReceipt(input: {
    channel: string;
    channelMessageIds: string[];
    scheduledItemId: string;
    ownerUserId: string;
    ambiguous?: boolean;
    createdAt?: number;
  }): number {
    const channel = input.channel.trim().toLowerCase();
    const scheduledItemId = input.scheduledItemId.trim();
    const ownerUserId = input.ownerUserId.trim();
    const channelMessageIds = [...new Set(
      input.channelMessageIds.map(messageId => messageId.trim()).filter(Boolean),
    )];
    if (!channel || !scheduledItemId || !ownerUserId || channelMessageIds.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO proactive_delivery_receipts (
        channel, channel_message_id, scheduled_item_id, owner_user_id, ambiguous, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const createdAt = input.createdAt ?? Date.now();
    const append = this.db.transaction(() => {
      let inserted = 0;
      for (const messageId of channelMessageIds) {
        inserted += insert.run(
          channel,
          messageId,
          scheduledItemId,
          ownerUserId,
          input.ambiguous ? 1 : 0,
          createdAt,
        ).changes;
      }
      return inserted;
    });
    return append.immediate();
  }

  /** Return all append-only claims for one channel-scoped message ID. */
  getProactiveDeliveryReceipts(
    channel: string,
    channelMessageId: string,
  ): ProactiveDeliveryReceiptRow[] {
    const rows = this.db.prepare(`
      SELECT id, channel, channel_message_id, scheduled_item_id,
             owner_user_id, ambiguous, created_at
      FROM proactive_delivery_receipts
      WHERE channel = ? AND channel_message_id = ?
      ORDER BY id ASC
    `).all(channel.trim().toLowerCase(), channelMessageId.trim()) as Array<{
      id: number;
      channel: string;
      channel_message_id: string;
      scheduled_item_id: string;
      owner_user_id: string;
      ambiguous: number;
      created_at: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      channelMessageId: row.channel_message_id,
      scheduledItemId: row.scheduled_item_id,
      ownerUserId: row.owner_user_id,
      ambiguous: row.ambiguous === 1,
      createdAt: row.created_at,
    }));
  }

  /**
   * Atomically apply a trusted direct-reply action to a linked source, close
   * the delivered wrapper, and write both feedback decisions. The wrapper ID
   * is the idempotency key: retries return the first deterministic outcome and
   * can never extend a Snooze twice.
   */
  applyLinkedSourceReplyAndAcknowledge(input: {
    wrapperId: string;
    sourceItemId: string;
    ownerUserId: string;
    feedbackUserId: string;
    action: ProactiveSourceReplyAction;
    delayMs?: number;
    score: number;
    now?: number;
  }): ProactiveSourceReplyTransactionResult {
    const now = input.now ?? Date.now();
    const transaction = this.db.transaction((): ProactiveSourceReplyTransactionResult => {
      const existing = this.db.prepare(`
        SELECT action, source_title, applied
        FROM proactive_source_reply_actions
        WHERE wrapper_id = ?
      `).get(input.wrapperId) as {
        action: ProactiveSourceReplyAction;
        source_title: string;
        applied: number;
      } | undefined;
      if (existing) {
        return {
          acknowledged: true,
          replayed: true,
          sourceAction: existing.applied === 1
            ? { action: existing.action, title: existing.source_title, applied: true }
            : null,
        };
      }

      const wrapper = this.db.prepare(`
        SELECT id, user_id, status
        FROM scheduled_items
        WHERE id = ? AND user_id = ?
      `).get(input.wrapperId, input.ownerUserId) as {
        id: string;
        user_id: string;
        status: string;
      } | undefined;
      if (!wrapper) {
        return { acknowledged: false, replayed: false, sourceAction: null };
      }

      const source = this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE id = ? AND id != ? AND user_id = ?
      `).get(input.sourceItemId, input.wrapperId, input.ownerUserId) as Record<string, unknown> | undefined;

      let applied = false;
      const sourceTitle = source ? String(source.message) : '';
      let resultingTriggerAt: number | null = source ? Number(source.trigger_at) : null;

      // Exact delivery provenance may arrive before the scheduler flips a
      // processing wrapper to fired, and a conversational acknowledgement may
      // mark it acted before a later explicit Archive/Done/Snooze. The action
      // ledger remains the idempotency gate; dismissed/expired wrappers stay
      // terminal and cannot acquire a new side effect retroactively.
      if (source && ['processing', 'fired', 'acted'].includes(wrapper.status)) {
        const status = String(source.status);
        const boardStatus = source.board_status == null ? null : String(source.board_status);
        const terminal = status === 'fired' || status === 'acted'
          || status === 'dismissed' || status === 'expired';
        const hasLiveLease = status === 'processing'
          && source.lease_token != null
          && Number(source.lease_expires_at ?? 0) > now;

        if (input.action === 'archive' && (
          boardStatus === 'archived' || status === 'dismissed' || status === 'expired'
        )) {
          applied = true;
        } else if (input.action === 'done' && (
          boardStatus === 'done' || status === 'fired' || status === 'acted'
        )) {
          applied = true;
        } else if (!hasLiveLease && boardStatus !== 'done' && boardStatus !== 'archived') {
          if (input.action === 'archive') {
            // Preserve legacy terminal history; otherwise atomically archive.
            if (terminal) {
              applied = status === 'dismissed' || status === 'expired';
            } else {
              applied = this.db.prepare(`
                UPDATE scheduled_items
                SET status = 'dismissed', board_status = 'archived',
                    worker_id = NULL, lease_token = NULL, leased_at = NULL,
                    lease_expires_at = NULL, updated_at = ?
                WHERE id = ? AND user_id = ?
              `).run(now, input.sourceItemId, input.ownerUserId).changes === 1;
            }
          } else if (input.action === 'done' && !terminal) {
            applied = this.db.prepare(`
              UPDATE scheduled_items
              SET status = 'fired', board_status = 'done', fired_at = COALESCE(fired_at, ?),
                  worker_id = NULL, lease_token = NULL, leased_at = NULL,
                  lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND user_id = ?
            `).run(now, now, input.sourceItemId, input.ownerUserId).changes === 1;
          } else if (input.action === 'snooze' && !terminal) {
            resultingTriggerAt = now + Math.max(60_000, Math.floor(input.delayMs ?? 24 * 60 * 60 * 1000));
            applied = this.db.prepare(`
              UPDATE scheduled_items
              SET status = 'pending', board_status = 'scheduled', trigger_at = ?,
                  worker_id = NULL, lease_token = NULL, leased_at = NULL,
                  lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND user_id = ?
            `).run(resultingTriggerAt, now, input.sourceItemId, input.ownerUserId).changes === 1;
          }
        }
      }

      this.db.prepare(`
        INSERT INTO proactive_source_reply_actions (
          wrapper_id, source_item_id, user_id, action, source_title,
          applied, source_trigger_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.wrapperId,
        input.sourceItemId,
        input.ownerUserId,
        input.action,
        sourceTitle,
        applied ? 1 : 0,
        resultingTriggerAt,
        now,
      );

      this.db.prepare(`
        UPDATE scheduled_items
        SET status = 'acted', board_status = 'done', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('processing', 'fired')
      `).run(now, input.wrapperId, input.ownerUserId);

      if (applied && source) {
        this.db.prepare(`
          INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
          VALUES (?, ?, 'feedback', 'source_updated', ?, ?)
        `).run(
          input.feedbackUserId,
          now,
          `reply_${input.action}`,
          JSON.stringify({ itemId: input.wrapperId, sourceItemId: input.sourceItemId }),
        );
      }
      this.db.prepare(`
        INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
        VALUES (?, ?, 'feedback', 'acted', 'direct_reply', ?)
      `).run(
        input.feedbackUserId,
        now,
        JSON.stringify({
          itemId: input.wrapperId,
          score: input.score,
          replyAction: input.action,
          sourceActionApplied: applied,
        }),
      );

      return {
        acknowledged: true,
        replayed: false,
        sourceAction: applied && source
          ? { action: input.action, title: sourceTitle, applied: true }
          : null,
      };
    });

    return transaction.immediate();
  }

  /**
   * Update a scheduled item (e.g., reschedule)
   */
  updateScheduledItem(id: string, updates: Partial<Pick<ScheduledItem, 'triggerAt' | 'message' | 'messageProvenance' | 'status'>>): boolean {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.triggerAt !== undefined) {
      sets.push('trigger_at = ?');
      params.push(updates.triggerAt);
    }
    if (updates.message !== undefined) {
      sets.push('message = ?');
      params.push(updates.message);
      sets.push("message_provenance = CASE WHEN source = 'user' THEN ? ELSE 'generated' END");
      params.push(updates.messageProvenance ?? 'generated');
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
      sets.push(`board_status = CASE ?
        WHEN 'processing' THEN 'in_progress'
        WHEN 'fired' THEN 'done'
        WHEN 'acted' THEN 'done'
        WHEN 'dismissed' THEN 'archived'
        WHEN 'expired' THEN 'archived'
        ELSE CASE
          WHEN board_status IN ('inbox', 'backlog', 'scheduled', 'waiting') THEN board_status
          WHEN COALESCE(?, trigger_at) > 0 THEN 'scheduled'
          ELSE 'inbox'
        END
      END`);
      params.push(updates.status, updates.triggerAt ?? null);
    }

    params.push(id);
    // SAFETY: Column names in `sets` are hardcoded strings from the conditionals above, never user-derived
    const stmt = this.db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Update board-specific fields on a scheduled item
   */
  updateScheduledItemBoard(id: string, updates: {
    boardStatus?: BoardStatus | null;
    priority?: Priority;
    labels?: string[] | null;
    triggerAt?: number;
    message?: string;
    messageProvenance?: ScheduledMessageProvenance;
    kind?: ScheduledItemKind;
    goalId?: string | null;
    dependsOn?: string[] | null;
    status?: ScheduledItemStatus;
  }): boolean {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.boardStatus !== undefined) {
      sets.push('board_status = ?');
      params.push(updates.boardStatus);
    }
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
    }
    if (updates.labels !== undefined) {
      sets.push('labels = ?');
      params.push(updates.labels ? JSON.stringify(updates.labels) : null);
    }
    if (updates.triggerAt !== undefined) {
      sets.push('trigger_at = ?');
      params.push(updates.triggerAt);
    }
    if (updates.message !== undefined) {
      sets.push('message = ?');
      params.push(updates.message);
      sets.push("message_provenance = CASE WHEN source = 'user' THEN ? ELSE 'generated' END");
      params.push(updates.messageProvenance ?? 'generated');
    }
    if (updates.kind !== undefined) {
      sets.push('kind = ?');
      params.push(updates.kind);
    }
    if (updates.goalId !== undefined) {
      sets.push('goal_id = ?');
      params.push(updates.goalId);
    }
    if (updates.dependsOn !== undefined) {
      sets.push('depends_on = ?');
      params.push(updates.dependsOn ? JSON.stringify(updates.dependsOn) : null);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
      if (updates.boardStatus === undefined) {
        sets.push(`board_status = CASE ?
          WHEN 'processing' THEN 'in_progress'
          WHEN 'fired' THEN 'done'
          WHEN 'acted' THEN 'done'
          WHEN 'dismissed' THEN 'archived'
          WHEN 'expired' THEN 'archived'
          ELSE CASE
            WHEN board_status IN ('inbox', 'backlog', 'scheduled', 'waiting') THEN board_status
            WHEN COALESCE(?, trigger_at) > 0 THEN 'scheduled'
            ELSE 'inbox'
          END
        END`);
        params.push(updates.status, updates.triggerAt ?? null);
      }
    }

    params.push(id);
    const stmt = this.db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Store a result on a scheduled item (called by scheduler after sub-agent completes)
   */
  updateScheduledItemResult(id: string, result: BoardItemResult): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items SET result = ?, updated_at = ? WHERE id = ?
    `);
    const res = stmt.run(JSON.stringify(result), now, id);
    return res.changes > 0;
  }

  /**
   * Get scheduled items by board status for a user
   */
  getScheduledItemsByBoardStatus(userId: string, boardStatus: BoardStatus): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND board_status = ?
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        trigger_at ASC
    `);
    const rows = stmt.all(userId, boardStatus) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get all board items for a user (items with board_status set, plus legacy items)
   */
  getScheduledItemsForBoard(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND status NOT IN ('expired')
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        trigger_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Get completed board items that haven't been notified yet
   */
  getUnnotifiedCompletedItems(userId: string): ScheduledItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND board_status = 'done' AND result IS NOT NULL
      ORDER BY updated_at ASC
    `);
    const rows = stmt.all(userId) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row))
      .filter(item => item.result && item.result.notifiedAt == null);
  }

  /**
   * Auto-archive done items older than maxAgeMs
   */
  autoArchiveDoneItems(userId: string, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET board_status = 'archived', updated_at = ?
      WHERE user_id = ? AND board_status = 'done' AND updated_at < ?
    `);
    const result = stmt.run(now, userId, cutoff);
    return result.changes;
  }

  /**
   * Delete a scheduled item
   */
  deleteScheduledItem(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM scheduled_items WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Consolidate duplicate pending scheduled items.
   * Groups pending items by user, then archives duplicates using word-overlap similarity.
   * Keeps the earliest-created item live in each duplicate group while preserving
   * every duplicate row for audit/history.
   * Returns the number of duplicates archived.
   */
  consolidateDuplicateScheduledItems(): number {
    const stmt = this.db.prepare(`
      SELECT id, user_id, kind, type, source_item_id, source_memory_id,
             message, trigger_at, created_at
      FROM scheduled_items
      WHERE status = 'pending' AND source = 'agent'
      ORDER BY user_id, created_at ASC
    `);
    const rows = stmt.all() as Array<{
      id: string;
      user_id: string;
      kind: string;
      type: string;
      source_item_id: string | null;
      source_memory_id: string | null;
      message: string;
      trigger_at: number;
      created_at: number;
    }>;

    const isSimilar = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size === 0 || b.size === 0) return false;
      let overlap = 0;
      for (const word of a) {
        if (b.has(word)) overlap++;
      }
      const smaller = Math.min(a.size, b.size);
      return (overlap / smaller) >= DEDUP_SIMILARITY_STRICT || (overlap / a.size) >= DEDUP_SIMILARITY_LENIENT || (overlap / b.size) >= DEDUP_SIMILARITY_LENIENT;
    };

    // Provenance and execution shape are part of duplicate identity. Two
    // wrappers can have nearly identical wording while referring to different
    // board tasks; collapsing them would sever reply routing and hide work.
    const byIdentity = new Map<string, typeof rows>();
    for (const row of rows) {
      const identity = JSON.stringify([
        row.user_id,
        row.kind,
        row.type,
        row.source_item_id,
        row.source_memory_id,
      ]);
      const list = byIdentity.get(identity) || [];
      list.push(row);
      byIdentity.set(identity, list);
    }

    const toArchive = new Set<string>();
    const archiveStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived',
          last_error = COALESCE(last_error, 'Archived as a duplicate scheduled item'),
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    for (const items of byIdentity.values()) {
      const kept = new Set<number>(); // indices we've already decided to keep
      for (let i = 0; i < items.length; i++) {
        if (toArchive.has(items[i].id)) continue;
        kept.add(i);
        const wordsI = normalizeForSimilarity(items[i].message);
        for (let j = i + 1; j < items.length; j++) {
          if (toArchive.has(items[j].id)) continue;
          // Only compare items within 7 days of each other
          if (Math.abs(items[i].trigger_at - items[j].trigger_at) > 7 * 24 * 60 * 60 * 1000) continue;
          const wordsJ = normalizeForSimilarity(items[j].message);
          if (isSimilar(wordsI, wordsJ)) {
            toArchive.add(items[j].id); // keep earlier (i), quarantine later (j)
          }
        }
      }
    }

    const now = Date.now();
    let archived = 0;
    for (const id of toArchive) {
      archived += archiveStmt.run(now, id).changes;
    }

    return archived;
  }

  /**
   * Record a proactive message that was sent to a user. Persists to SQLite so
   * the in-memory dedup history survives process restarts.
   */
  /**
   * Record an LLM call trace for fine-tune dataset building.
   * Self-pruning: roughly every 200 inserts, drops rows older than 45 days
   * so the table can't grow unbounded on the Pi if nightly pulls lapse.
   */
  insertLlmTrace(row: {
    ts: number;
    purpose: string;
    model: string;
    provider: string;
    prompt: string;
    response: string;
    parsedOk: number;
    sessionId: string | null;
    latencyMs: number;
    stopReason?: string;
    requestMaxTokens?: number | null;
    modelContextWindowTokens?: number;
    modelMaxOutputTokens?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO llm_traces (
        ts, purpose, model, provider, prompt, response, parsed_ok, session_id,
        latency_ms, stop_reason, request_max_tokens, model_context_window_tokens,
        model_max_output_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.ts,
      row.purpose,
      row.model,
      row.provider,
      row.prompt,
      row.response,
      row.parsedOk,
      row.sessionId,
      row.latencyMs,
      row.stopReason ?? null,
      row.requestMaxTokens ?? null,
      row.modelContextWindowTokens ?? null,
      row.modelMaxOutputTokens ?? null
    );

    if (++this.llmTraceInsertCount % 200 === 0) {
      this.pruneLlmTraces(Date.now() - 45 * 24 * 60 * 60 * 1000);
    }
  }

  private llmTraceInsertCount = 0;

  /** Delete traces older than `cutoffMs`. Returns rows removed. */
  pruneLlmTraces(cutoffMs: number): number {
    return this.db.prepare('DELETE FROM llm_traces WHERE ts < ?').run(cutoffMs).changes as number;
  }

  /** Trace counts by purpose/parse outcome since `sinceMs` (observability). */
  getLlmTraceStats(sinceMs: number): Array<{ purpose: string; parsedOk: number; count: number }> {
    const rows = this.db.prepare(`
      SELECT purpose, parsed_ok, COUNT(*) AS count FROM llm_traces
      WHERE ts >= ? GROUP BY purpose, parsed_ok ORDER BY purpose
    `).all(sinceMs) as Array<{ purpose: string; parsed_ok: number; count: number }>;
    return rows.map(r => ({ purpose: r.purpose, parsedOk: r.parsed_ok, count: r.count }));
  }

  recordProactiveSend(userId: string, message: string, source: string, sentAt: number = Date.now()): void {
    this.db.prepare(`
      INSERT INTO proactive_send_log (user_id, message, source, sent_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, message, source, sentAt);
  }

  /**
   * Atomically reserve one inferred-delivery slot across every process sharing
   * this SQLite database. Active reservations count toward the daily budget and
   * serialize the min-gap window until delivery is finalized or released.
   */
  reserveProactiveDelivery(input: {
    itemId: string;
    userId: string;
    dayStart: number;
    nextDayStart: number;
    dailyCap: number;
    minGapMs: number;
    reservationTtlMs?: number;
    now?: number;
  }): ProactiveDeliveryReservationResult {
    const now = input.now ?? Date.now();
    const ttlMs = Math.max(60_000, Math.floor(input.reservationTtlMs ?? 15 * 60_000));
    const transaction = this.db.transaction((): ProactiveDeliveryReservationResult => {
      this.db.prepare('DELETE FROM proactive_delivery_reservations WHERE expires_at <= ?').run(now);

      const existingItem = this.db.prepare(`
        SELECT expires_at FROM proactive_delivery_reservations
        WHERE item_id = ? AND expires_at > ?
      `).get(input.itemId, now) as { expires_at: number } | undefined;
      if (existingItem) return { outcome: 'min_gap', retryAt: existingItem.expires_at };

      const sentToday = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM proactive_send_log
        WHERE user_id = ? AND source = 'agent' AND sent_at >= ?
      `).get(input.userId, input.dayStart) as { count: number };
      const heldToday = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM proactive_delivery_reservations
        WHERE user_id = ? AND reserved_at >= ? AND expires_at > ?
      `).get(input.userId, input.dayStart, now) as { count: number };
      if (sentToday.count + heldToday.count >= Math.max(1, Math.floor(input.dailyCap))) {
        return { outcome: 'daily_cap', retryAt: input.nextDayStart };
      }

      if (input.minGapMs > 0) {
        const lastSend = this.db.prepare(`
          SELECT MAX(sent_at) AS sent_at
          FROM proactive_send_log
          WHERE user_id = ? AND source = 'agent'
        `).get(input.userId) as { sent_at: number | null };
        const held = this.db.prepare(`
          SELECT MAX(expires_at) AS expires_at
          FROM proactive_delivery_reservations
          WHERE user_id = ? AND expires_at > ?
        `).get(input.userId, now) as { expires_at: number | null };
        const retryAt = Math.max(
          (lastSend.sent_at ?? 0) + input.minGapMs,
          held.expires_at ?? 0,
        );
        if (retryAt > now) return { outcome: 'min_gap', retryAt };
      }

      const token = nanoid();
      this.db.prepare(`
        INSERT INTO proactive_delivery_reservations (
          token, item_id, user_id, reserved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(token, input.itemId, input.userId, now, now + ttlMs);
      return { outcome: 'reserved', token };
    });
    return transaction.immediate();
  }

  /** Release capacity after transport fails or is abandoned before a send. */
  releaseProactiveDeliveryReservation(token: string): boolean {
    return this.db.prepare(`
      DELETE FROM proactive_delivery_reservations WHERE token = ?
    `).run(token).changes === 1;
  }

  /** Convert a held slot into the authoritative send record atomically. */
  finalizeProactiveDeliveryReservation(
    token: string,
    message: string,
    source: string,
    sentAt: number = Date.now(),
  ): boolean {
    const transaction = this.db.transaction(() => {
      const reservation = this.db.prepare(`
        SELECT user_id FROM proactive_delivery_reservations WHERE token = ?
      `).get(token) as { user_id: string } | undefined;
      if (!reservation) return false;
      this.db.prepare(`
        INSERT INTO proactive_send_log (user_id, message, source, sent_at)
        VALUES (?, ?, ?, ?)
      `).run(reservation.user_id, message, source, sentAt);
      this.db.prepare('DELETE FROM proactive_delivery_reservations WHERE token = ?').run(token);
      return true;
    });
    return transaction.immediate();
  }

  /**
   * Load recent proactive sends since `sinceMs` for restart-time dedup hydration.
   * Returns rows for ALL users; the scheduler bucket-sorts them into the
   * per-user in-memory map.
   */
  getRecentProactiveSends(sinceMs: number): Array<{ userId: string; message: string; source: string; sentAt: number }> {
    const rows = this.db.prepare(`
      SELECT user_id, message, source, sent_at
      FROM proactive_send_log
      WHERE sent_at >= ?
      ORDER BY sent_at ASC
    `).all(sinceMs) as Array<{ user_id: string; message: string; source: string; sent_at: number }>;
    return rows.map(r => ({ userId: r.user_id, message: r.message, source: r.source, sentAt: r.sent_at }));
  }

  /**
   * Prune proactive_send_log entries older than `cutoffMs`. Called periodically
   * to keep the table small.
   */
  pruneProactiveSendLog(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM proactive_send_log WHERE sent_at < ?').run(cutoffMs);
    return result.changes;
  }

  /**
   * Record a proactive DECISION for observability (powers `why-no-proact`).
   * `detail` is JSON-serialized. Never throws — diagnostics must not break the
   * gardener/scheduler.
   */
  recordProactiveDecision(decision: {
    userId: string;
    stage: string;
    outcome: string;
    reason?: string | null;
    detail?: Record<string, unknown> | null;
    at?: number;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO proactive_decisions (user_id, at, stage, outcome, reason, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decision.userId,
        decision.at ?? Date.now(),
        decision.stage,
        decision.outcome,
        decision.reason ?? null,
        decision.detail ? JSON.stringify(decision.detail) : null
      );
    } catch {
      // Observability is best-effort; swallow.
    }
  }

  /**
   * Load the most recent proactive decisions (newest first), for the diagnostic.
   */
  getRecentProactiveDecisions(limit: number = 30): Array<{
    id: number;
    userId: string;
    at: number;
    stage: string;
    outcome: string;
    reason: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, user_id, at, stage, outcome, reason, detail
      FROM proactive_decisions
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: number; user_id: string; at: number; stage: string; outcome: string; reason: string | null; detail: string | null }>;
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      at: r.at,
      stage: r.stage,
      outcome: r.outcome,
      reason: r.reason,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /** Prune proactive_decisions older than `cutoffMs`. */
  pruneProactiveDecisions(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM proactive_decisions WHERE at < ?').run(cutoffMs);
    return result.changes;
  }

  // ============ Self-Evolution Engine ============

  /** Append a captured improvement signal (Layer 1). Best-effort. */
  recordEvolutionSignal(signal: {
    userId: string;
    at: number;
    type: string;
    targetSkill?: string | null;
    criticScore?: number | null;
    toolCallCount?: number | null;
    sessionId?: string | null;
    detail?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO evolution_signals
          (user_id, at, type, target_skill, critic_score, tool_call_count, session_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.userId,
        signal.at,
        signal.type,
        signal.targetSkill ?? null,
        signal.criticScore ?? null,
        signal.toolCallCount ?? null,
        signal.sessionId ?? null,
        signal.detail ? JSON.stringify(signal.detail) : null,
      );
    } catch {
      // Observability/corpus capture is best-effort; swallow.
    }
  }

  /** Most recent evolution signals (newest first). */
  getRecentEvolutionSignals(limit: number = 100): Array<{
    id: number;
    userId: string;
    at: number;
    type: string;
    targetSkill: string | null;
    criticScore: number | null;
    toolCallCount: number | null;
    sessionId: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, user_id, at, type, target_skill, critic_score, tool_call_count, session_id, detail
      FROM evolution_signals
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number; user_id: string; at: number; type: string; target_skill: string | null;
      critic_score: number | null; tool_call_count: number | null; session_id: string | null; detail: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      at: r.at,
      type: r.type,
      targetSkill: r.target_skill,
      criticScore: r.critic_score,
      toolCallCount: r.tool_call_count,
      sessionId: r.session_id,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /** Prune evolution_signals older than `cutoffMs`. */
  pruneEvolutionSignals(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM evolution_signals WHERE at < ?').run(cutoffMs);
    return result.changes;
  }

  /** Append an evolution decision record (observability). Best-effort. */
  recordEvolutionDecision(decision: {
    at: number;
    stage: string;
    outcome: string;
    reason?: string | null;
    target?: string | null;
    detail?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO evolution_decisions (at, stage, outcome, reason, target, detail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decision.at,
        decision.stage,
        decision.outcome,
        decision.reason ?? null,
        decision.target ?? null,
        decision.detail ? JSON.stringify(decision.detail) : null,
      );
    } catch {
      // Observability is best-effort; swallow.
    }
  }

  /** Most recent evolution decisions (newest first), for the diagnostic. */
  getRecentEvolutionDecisions(limit: number = 30): Array<{
    id: number;
    at: number;
    stage: string;
    outcome: string;
    reason: string | null;
    target: string | null;
    detail: Record<string, unknown> | null;
  }> {
    const rows = this.db.prepare(`
      SELECT id, at, stage, outcome, reason, target, detail
      FROM evolution_decisions
      ORDER BY at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number; at: number; stage: string; outcome: string; reason: string | null; target: string | null; detail: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      at: r.at,
      stage: r.stage,
      outcome: r.outcome,
      reason: r.reason,
      target: r.target,
      detail: r.detail ? parseDetailJSON(r.detail) : null,
    }));
  }

  /** Record a promoted mutation + its rollback snapshot. Returns the new row id. */
  recordEvolutionVersion(version: {
    target: string;
    kind: string;
    at: number;
    baselineFitness?: number | null;
    snapshot?: string | null;
    detail?: Record<string, unknown> | null;
  }): number {
    const record = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE evolution_versions SET status = 'superseded'
        WHERE target = ? AND status = 'active'
      `).run(version.target);
      const result = this.db.prepare(`
        INSERT INTO evolution_versions (target, kind, at, baseline_fitness, snapshot, status, detail)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(
        version.target,
        version.kind,
        version.at,
        version.baselineFitness ?? null,
        version.snapshot ?? null,
        version.detail ? JSON.stringify(version.detail) : null,
      );
      return Number(result.lastInsertRowid);
    });
    return record();
  }

  /** The currently-active promoted version for a target, if any. */
  getActiveEvolutionVersion(target: string): {
    id: number; target: string; kind: string; at: number; baselineFitness: number | null; snapshot: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT id, target, kind, at, baseline_fitness, snapshot
      FROM evolution_versions
      WHERE target = ? AND status = 'active'
      ORDER BY at DESC LIMIT 1
    `).get(target) as { id: number; target: string; kind: string; at: number; baseline_fitness: number | null; snapshot: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, target: row.target, kind: row.kind, at: row.at, baselineFitness: row.baseline_fitness, snapshot: row.snapshot };
  }

  /** All active promoted versions (for the rollback watchdog). */
  getActiveEvolutionVersions(): Array<{ id: number; target: string; kind: string; at: number; baselineFitness: number | null }> {
    const rows = this.db.prepare(`
      SELECT id, target, kind, at, baseline_fitness
      FROM evolution_versions WHERE status = 'active' ORDER BY at DESC
    `).all() as Array<{ id: number; target: string; kind: string; at: number; baseline_fitness: number | null }>;
    return rows.map(r => ({ id: r.id, target: r.target, kind: r.kind, at: r.at, baselineFitness: r.baseline_fitness }));
  }

  /** Mark a version row as rolled back. */
  markEvolutionVersionRolledBack(id: number): void {
    this.db.prepare(`UPDATE evolution_versions SET status = 'rolled_back' WHERE id = ?`).run(id);
  }

  /** All currently-active prompt fragments (appended to the system prompt). */
  getActivePromptOverrides(): Array<{ fragmentId: string; content: string; version: number }> {
    const rows = this.db.prepare(`
      SELECT fragment_id, content, version FROM prompt_overrides WHERE active = 1 ORDER BY fragment_id
    `).all() as Array<{ fragment_id: string; content: string; version: number }>;
    return rows.map(r => ({ fragmentId: r.fragment_id, content: r.content, version: r.version }));
  }

  /** The active content for one fragment, or null. */
  getActivePromptOverride(fragmentId: string): { content: string; version: number } | null {
    const row = this.db.prepare(`
      SELECT content, version FROM prompt_overrides WHERE fragment_id = ? AND active = 1 ORDER BY version DESC LIMIT 1
    `).get(fragmentId) as { content: string; version: number } | undefined;
    return row ? { content: row.content, version: row.version } : null;
  }

  /** Activate a new version of a fragment, deactivating any prior active one. Returns the new version. */
  upsertPromptOverride(fragmentId: string, content: string, at: number): number {
    const upsert = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      const nextVersion = (prior.v ?? 0) + 1;
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      this.db.prepare(`
        INSERT INTO prompt_overrides (fragment_id, content, active, version, at) VALUES (?, ?, 1, ?, ?)
      `).run(fragmentId, content, nextVersion, at);
      return nextVersion;
    });
    return upsert();
  }

  /** Atomically activate a prompt mutation and its single active rollback ledger. */
  promotePromptEvolution(input: {
    fragmentId: string;
    content: string;
    at: number;
    baselineFitness?: number | null;
    snapshot?: string | null;
    detail?: Record<string, unknown> | null;
  }): { promptVersion: number; evolutionVersionId: number } {
    const promote = this.db.transaction(() => {
      const prior = this.db.prepare(`
        SELECT MAX(version) AS v FROM prompt_overrides WHERE fragment_id = ?
      `).get(input.fragmentId) as { v: number | null };
      const promptVersion = (prior.v ?? 0) + 1;
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`)
        .run(input.fragmentId);
      this.db.prepare(`
        INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
        VALUES (?, ?, 1, ?, ?)
      `).run(input.fragmentId, input.content, promptVersion, input.at);

      const target = `prompt:${input.fragmentId}`;
      this.db.prepare(`
        UPDATE evolution_versions SET status = 'superseded'
        WHERE target = ? AND status = 'active'
      `).run(target);
      const ledger = this.db.prepare(`
        INSERT INTO evolution_versions (target, kind, at, baseline_fitness, snapshot, status, detail)
        VALUES (?, 'patch_prompt', ?, ?, ?, 'active', ?)
      `).run(
        target,
        input.at,
        input.baselineFitness ?? null,
        input.snapshot ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
      );
      return {
        promptVersion,
        evolutionVersionId: Number(ledger.lastInsertRowid),
      };
    });
    return promote();
  }

  /** Deactivate the active version of a fragment, optionally re-activating a prior content. */
  rollbackPromptOverride(fragmentId: string, restoreContent: string | null, at: number): void {
    const rollback = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      if (restoreContent !== null) {
        this.db.prepare(`
          INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
          VALUES (?, ?, 1, ?, ?)
        `).run(fragmentId, restoreContent, (prior.v ?? 0) + 1, at);
      }
    });
    rollback();
  }

  /** Roll back prompt content and its active ledger in one SQLite transaction. */
  rollbackPromptEvolutionVersion(
    versionId: number,
    fragmentId: string,
    restoreContent: string | null,
    at: number,
  ): void {
    const rollback = this.db.transaction(() => {
      const target = `prompt:${fragmentId}`;
      const active = this.db.prepare(`
        SELECT id FROM evolution_versions
        WHERE id = ? AND target = ? AND kind = 'patch_prompt' AND status = 'active'
      `).get(versionId, target);
      if (!active) throw new Error(`Prompt evolution version ${versionId} is not active`);

      const prior = this.db.prepare(`SELECT MAX(version) as v FROM prompt_overrides WHERE fragment_id = ?`).get(fragmentId) as { v: number | null };
      this.db.prepare(`UPDATE prompt_overrides SET active = 0 WHERE fragment_id = ?`).run(fragmentId);
      if (restoreContent !== null) {
        this.db.prepare(`
          INSERT INTO prompt_overrides (fragment_id, content, active, version, at)
          VALUES (?, ?, 1, ?, ?)
        `).run(fragmentId, restoreContent, (prior.v ?? 0) + 1, at);
      }
      this.db.prepare(`UPDATE evolution_versions SET status = 'rolled_back' WHERE id = ?`)
        .run(versionId);
    });
    rollback();
  }

  /**
   * Expire old pending nudges (older than maxAgeMs past their trigger time).
   * Unscheduled board work (`trigger_at = 0`), task-kind work, and anything
   * already processing/leased are owned by their explicit worker lifecycle.
   */
  expireOldScheduledItems(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    // Only expire non-recurring items. Recurring items that are overdue
    // will be picked up by the scheduler and rescheduled after firing.
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE status = 'pending' AND kind = 'nudge'
        AND trigger_at > 0 AND trigger_at < ?
        AND recurring IS NULL
    `);
    const result = stmt.run(now, cutoff);
    return result.changes;
  }

  /**
   * Find a similar pending agent-source scheduled item near `triggerAt` for the
   * same user. Used by addScheduledItem to suppress duplicate creation by the
   * cognitive layer. Returns the existing item if a match is found, else null.
   *
   * Window is ±2h around the new triggerAt — narrower than
   * hasSimilarPendingScheduledItem so legitimately distinct items at different
   * times of day still go through.
   */
  findSimilarAgentScheduledItem(
    userId: string,
    message: string,
    triggerAt: number,
    sourceItemId: string | null = null,
  ): ScheduledItem | null {
    const WINDOW_MS = 2 * 60 * 60 * 1000;
    const newWords = normalizeForSimilarity(message);
    if (newWords.size === 0) return null;

    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE user_id = ? AND source = 'agent' AND status IN ('pending', 'processing')
        AND trigger_at BETWEEN ? AND ?
        AND ((? IS NULL AND source_item_id IS NULL) OR source_item_id = ?)
    `);
    const rows = stmt.all(
      userId,
      triggerAt - WINDOW_MS,
      triggerAt + WINDOW_MS,
      sourceItemId,
      sourceItemId,
    ) as Record<string, unknown>[];

    for (const row of rows) {
      const existingMessage = (row.message ?? '') as string;
      const existingWords = normalizeForSimilarity(existingMessage);
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) overlap++;
      }
      const smaller = Math.min(newWords.size, existingWords.size);
      const similaritySmaller = overlap / smaller;
      const similarityNew = overlap / newWords.size;
      const similarityExisting = overlap / existingWords.size;

      if (similaritySmaller >= DEDUP_SIMILARITY_STRICT
          || similarityNew >= DEDUP_SIMILARITY_LENIENT
          || similarityExisting >= DEDUP_SIMILARITY_LENIENT) {
        return this.rowToScheduledItem(row);
      }
    }
    return null;
  }

  /**
   * Check if a similar pending item already exists (for duplicate detection)
   */
  hasSimilarPendingScheduledItem(userId: string, message: string, withinMs: number = 24 * 60 * 60 * 1000): boolean {
    const now = Date.now();

    // Get all pending items within the time window
    const stmt = this.db.prepare(`
      SELECT message FROM scheduled_items
      WHERE user_id = ? AND status IN ('pending', 'processing')
        AND trigger_at BETWEEN ? AND ?
    `);
    const rows = stmt.all(userId, now - withinMs, now + withinMs * 7) as Array<{ message: string }>;

    if (rows.length === 0) return false;

    const newWords = normalizeForSimilarity(message);
    if (newWords.size === 0) return false;

    for (const row of rows) {
      const existingWords = normalizeForSimilarity(row.message);
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const word of newWords) {
        if (existingWords.has(word)) overlap++;
      }

      const smaller = Math.min(newWords.size, existingWords.size);
      const similaritySmaller = overlap / smaller;
      const similarityNew = overlap / newWords.size;
      const similarityExisting = overlap / existingWords.size;

      // Match if: all words in the shorter description overlap,
      // OR either side has 40%+ overlap (lowered from 50% to catch more dupes)
      if (similaritySmaller >= DEDUP_SIMILARITY_STRICT || similarityNew >= DEDUP_SIMILARITY_LENIENT || similarityExisting >= DEDUP_SIMILARITY_LENIENT) {
        return true;
      }
    }

    return false;
  }

  /**
   * Cancel pending/processing scheduled items that reference a deleted memory
   */
  cancelScheduledItemsBySourceMemory(memoryId: string): number {
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE source_memory_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.run(Date.now(), memoryId);
    return result.changes;
  }

  /**
   * Null out session_id references on scheduled items that point to non-existent sessions.
   * Prevents "Session not found" errors when scheduled items fire.
   */
  cleanStaleScheduledItemSessions(): number {
    // Find scheduled items with non-null session_id where the session no longer exists
    const staleItems = this.db.prepare(`
      SELECT si.id FROM scheduled_items si
      WHERE si.session_id IS NOT NULL
        AND si.session_id != ''
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = si.session_id)
    `).all() as Array<{ id: string }>;

    if (staleItems.length === 0) return 0;

    const updateStmt = this.db.prepare(
      'UPDATE scheduled_items SET session_id = NULL, updated_at = ? WHERE id = ?'
    );
    const now = Date.now();
    for (const item of staleItems) {
      updateStmt.run(now, item.id);
    }
    return staleItems.length;
  }

  /**
   * Remove user profile entries whose value is textually similar to superseded memory content.
   * Prevents stale profile fields (e.g. "focus: meeting with X") from persisting after
   * the source memory is superseded or forgotten.
   */
  cleanStaleProfileEntries(userId: string, content: string): number {
    const contentWords = normalizeForSimilarity(content);
    if (contentWords.size === 0) return 0;

    const entries = this.getProfile(userId);
    let cleaned = 0;

    // Only clean ephemeral fields that are derived from conversations
    const ephemeralFields = new Set(['focus', 'mood']);

    for (const entry of entries) {
      if (!ephemeralFields.has(entry.key)) continue;

      const valueWords = normalizeForSimilarity(entry.value);
      if (valueWords.size === 0) continue;

      let overlap = 0;
      for (const word of contentWords) {
        if (valueWords.has(word)) overlap++;
      }

      const smaller = Math.min(contentWords.size, valueWords.size);
      if (smaller > 0 && (overlap / smaller >= 0.5 || overlap / valueWords.size >= 0.4)) {
        this.deleteProfileValue(userId, entry.key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Cancel pending scheduled items whose message is textually similar to the given content.
   * Used to clean up orphaned items when a memory is forgotten (sourceMemoryId may be null).
   */
  cancelSimilarScheduledItems(userId: string, content: string): number {
    const stmt = this.db.prepare(`
      SELECT id, message FROM scheduled_items
      WHERE user_id = ? AND status IN ('pending', 'processing')
    `);
    const rows = stmt.all(userId) as Array<{ id: string; message: string }>;

    const contentWords = normalizeForSimilarity(content);
    if (contentWords.size === 0) return 0;

    let cancelled = 0;
    const updateStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', board_status = 'archived', updated_at = ?
      WHERE id = ?
    `);
    const now = Date.now();

    for (const row of rows) {
      const msgWords = normalizeForSimilarity(row.message);
      if (msgWords.size === 0) continue;

      let overlap = 0;
      for (const word of contentWords) {
        if (msgWords.has(word)) overlap++;
      }

      // Use multiple overlap metrics to catch different phrasing patterns:
      // - overlap/smaller >= 0.5: at least half the words in the shorter text match
      // - overlap/either >= 0.4: at least 40% of either side matches (asymmetric catch)
      const smaller = Math.min(contentWords.size, msgWords.size);
      if (overlap / smaller >= 0.5 || overlap / contentWords.size >= 0.4 || overlap / msgWords.size >= 0.4) {
        updateStmt.run(now, row.id);
        cancelled++;
      }
    }

    return cancelled;
  }

  /**
   * Convert row to ScheduledItem
   */
  private rowToScheduledItem(row: Record<string, unknown>): ScheduledItem {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      sessionId: row.session_id as string | null,
      source: row.source as ScheduledItemSource,
      messageProvenance: row.message_provenance === 'user_literal' ? 'user_literal' : 'generated',
      kind: (row.kind as ScheduledItemKind) ?? 'nudge',
      type: row.type as ScheduledItemType,
      taskConfig: row.task_config ? JSON.parse(row.task_config as string) : null,
      message: row.message as string,
      context: row.context as string | null,
      triggerAt: row.trigger_at as number,
      recurring: row.recurring ? JSON.parse(row.recurring as string) : null,
      status: row.status as ScheduledItemStatus,
      firedAt: row.fired_at as number | null,
      sourceMemoryId: row.source_memory_id as string | null,
      sourceItemId: row.source_item_id as string | null,
      boardStatus: (row.board_status as BoardStatus) ?? null,
      priority: (row.priority as Priority) ?? 'medium',
      labels: row.labels ? JSON.parse(row.labels as string) : null,
      result: row.result ? JSON.parse(row.result as string) : null,
      dependsOn: row.depends_on ? JSON.parse(row.depends_on as string) : null,
      goalId: (row.goal_id as string) ?? null,
      workerId: (row.worker_id as string) ?? null,
      preferredWorkerId: (row.preferred_worker_id as string) ?? null,
      leaseToken: (row.lease_token as string) ?? null,
      leasedAt: (row.leased_at as number) ?? null,
      leaseExpiresAt: (row.lease_expires_at as number) ?? null,
      attemptCount: (row.attempt_count as number) ?? 0,
      maxAttempts: (row.max_attempts as number) ?? 3,
      lastError: (row.last_error as string) ?? null,
      handedOffFrom: (row.handed_off_from as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // ============ Utility Methods ============

  /**
   * Get memory count
   */
  getMemoryCount(userId?: string): number {
    // Exclude migration sentinel rows from count (they're bookkeeping, not real memories)
    const stmt = userId
      ? this.db.prepare("SELECT COUNT(*) as count FROM memories WHERE user_id = ? AND source != '_cleaned_sentinel'")
      : this.db.prepare("SELECT COUNT(*) as count FROM memories WHERE source != '_cleaned_sentinel'");
    const row = (userId ? stmt.get(userId) : stmt.get()) as { count: number };
    return row.count;
  }

  /**
   * Run a raw SQL query (for advanced use cases)
   */
  raw<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  /**
   * Begin a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database path
   */
  getPath(): string {
    return this.dbPath;
  }

  // ============ Row Conversion Helpers ============

  private rowToMemory(row: Record<string, unknown>): ScallopMemoryEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      content: row.content as string,
      category: row.category as MemoryCategory,
      memoryType: row.memory_type as ScallopMemoryType,
      importance: row.importance as number,
      confidence: row.confidence as number,
      isLatest: (row.is_latest as number) === 1,
      source: (row.source as 'user' | 'assistant') || 'user',
      documentDate: row.document_date as number,
      eventDate: row.event_date as number | null,
      prominence: row.prominence as number,
      lastAccessed: row.last_accessed as number | null,
      accessCount: row.access_count as number,
      sourceChunk: row.source_chunk as string | null,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      learnedFrom: (row.learned_from as string) || 'conversation',
      timesConfirmed: (row.times_confirmed as number) || 1,
      contradictionIds: row.contradiction_ids ? JSON.parse(row.contradiction_ids as string) : null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToRelation(row: Record<string, unknown>): MemoryRelation {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      relationType: row.relation_type as RelationType,
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
    };
  }

  private rowToProfileEntry(row: Record<string, unknown>): UserProfileEntry {
    return {
      userId: row.user_id as string,
      key: row.key as string,
      value: row.value as string,
      confidence: row.confidence as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToDynamicProfile(row: Record<string, unknown>): DynamicProfile {
    return {
      userId: row.user_id as string,
      recentTopics: row.recent_topics ? JSON.parse(row.recent_topics as string) : [],
      currentMood: row.current_mood as string | null,
      activeProjects: row.active_projects ? JSON.parse(row.active_projects as string) : [],
      lastInteraction: row.last_interaction as number,
    };
  }

  private rowToBehavioralPatterns(row: Record<string, unknown>): BehavioralPatterns {
    const rawPrefs: Record<string, unknown> = row.response_preferences
      ? JSON.parse(row.response_preferences as string)
      : {};

    // Extract signal fields from response_preferences JSON
    const messageFrequency = (rawPrefs._sig_messageFrequency as MessageFrequencySignal | undefined) ?? null;
    const sessionEngagement = (rawPrefs._sig_sessionEngagement as SessionEngagementSignal | undefined) ?? null;
    const topicSwitch = (rawPrefs._sig_topicSwitch as TopicSwitchSignal | undefined) ?? null;
    const responseLength = (rawPrefs._sig_responseLength as ResponseLengthSignal | undefined) ?? null;

    // Extract affect fields from response_preferences JSON (plain keys per Phase 24 decision)
    const affectState = (rawPrefs.affectState as AffectEMAState | undefined) ?? null;
    const smoothedAffect = (rawPrefs.smoothedAffect as SmoothedAffect | undefined) ?? null;

    // Build clean responsePreferences without signal fields and affect fields
    const responsePreferences: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawPrefs)) {
      if (!key.startsWith('_sig_') && key !== 'affectState' && key !== 'smoothedAffect') {
        responsePreferences[key] = value;
      }
    }

    return {
      userId: row.user_id as string,
      communicationStyle: row.communication_style as string | null,
      expertiseAreas: row.expertise_areas ? JSON.parse(row.expertise_areas as string) : [],
      responsePreferences,
      activeHours: row.active_hours ? JSON.parse(row.active_hours as string) : [],
      messageFrequency,
      sessionEngagement,
      topicSwitch,
      responseLength,
      affectState,
      smoothedAffect,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToSession(row: Record<string, unknown>): SessionRow {
    return {
      id: row.id as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToSessionMessage(row: Record<string, unknown>): SessionMessageRow {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as string,
      content: row.content as string,
      createdAt: row.created_at as number,
    };
  }

  private rowToBotConfig(row: Record<string, unknown>): BotConfigRow {
    return {
      userId: row.user_id as string,
      botName: row.bot_name as string,
      personalityId: row.personality_id as string,
      customPersonality: row.custom_personality as string | null,
      modelId: row.model_id as string,
      timezone: (row.timezone as string) || 'UTC',
      onboardingComplete: (row.onboarding_complete as number) === 1,
      onboardingStep: row.onboarding_step as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private rowToCostUsage(row: Record<string, unknown>): CostUsageRow {
    return {
      id: row.id as number,
      model: row.model as string,
      provider: row.provider as string,
      sessionId: row.session_id as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      cost: row.cost as number,
      timestamp: row.timestamp as number,
    };
  }

  // ============ Sub-Agent Run Methods ============

  insertSubAgentRun(run: SubAgentRunRow): void {
    this.db.prepare(`
      INSERT INTO subagent_runs (
        id, parent_session_id, child_session_id, task, label, status,
        allowed_skills, model_tier, timeout_ms, input_tokens, output_tokens,
        created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.parentSessionId, run.childSessionId, run.task, run.label, run.status,
      run.allowedSkills, run.modelTier, run.timeoutMs, run.inputTokens, run.outputTokens,
      run.createdAt, run.startedAt ?? null, run.completedAt ?? null
    );
  }

  updateSubAgentRun(id: string, updates: Partial<SubAgentRunRow>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) { setClauses.push('status = ?'); values.push(updates.status); }
    if (updates.resultResponse !== undefined) { setClauses.push('result_response = ?'); values.push(updates.resultResponse); }
    if (updates.resultIterations !== undefined) { setClauses.push('result_iterations = ?'); values.push(updates.resultIterations); }
    if (updates.resultTaskComplete !== undefined) { setClauses.push('result_task_complete = ?'); values.push(updates.resultTaskComplete ? 1 : 0); }
    if (updates.error !== undefined) { setClauses.push('error = ?'); values.push(updates.error); }
    if (updates.inputTokens !== undefined) { setClauses.push('input_tokens = ?'); values.push(updates.inputTokens); }
    if (updates.outputTokens !== undefined) { setClauses.push('output_tokens = ?'); values.push(updates.outputTokens); }
    if (updates.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(updates.startedAt); }
    if (updates.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(updates.completedAt); }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE subagent_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  }

  getSubAgentRunsByParent(parentSessionId: string): SubAgentRunRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at DESC'
    ).all(parentSessionId) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToSubAgentRun(r));
  }

  getActiveSubAgentRuns(): SubAgentRunRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM subagent_runs WHERE status IN ('pending', 'running')"
    ).all() as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToSubAgentRun(r));
  }

  deleteOldSubAgentRuns(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(
      "DELETE FROM subagent_runs WHERE status NOT IN ('pending', 'running') AND created_at < ?"
    ).run(cutoff);
    return result.changes;
  }

  getSubAgentChildSessionIds(maxAgeMs?: number): string[] {
    const sql = maxAgeMs
      ? 'SELECT child_session_id FROM subagent_runs WHERE created_at < ?'
      : 'SELECT child_session_id FROM subagent_runs';
    const params = maxAgeMs ? [Date.now() - maxAgeMs] : [];
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => r.child_session_id as string);
  }

  private rowToSubAgentRun(row: Record<string, unknown>): SubAgentRunRow {
    return {
      id: row.id as string,
      parentSessionId: row.parent_session_id as string,
      childSessionId: row.child_session_id as string,
      task: row.task as string,
      label: row.label as string,
      status: row.status as string,
      allowedSkills: row.allowed_skills as string | null,
      modelTier: row.model_tier as string,
      timeoutMs: row.timeout_ms as number,
      resultResponse: row.result_response as string | null,
      resultIterations: row.result_iterations as number | null,
      resultTaskComplete: row.result_task_complete != null ? !!(row.result_task_complete as number) : null,
      error: row.error as string | null,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      createdAt: row.created_at as number,
      startedAt: row.started_at as number | null,
      completedAt: row.completed_at as number | null,
    };
  }

  // ============ Auth ============

  hasAuthUser(): boolean {
    const row = this.db.prepare('SELECT 1 FROM auth_user WHERE id = 1').get();
    return !!row;
  }

  createAuthUser(email: string, passwordHash: string): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO auth_user (id, email, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).run(email, passwordHash, now, now);
  }

  getAuthUser(): { email: string; passwordHash: string } | null {
    const row = this.db.prepare('SELECT email, password_hash FROM auth_user WHERE id = 1').get() as
      | { email: string; password_hash: string }
      | undefined;
    if (!row) return null;
    return { email: row.email, passwordHash: row.password_hash };
  }

  createAuthSession(token: string, ttlMs: number): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO auth_sessions (token, created_at, expires_at, last_active) VALUES (?, ?, ?, ?)'
    ).run(token, now, now + ttlMs, now);
  }

  validateAuthSession(token: string): boolean {
    const now = Date.now();
    const row = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token = ?').get(token) as
      | { expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now) return false;
    this.db.prepare('UPDATE auth_sessions SET last_active = ? WHERE token = ?').run(now, token);
    return true;
  }

  deleteAuthSession(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  }

  purgeExpiredSessions(): number {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    return result.changes;
  }

  // ============ Runtime Key Vault Operations ============

  setRuntimeKey(key: string, value: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runtime_keys (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now, now);
  }

  getRuntimeKey(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM runtime_keys WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  deleteRuntimeKey(key: string): boolean {
    const result = this.db.prepare('DELETE FROM runtime_keys WHERE key = ?').run(key);
    return result.changes > 0;
  }

  getAllRuntimeKeys(): Array<{ key: string; value: string }> {
    const rows = this.db.prepare('SELECT key, value FROM runtime_keys ORDER BY key').all() as
      Array<{ key: string; value: string }>;
    return rows;
  }

}

/**
 * Create a ScallopDatabase instance
 */
export function createDatabase(dbPath: string): ScallopDatabase {
  return new ScallopDatabase(dbPath);
}
