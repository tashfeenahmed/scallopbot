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

      -- Indexes for performance
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
    `);
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
        document_date, event_date, prominence, last_accessed, access_count,
        source_chunk, embedding, metadata, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
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
      memory.documentDate,
      memory.eventDate,
      memory.prominence,
      memory.lastAccessed,
      memory.accessCount,
      memory.sourceChunk,
      memory.embedding ? JSON.stringify(memory.embedding) : null,
      memory.metadata ? JSON.stringify(memory.metadata) : null,
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
    } = {}
  ): ScallopMemoryEntry[] {
    let query = 'SELECT * FROM memories WHERE user_id = ?';
    const params: unknown[] = [userId];

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
   * Update behavioral patterns
   */
  updateBehavioralPatterns(userId: string, patterns: Partial<Omit<BehavioralPatterns, 'userId' | 'updatedAt'>>): void {
    const now = Date.now();

    const existing = this.db.prepare('SELECT * FROM behavioral_patterns WHERE user_id = ?').get(userId);

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE behavioral_patterns SET
          communication_style = COALESCE(?, communication_style),
          expertise_areas = COALESCE(?, expertise_areas),
          response_preferences = COALESCE(?, response_preferences),
          active_hours = COALESCE(?, active_hours),
          updated_at = ?
        WHERE user_id = ?
      `);
      stmt.run(
        patterns.communicationStyle ?? null,
        patterns.expertiseAreas ? JSON.stringify(patterns.expertiseAreas) : null,
        patterns.responsePreferences ? JSON.stringify(patterns.responsePreferences) : null,
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
        patterns.responsePreferences ? JSON.stringify(patterns.responsePreferences) : '{}',
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

  // ============ Utility Methods ============

  /**
   * Get memory count
   */
  getMemoryCount(userId?: string): number {
    const stmt = userId
      ? this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ?')
      : this.db.prepare('SELECT COUNT(*) as count FROM memories');
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
      documentDate: row.document_date as number,
      eventDate: row.event_date as number | null,
      prominence: row.prominence as number,
      lastAccessed: row.last_accessed as number | null,
      accessCount: row.access_count as number,
      sourceChunk: row.source_chunk as string | null,
      embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
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
    return {
      userId: row.user_id as string,
      communicationStyle: row.communication_style as string | null,
      expertiseAreas: row.expertise_areas ? JSON.parse(row.expertise_areas as string) : [],
      responsePreferences: row.response_preferences ? JSON.parse(row.response_preferences as string) : {},
      activeHours: row.active_hours ? JSON.parse(row.active_hours as string) : [],
      updatedAt: row.updated_at as number,
    };
  }
}

/**
 * Create a ScallopDatabase instance
 */
export function createDatabase(dbPath: string): ScallopDatabase {
  return new ScallopDatabase(dbPath);
}
