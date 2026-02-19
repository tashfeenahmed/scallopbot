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
/** Lenient similarity: either side has this fraction overlap */
const DEDUP_SIMILARITY_LENIENT = 0.4;

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

  // Board (kanban) fields
  boardStatus: BoardStatus | null;   // null = legacy item, compute from status
  priority: Priority;
  labels: string[] | null;
  result: BoardItemResult | null;
  dependsOn: string[] | null;        // IDs of items this depends on
  goalId: string | null;             // FK to memories.id (goal/milestone)

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

    // Initialize schema
    this.initializeSchema();
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
    `);

    // Migration: Add source column to existing databases
    this.migrateAddSourceColumn();

    // Migration: Add timezone column to bot_config
    this.migrateAddTimezoneColumn();

    // Migration: Consolidate all memory user_ids to 'default' (single-user bot)
    this.migrateConsolidateMemoryUserIds();

    // Migration: Consolidate session_summaries and scheduled_items user_ids to 'default'
    this.migrateConsolidateSessionSummaryUserIds();
    this.migrateConsolidateScheduledItemUserIds();

    // Migration: Add source memory columns (learned_from, times_confirmed, contradiction_ids)
    this.migrateAddSourceMemoryColumns();

    // Migration: Clean polluted memory entries (skill outputs, assistant responses stored as facts)
    this.migrateCleanPollutedMemories();

    // Migration: Add kind and task_config columns to scheduled_items
    this.migrateAddKindColumn();

    // Migration: Add board (kanban) columns to scheduled_items
    this.migrateAddBoardColumns();

    // Migration: Backfill board_status for legacy items where it's NULL
    this.migrateBackfillBoardStatus();
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
        // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateAddTimezoneColumn: ${error.message}`);
      }
    }
  }

  /**
   * Consolidate all memory user_ids to 'default' (single-user bot).
   * Memories may have been stored under channel-prefixed userIds like
   * "telegram:12345" or "api:ws-xxx" — merge them all to 'default'.
   */
  private migrateConsolidateMemoryUserIds(): void {
    try {
      const result = this.db.prepare(
        "UPDATE memories SET user_id = 'default' WHERE user_id != 'default'"
      ).run();
      if (result.changes > 0) {
        // Also consolidate user_profiles
        this.db.prepare(
          "DELETE FROM user_profiles WHERE user_id != 'default' AND key IN (SELECT key FROM user_profiles WHERE user_id = 'default')"
        ).run();
        this.db.prepare(
          "UPDATE user_profiles SET user_id = 'default' WHERE user_id != 'default'"
        ).run();
      }
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateConsolidateMemoryUserIds: ${error.message}`);
      }
    }
  }

  /**
   * Consolidate all session_summaries user_ids to 'default' (single-user bot).
   * Session summaries may have been stored under channel-prefixed userIds like
   * "telegram:12345" — merge them all to 'default'.
   */
  private migrateConsolidateSessionSummaryUserIds(): void {
    try {
      this.db.prepare(
        "UPDATE session_summaries SET user_id = 'default' WHERE user_id != 'default'"
      ).run();
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateConsolidateSessionSummaryUserIds: ${error.message}`);
      }
    }
  }

  /**
   * Consolidate all scheduled_items user_ids to 'default' (single-user bot).
   * Scheduled items may have been stored under channel-prefixed userIds like
   * "telegram:12345" — merge them all to 'default'.
   */
  private migrateConsolidateScheduledItemUserIds(): void {
    try {
      this.db.prepare(
        "UPDATE scheduled_items SET user_id = 'default' WHERE user_id != 'default'"
      ).run();
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateConsolidateScheduledItemUserIds: ${error.message}`);
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
        // eslint-disable-next-line no-console
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
          // eslint-disable-next-line no-console
          console.log(`[memory-cleanup] Removed invalid timezone: "${tzRow.value}"`);
        }

        // Remove mood values that describe bot behavior
        const moodRow = this.db.prepare(
          "SELECT value FROM user_profiles WHERE user_id = 'default' AND key = 'mood'"
        ).get() as { value: string } | undefined;
        if (moodRow && /\b(assist|help|check|remind|offer|execute|search|follow-up)\b/i.test(moodRow.value)) {
          this.db.prepare("DELETE FROM user_profiles WHERE user_id = 'default' AND key = 'mood'").run();
          // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.log(`[memory-cleanup] Trimmed focus from ${items.length} to 5 items`);
          }
        }

        return { skillResult, assistantResult, proactiveResult, questionResult, longResult };
      });

      const { skillResult, assistantResult, proactiveResult, questionResult, longResult } = migrate();
      const total = skillResult.changes + assistantResult.changes + proactiveResult.changes + questionResult.changes + longResult.changes;
      if (total > 0) {
        // eslint-disable-next-line no-console
        console.log(`[memory-cleanup] Archived ${total} polluted entries: ${skillResult.changes} skill outputs, ${assistantResult.changes} long assistant responses, ${proactiveResult.changes} proactive messages, ${questionResult.changes} questions, ${longResult.changes} oversized entries`);
      }
    } catch (error) {
      // Migration failure is non-fatal but log for debugging
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateCleanPollutedMemories: ${error.message}`);
      }
    }
  }

  /**
   * Add kind and task_config columns to scheduled_items table if they don't exist.
   * Backfills event_prep items as kind='task'.
   */
  private migrateAddKindColumn(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(scheduled_items)").all() as Array<{ name: string }>;
      const hasKindColumn = tableInfo.some(col => col.name === 'kind');

      if (!hasKindColumn) {
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'nudge'");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN task_config TEXT DEFAULT NULL");
        // Backfill: event_prep items become tasks
        this.db.exec("UPDATE scheduled_items SET kind = 'task' WHERE type = 'event_prep'");
      }
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateAddKindColumn: ${error.message}`);
      }
    }
  }

  /**
   * Add board columns to scheduled_items table if they don't exist.
   * Adds: board_status, priority, labels, result, depends_on, goal_id
   */
  private migrateAddBoardColumns(): void {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(scheduled_items)").all() as Array<{ name: string }>;
      const hasBoardStatus = tableInfo.some(col => col.name === 'board_status');

      if (!hasBoardStatus) {
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN board_status TEXT DEFAULT NULL");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN priority TEXT DEFAULT 'medium'");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN labels TEXT DEFAULT NULL");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN result TEXT DEFAULT NULL");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN depends_on TEXT DEFAULT NULL");
        this.db.exec("ALTER TABLE scheduled_items ADD COLUMN goal_id TEXT DEFAULT NULL");

        // Indexes for board queries
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_board ON scheduled_items(user_id, board_status)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_priority ON scheduled_items(priority)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_goal ON scheduled_items(goal_id)");
      }
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateAddBoardColumns: ${error.message}`);
      }
    }
  }

  /**
   * Backfill board_status for legacy rows where it's NULL.
   * Uses the same CASE logic as computeBoardStatus() in board/types.ts.
   */
  private migrateBackfillBoardStatus(): void {
    try {
      this.db.exec(`
        UPDATE scheduled_items
        SET board_status = CASE
          WHEN status = 'pending' AND trigger_at > 0 THEN 'scheduled'
          WHEN status = 'pending' THEN 'inbox'
          WHEN status = 'processing' THEN 'in_progress'
          WHEN status IN ('fired', 'acted') THEN 'done'
          WHEN status IN ('dismissed', 'expired') THEN 'archived'
          ELSE 'inbox'
        END
        WHERE board_status IS NULL
      `);
    } catch (error) {
      if (error instanceof Error) {
        // eslint-disable-next-line no-console
        console.warn(`[migration] migrateBackfillBoardStatus: ${error.message}`);
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

    return true;
  }

  /**
   * Delete a memory
   */
  deleteMemory(id: string): boolean {
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
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
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
    if (options.isLatest !== undefined) {
      query += ' AND is_latest = ?';
      params.push(options.isLatest ? 1 : 0);
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

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT id, embedding FROM memories WHERE id IN (${placeholders})`
    );
    const rows = stmt.all(...ids) as Array<{ id: string; embedding: string | null }>;

    const result = new Map<string, number[]>();
    for (const row of rows) {
      if (row.embedding) {
        result.set(row.id, JSON.parse(row.embedding));
      }
    }
    return result;
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
  addScheduledItem(item: Omit<ScheduledItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'firedAt' | 'kind' | 'taskConfig' | 'boardStatus' | 'priority' | 'labels' | 'result' | 'dependsOn' | 'goalId'> & { status?: ScheduledItemStatus; kind?: ScheduledItemKind; taskConfig?: TaskConfig | null; boardStatus?: BoardStatus | null; priority?: Priority; labels?: string[] | null; dependsOn?: string[] | null; goalId?: string | null }): ScheduledItem {
    const id = nanoid();
    const now = Date.now();
    const status = item.status ?? 'pending';

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, kind, type, message, context,
        trigger_at, recurring, status, source_memory_id, fired_at,
        task_config, board_status, priority, labels, depends_on, goal_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      item.userId,
      item.sessionId ?? null,
      item.source,
      item.kind ?? 'nudge',
      item.type,
      item.message,
      item.context ?? null,
      item.triggerAt,
      item.recurring ? JSON.stringify(item.recurring) : null,
      status,
      item.sourceMemoryId ?? null,
      null,
      item.taskConfig ? JSON.stringify(item.taskConfig) : null,
      item.boardStatus ?? (item.triggerAt > 0 ? 'scheduled' : 'inbox'),
      item.priority ?? 'medium',
      item.labels ? JSON.stringify(item.labels) : null,
      item.dependsOn ? JSON.stringify(item.dependsOn) : null,
      item.goalId ?? null,
      now,
      now
    );

    return {
      ...item,
      id,
      kind: item.kind ?? 'nudge',
      taskConfig: item.taskConfig ?? null,
      boardStatus: item.boardStatus ?? (item.triggerAt > 0 ? 'scheduled' : 'inbox'),
      priority: item.priority ?? 'medium',
      labels: item.labels ?? null,
      result: null,
      dependsOn: item.dependsOn ?? null,
      goalId: item.goalId ?? null,
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
      WHERE status = 'pending' AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `);
    const rows = stmt.all(now) as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledItem(row));
  }

  /**
   * Atomically claim due items by selecting them AND marking as 'processing'.
   * Uses a transaction to prevent duplicate processing when scheduler ticks overlap.
   */
  claimDueScheduledItems(now: number = Date.now()): ScheduledItem[] {
    const selectStmt = this.db.prepare(`
      SELECT * FROM scheduled_items
      WHERE status = 'pending' AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `);
    const updateStmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'processing', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    // Wrap in an IMMEDIATE transaction so the SELECT+UPDATE is atomic.
    // IMMEDIATE acquires a reserved lock upfront, preventing concurrent
    // transactions from interleaving between our SELECT and UPDATE.
    const claimTransaction = this.db.transaction(() => {
      const rows = selectStmt.all(now) as Record<string, unknown>[];
      const claimed: ScheduledItem[] = [];

      for (const row of rows) {
        const result = updateStmt.run(now, row.id);
        if (result.changes > 0) {
          // Override status to reflect the UPDATE we just performed
          const item = this.rowToScheduledItem(row);
          item.status = 'processing';
          claimed.push(item);
        }
      }

      return claimed;
    });

    return claimTransaction.immediate();
  }

  /**
   * Reset an item back to pending (e.g. after a processing failure)
   */
  resetScheduledItemToPending(id: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'pending', updated_at = ?
      WHERE id = ? AND status = 'processing'
    `);
    const result = stmt.run(now, id);
    return result.changes > 0;
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
   * Update a scheduled item (e.g., reschedule)
   */
  updateScheduledItem(id: string, updates: Partial<Pick<ScheduledItem, 'triggerAt' | 'message' | 'status'>>): boolean {
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
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
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
   * Groups pending items by user, then removes duplicates using word-overlap similarity.
   * Keeps the earliest-created item in each duplicate group.
   * Returns the number of duplicates removed.
   */
  consolidateDuplicateScheduledItems(): number {
    const stmt = this.db.prepare(`
      SELECT id, user_id, message, trigger_at, created_at FROM scheduled_items
      WHERE status = 'pending'
      ORDER BY user_id, created_at ASC
    `);
    const rows = stmt.all() as Array<{ id: string; user_id: string; message: string; trigger_at: number; created_at: number }>;

    const isSimilar = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size === 0 || b.size === 0) return false;
      let overlap = 0;
      for (const word of a) {
        if (b.has(word)) overlap++;
      }
      const smaller = Math.min(a.size, b.size);
      return (overlap / smaller) >= DEDUP_SIMILARITY_STRICT || (overlap / a.size) >= DEDUP_SIMILARITY_LENIENT || (overlap / b.size) >= DEDUP_SIMILARITY_LENIENT;
    };

    // Group by user
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.user_id) || [];
      list.push(row);
      byUser.set(row.user_id, list);
    }

    const toDelete = new Set<string>();
    const deleteStmt = this.db.prepare('DELETE FROM scheduled_items WHERE id = ?');

    for (const items of byUser.values()) {
      const kept = new Set<number>(); // indices we've already decided to keep
      for (let i = 0; i < items.length; i++) {
        if (toDelete.has(items[i].id)) continue;
        kept.add(i);
        const wordsI = normalizeForSimilarity(items[i].message);
        for (let j = i + 1; j < items.length; j++) {
          if (toDelete.has(items[j].id)) continue;
          // Only compare items within 7 days of each other
          if (Math.abs(items[i].trigger_at - items[j].trigger_at) > 7 * 24 * 60 * 60 * 1000) continue;
          const wordsJ = normalizeForSimilarity(items[j].message);
          if (isSimilar(wordsI, wordsJ)) {
            toDelete.add(items[j].id); // keep earlier (i), remove later (j)
          }
        }
      }
    }

    for (const id of toDelete) {
      deleteStmt.run(id);
    }

    return toDelete.size;
  }

  /**
   * Expire old pending items (older than maxAgeMs past their trigger time)
   */
  expireOldScheduledItems(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    // Only expire non-recurring items. Recurring items that are overdue
    // will be picked up by the scheduler and rescheduled after firing.
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', updated_at = ?
      WHERE status IN ('pending', 'processing') AND trigger_at < ?
        AND recurring IS NULL
    `);
    const result = stmt.run(now, cutoff);
    return result.changes;
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
      UPDATE scheduled_items SET status = 'expired', updated_at = ?
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
      UPDATE scheduled_items SET status = 'expired', updated_at = ? WHERE id = ?
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
      boardStatus: (row.board_status as BoardStatus) ?? null,
      priority: (row.priority as Priority) ?? 'medium',
      labels: row.labels ? JSON.parse(row.labels as string) : null,
      result: row.result ? JSON.parse(row.result as string) : null,
      dependsOn: row.depends_on ? JSON.parse(row.depends_on as string) : null,
      goalId: (row.goal_id as string) ?? null,
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
