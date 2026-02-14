/**
 * Decay Engine for ScallopMemory
 *
 * Implements brain-inspired memory decay:
 * - Older memories decay faster
 * - Frequently accessed memories decay slower
 * - Different decay rates by memory type and category
 * - Smart forgetting (affects ranking, not deletion)
 */

import type { ScallopDatabase, ScallopMemoryEntry, ScallopMemoryType, MemoryCategory } from './db.js';

/**
 * Decay configuration
 */
export interface DecayConfig {
  /** Base decay rate (default: 0.97) */
  baseDecayRate?: number;
  /** Access boost multiplier (default: 0.1) */
  accessBoostMultiplier?: number;
  /** Maximum access count for boost calculation (default: 10) */
  maxAccessCount?: number;
  /** Custom decay rates by memory type */
  typeDecayRates?: Partial<Record<ScallopMemoryType, number>>;
  /** Custom decay rates by category */
  categoryDecayRates?: Partial<Record<MemoryCategory, number>>;
}

/**
 * Default decay rates by memory type
 */
const DEFAULT_TYPE_DECAY_RATES: Record<ScallopMemoryType, number> = {
  static_profile: 1.0, // No decay
  dynamic_profile: 0.99, // Very slow
  regular: 0.97, // Medium
  derived: 0.98, // Slow (inferences valued higher)
  superseded: 0.90, // Fast (old versions decay quickly)
};

/**
 * Default decay rates by category
 */
const DEFAULT_CATEGORY_DECAY_RATES: Record<MemoryCategory, number> = {
  preference: 0.995, // ~138 days half-life
  fact: 0.99, // ~69 days half-life
  event: 0.95, // ~14 days half-life
  relationship: 0.998, // ~346 days half-life
  insight: 0.97, // ~23 days half-life
};

/**
 * Decay factor weights
 */
const DECAY_WEIGHTS = {
  age: 0.30,
  accessFrequency: 0.25,
  recencyOfAccess: 0.25,
  semanticImportance: 0.20,
};

/**
 * Prominence thresholds
 */
export const PROMINENCE_THRESHOLDS = {
  /** Active - included in context automatically */
  ACTIVE: 0.5,
  /** Dormant - searchable only via explicit query */
  DORMANT: 0.1,
  /** Archived - excluded from search, still in DB */
  ARCHIVED: 0.0,
};

/**
 * Decay Engine
 */
export class DecayEngine {
  private config: Required<DecayConfig>;

  constructor(config: DecayConfig = {}) {
    this.config = {
      baseDecayRate: config.baseDecayRate ?? 0.97,
      accessBoostMultiplier: config.accessBoostMultiplier ?? 0.1,
      maxAccessCount: config.maxAccessCount ?? 10,
      typeDecayRates: {
        ...DEFAULT_TYPE_DECAY_RATES,
        ...config.typeDecayRates,
      },
      categoryDecayRates: {
        ...DEFAULT_CATEGORY_DECAY_RATES,
        ...config.categoryDecayRates,
      },
    };
  }

  /**
   * Calculate prominence for a single memory
   *
   * Additive weighted sum of age decay, access frequency, recency of access, and importance.
   * Each factor is normalized to [0, 1] before weighting to prevent saturation.
   */
  calculateProminence(memory: ScallopMemoryEntry): number {
    // Static profile memories never decay
    if (memory.memoryType === 'static_profile') {
      return 1.0;
    }

    const now = Date.now();

    // Age factor
    const ageMs = now - memory.documentDate;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Grace period: memories less than 1 day old with no access history
    // start at full prominence — they need time to be discovered by search.
    if (ageDays < 1 && memory.accessCount === 0) {
      return 1.0;
    }

    // Get decay rate (combine type and category rates)
    const typeRate = this.config.typeDecayRates[memory.memoryType] ?? this.config.baseDecayRate;
    const categoryRate = this.config.categoryDecayRates[memory.category] ?? this.config.baseDecayRate;

    // Use the slower of the two rates (more preservation)
    const decayRate = Math.max(typeRate, categoryRate);

    // Age-based decay
    const ageDecay = Math.pow(decayRate, ageDays);

    // Access boost: scales with how often the memory has been retrieved.
    // Never-accessed memories (accessCount=0) get a reduced baseline — a memory
    // that was stored but never retrieved is less valuable than one the system
    // has actively used in responses.
    const accessCount = Math.min(memory.accessCount, this.config.maxAccessCount);
    const accessBoost = accessCount === 0
      ? 0.5
      : 1 + (this.config.accessBoostMultiplier * accessCount);

    // Recency of access boost.
    // Never-accessed memories get a neutral baseline (1.0) — the absence of any
    // retrieval means there's no recency signal, but shouldn't double-penalize
    // since accessBoost already handles the "never accessed" signal.
    let recencyBoost = 1.0;
    if (memory.lastAccessed) {
      const lastAccessAgeDays = (now - memory.lastAccessed) / (1000 * 60 * 60 * 24);
      // Boost decays over 7 days
      recencyBoost = 1 + 0.3 * Math.exp(-lastAccessAgeDays / 7);
    }

    // Importance weight: importance / 10
    const importanceWeight = memory.importance / 10;

    // Normalize access factors to [0, 1] so weighted sum can't exceed 1.0.
    // This prevents high-access memories from saturating at prominence=1.0
    // and preserves meaningful differentiation across the full range.
    const maxAccessBoost = 1 + (this.config.accessBoostMultiplier * this.config.maxAccessCount);
    const maxRecencyBoost = 1.3; // 1 + 0.3 (recency coefficient)
    const normalizedAccess = accessBoost / maxAccessBoost;
    const normalizedRecency = recencyBoost / maxRecencyBoost;

    // Calculate weighted prominence (each factor in [0, 1], weights sum to 1.0)
    const prominence =
      ageDecay * DECAY_WEIGHTS.age +
      normalizedAccess * DECAY_WEIGHTS.accessFrequency +
      normalizedRecency * DECAY_WEIGHTS.recencyOfAccess +
      importanceWeight * DECAY_WEIGHTS.semanticImportance;

    // High-importance identity facts (importance >= 8) get moderate protection.
    // Floor at 0.2 (above DORMANT=0.1, below ACTIVE=0.5) so they remain searchable
    // but can eventually be corrected/superseded rather than being permanently sticky.
    if (memory.importance >= 8 && (memory.category === 'relationship' || memory.category === 'fact')) {
      return Math.max(0.2, Math.min(1, prominence));
    }

    // Normalize to 0-1 range
    return Math.max(0, Math.min(1, prominence));
  }

  /**
   * Calculate decay for memories that may have meaningfully changed.
   * Incremental: only fetches recently updated, recently accessed, or
   * old enough that decay matters. Limits to 500 per tick.
   */
  calculateAllDecay(db: ScallopDatabase): Array<{ id: string; prominence: number }> {
    return this.calculateIncrementalDecay(db);
  }

  /**
   * Incremental decay: target memories whose prominence may have changed.
   * - Recently updated (last 5 minutes)
   * - Recently accessed (last 5 minutes)
   * - Older than 1 day with prominence > ARCHIVED threshold
   * Caps at 500 per tick to bound CPU/IO.
   */
  private calculateIncrementalDecay(db: ScallopDatabase): Array<{ id: string; prominence: number }> {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Fetch candidates: recently touched OR old enough that decay matters
    const candidates = db.raw<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE memory_type != 'static_profile'
         AND (
           updated_at > ?
           OR last_accessed > ?
           OR (document_date < ? AND prominence > ?)
         )
       ORDER BY prominence DESC
       LIMIT 500`,
      [fiveMinAgo, fiveMinAgo, oneDayAgo, PROMINENCE_THRESHOLDS.ARCHIVED]
    );

    // Convert raw rows to ScallopMemoryEntry objects
    const updates: Array<{ id: string; prominence: number }> = [];
    for (const row of candidates) {
      const memory = db.getMemory(row.id as string);
      if (!memory) continue;

      const newProminence = this.calculateProminence(memory);
      if (Math.abs(memory.prominence - newProminence) > 0.01) {
        updates.push({ id: memory.id, prominence: newProminence });
      }
    }

    return updates;
  }

  /**
   * Full decay scan (for deep consolidation). Processes ALL non-static memories.
   */
  calculateFullDecay(db: ScallopDatabase): Array<{ id: string; prominence: number }> {
    const memories = db.getAllMemories({ minProminence: 0.01 });
    const updates: Array<{ id: string; prominence: number }> = [];

    for (const memory of memories) {
      const newProminence = this.calculateProminence(memory);
      if (Math.abs(memory.prominence - newProminence) > 0.01) {
        updates.push({ id: memory.id, prominence: newProminence });
      }
    }

    return updates;
  }

  /**
   * Process incremental decay (light tick - bounded set of memories)
   */
  processDecay(db: ScallopDatabase): { updated: number; archived: number } {
    const updates = this.calculateAllDecay(db);

    if (updates.length > 0) {
      db.updateProminences(updates);
    }

    // Count how many are now below archive threshold
    const archived = updates.filter((u) => u.prominence < PROMINENCE_THRESHOLDS.DORMANT).length;

    return {
      updated: updates.length,
      archived,
    };
  }

  /**
   * Process full decay scan (deep tick - all memories)
   */
  processFullDecay(db: ScallopDatabase): { updated: number; archived: number } {
    const updates = this.calculateFullDecay(db);

    if (updates.length > 0) {
      db.updateProminences(updates);
    }

    const archived = updates.filter((u) => u.prominence < PROMINENCE_THRESHOLDS.DORMANT).length;

    return {
      updated: updates.length,
      archived,
    };
  }

  /**
   * Get memory status based on prominence
   */
  getMemoryStatus(prominence: number): 'active' | 'dormant' | 'archived' {
    if (prominence >= PROMINENCE_THRESHOLDS.ACTIVE) {
      return 'active';
    }
    if (prominence >= PROMINENCE_THRESHOLDS.DORMANT) {
      return 'dormant';
    }
    return 'archived';
  }

  /**
   * Calculate half-life for a given decay rate
   */
  static calculateHalfLife(decayRate: number): number {
    // Half-life = log(0.5) / log(decayRate)
    return Math.log(0.5) / Math.log(decayRate);
  }

  /**
   * Get decay rate info for debugging
   */
  getDecayInfo(): {
    typeRates: Record<ScallopMemoryType, { rate: number; halfLifeDays: number }>;
    categoryRates: Record<MemoryCategory, { rate: number; halfLifeDays: number }>;
  } {
    const typeRates = {} as Record<ScallopMemoryType, { rate: number; halfLifeDays: number }>;
    const categoryRates = {} as Record<MemoryCategory, { rate: number; halfLifeDays: number }>;

    for (const [type, rate] of Object.entries(this.config.typeDecayRates)) {
      typeRates[type as ScallopMemoryType] = {
        rate,
        halfLifeDays: rate === 1.0 ? Infinity : DecayEngine.calculateHalfLife(rate),
      };
    }

    for (const [category, rate] of Object.entries(this.config.categoryDecayRates)) {
      categoryRates[category as MemoryCategory] = {
        rate,
        halfLifeDays: DecayEngine.calculateHalfLife(rate),
      };
    }

    return { typeRates, categoryRates };
  }
}

/**
 * Create a DecayEngine instance with default config
 */
export function createDecayEngine(config?: DecayConfig): DecayEngine {
  return new DecayEngine(config);
}
