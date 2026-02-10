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
export type ScheduledItemStatus = 'pending' | 'fired' | 'dismissed' | 'expired';

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

  // Type/category
  type: ScheduledItemType;

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

  createdAt: number;
  updatedAt: number;
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
      CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);

      -- Indexes for scheduled_items
      CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_items(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_source ON scheduled_items(source);
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_items(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_trigger_at ON scheduled_items(trigger_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_items(status, trigger_at) WHERE status = 'pending';
    `);

    // Migration: Add source column to existing databases
    this.migrateAddSourceColumn();

    // Migration: Add timezone column to bot_config
    this.migrateAddTimezoneColumn();

    // Migration: Consolidate all memory user_ids to 'default' (single-user bot)
    this.migrateConsolidateMemoryUserIds();

    // Migration: Add source memory columns (learned_from, times_confirmed, contradiction_ids)
    this.migrateAddSourceMemoryColumns();

    // Migration: Clean polluted memory entries (skill outputs, assistant responses stored as facts)
    this.migrateCleanPollutedMemories();
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
    } catch {
      // Column might already exist or table might not exist yet
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
    } catch {
      // Column might already exist or table might not exist yet
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
    } catch {
      // Tables might not exist yet on fresh DB
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
    } catch {
      // Columns might already exist or table might not exist yet
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
    } catch {
      // Migration failure is non-fatal
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
    const stmt = this.db.prepare('UPDATE memories SET prominence = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();

    const transaction = this.db.transaction(() => {
      for (const { id, prominence } of updates) {
        stmt.run(prominence, now, id);
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

    // If this is an UPDATES relation, mark the target as superseded
    if (relationType === 'UPDATES') {
      this.db.prepare(`
        UPDATE memories SET is_latest = 0, memory_type = 'superseded', updated_at = ?
        WHERE id = ?
      `).run(now, targetId);
    }

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
  addScheduledItem(item: Omit<ScheduledItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'firedAt'> & { status?: ScheduledItemStatus }): ScheduledItem {
    const id = nanoid();
    const now = Date.now();
    const status = item.status ?? 'pending';

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_items (
        id, user_id, session_id, source, type, message, context,
        trigger_at, recurring, status, source_memory_id, fired_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      item.userId,
      item.sessionId ?? null,
      item.source,
      item.type,
      item.message,
      item.context ?? null,
      item.triggerAt,
      item.recurring ? JSON.stringify(item.recurring) : null,
      status,
      item.sourceMemoryId ?? null,
      null,
      now,
      now
    );

    return {
      ...item,
      id,
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
          claimed.push(this.rowToScheduledItem(row));
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
      SET status = 'fired', fired_at = ?, updated_at = ?
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
      SET status = 'dismissed', updated_at = ?
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
    const stmt = this.db.prepare(`UPDATE scheduled_items SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    return result.changes > 0;
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

    const stopWords = new Set(['the', 'a', 'an', 'at', 'on', 'in', 'to', 'for', 'of', 'and', 'is', 'my', 'me', 'i', 'you', 'your', 'about',
      'remind', 'reminder', 'remember', 'check', 'follow', 'up', 'user', 'upcoming', 'scheduled']);
    const normalizeText = (text: string): Set<string> => {
      return new Set(
        text.toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter(word => word.length > 2 && !stopWords.has(word))
      );
    };

    const isSimilar = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size === 0 || b.size === 0) return false;
      let overlap = 0;
      for (const word of a) {
        if (b.has(word)) overlap++;
      }
      const smaller = Math.min(a.size, b.size);
      return (overlap / smaller) >= 0.8 || (overlap / a.size) >= 0.4 || (overlap / b.size) >= 0.4;
    };

    // Group by user
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.user_id) || [];
      list.push(row);
      byUser.set(row.user_id, list);
    }

    const toDelete: string[] = [];
    const deleteStmt = this.db.prepare('DELETE FROM scheduled_items WHERE id = ?');

    for (const items of byUser.values()) {
      const kept = new Set<number>(); // indices we've already decided to keep
      for (let i = 0; i < items.length; i++) {
        if (toDelete.includes(items[i].id)) continue;
        kept.add(i);
        const wordsI = normalizeText(items[i].message);
        for (let j = i + 1; j < items.length; j++) {
          if (toDelete.includes(items[j].id)) continue;
          // Only compare items within 7 days of each other
          if (Math.abs(items[i].trigger_at - items[j].trigger_at) > 7 * 24 * 60 * 60 * 1000) continue;
          const wordsJ = normalizeText(items[j].message);
          if (isSimilar(wordsI, wordsJ)) {
            toDelete.push(items[j].id); // keep earlier (i), remove later (j)
          }
        }
      }
    }

    for (const id of toDelete) {
      deleteStmt.run(id);
    }

    return toDelete.length;
  }

  /**
   * Expire old pending items (older than maxAgeMs past their trigger time)
   */
  expireOldScheduledItems(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    const stmt = this.db.prepare(`
      UPDATE scheduled_items
      SET status = 'expired', updated_at = ?
      WHERE status IN ('pending', 'processing') AND trigger_at < ?
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
      WHERE user_id = ? AND status = 'pending'
        AND trigger_at BETWEEN ? AND ?
    `);
    const rows = stmt.all(userId, now - withinMs, now + withinMs * 7) as Array<{ message: string }>;

    if (rows.length === 0) return false;

    // Normalize and extract significant words
    const stopWords = new Set(['the', 'a', 'an', 'at', 'on', 'in', 'to', 'for', 'of', 'and', 'is', 'my', 'me', 'i', 'you', 'your', 'about',
      'remind', 'reminder', 'remember', 'check', 'follow', 'up', 'user', 'upcoming', 'scheduled']);
    const normalizeText = (text: string): Set<string> => {
      return new Set(
        text.toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter(word => word.length > 2 && !stopWords.has(word))
      );
    };

    const newWords = normalizeText(message);
    if (newWords.size === 0) return false;

    for (const row of rows) {
      const existingWords = normalizeText(row.message);
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
      if (similaritySmaller >= 0.8 || similarityNew >= 0.4 || similarityExisting >= 0.4) {
        return true;
      }
    }

    return false;
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
      type: row.type as ScheduledItemType,
      message: row.message as string,
      context: row.context as string | null,
      triggerAt: row.trigger_at as number,
      recurring: row.recurring ? JSON.parse(row.recurring as string) : null,
      status: row.status as ScheduledItemStatus,
      firedAt: row.fired_at as number | null,
      sourceMemoryId: row.source_memory_id as string | null,
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

}

/**
 * Create a ScallopDatabase instance
 */
export function createDatabase(dbPath: string): ScallopDatabase {
  return new ScallopDatabase(dbPath);
}
