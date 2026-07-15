/**
 * Decay Engine for ScallopMemory
 *
 * Implements brain-inspired memory decay:
 * - Older memories decay faster
 * - User-confirmed memories decay slower
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
  /** @deprecated Accepted for configuration compatibility; retrieval no longer reinforces memory. */
  accessBoostMultiplier?: number;
  /** @deprecated Accepted for configuration compatibility; retrieval remains telemetry only. */
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
  age: 0.55,
  confirmationFrequency: 0.20,
  confirmationRecency: 0.10,
  semanticImportance: 0.10,
  confidence: 0.05,
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
   * Additive weighted sum of age, genuine confirmation, importance and confidence.
   * Each factor is normalized to [0, 1] before weighting to prevent saturation.
   */
  calculateProminence(memory: ScallopMemoryEntry): number {
    // Static profile memories never decay
    if (memory.memoryType === 'static_profile') {
      return 1.0;
    }

    const now = Date.now();

    // Age factor
    const ageAnchor = memory.eventDate ?? memory.documentDate;
    const ageMs = Math.max(0, now - ageAnchor);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Grace period: new memories need time to be understood and naturally
    // reinforced; whether the software happened to retrieve them is irrelevant.
    if (ageDays < 1) {
      return 1.0;
    }

    // Get decay rate (combine type and category rates)
    const typeRate = this.config.typeDecayRates[memory.memoryType] ?? this.config.baseDecayRate;
    const categoryRate = this.config.categoryDecayRates[memory.category] ?? this.config.baseDecayRate;

    // Category expresses how humans retain this kind of information. Memory
    // type modifies exceptional states without allowing ordinary retrieval to
    // turn a short-lived event into a permanent fact.
    const decayRate = memory.memoryType === 'superseded'
      ? Math.min(typeRate, categoryRate)
      : memory.memoryType === 'derived'
        ? Math.max(typeRate, categoryRate)
        : categoryRate;

    // Age-based decay
    const ageDecay = Math.pow(decayRate, ageDays);

    // Retrieval is machine behaviour, not evidence that the memory matters to
    // the user. Only repeated user statements (timesConfirmed) reinforce it.
    const confirmationCount = Math.max(1, memory.timesConfirmed ?? 1);
    const confirmationFrequency = Math.min(1, Math.log2(1 + confirmationCount) / Math.log2(9));
    const confirmationRecency = confirmationCount > 1
      ? Math.exp(-Math.max(0, now - memory.updatedAt) / (30 * 24 * 60 * 60 * 1000))
      : 0;

    // Importance weight: importance / 10
    const importanceWeight = memory.importance / 10;

    // Calculate weighted prominence (each factor in [0, 1], weights sum to 1.0)
    const prominence =
      ageDecay * DECAY_WEIGHTS.age +
      confirmationFrequency * DECAY_WEIGHTS.confirmationFrequency +
      confirmationRecency * DECAY_WEIGHTS.confirmationRecency +
      importanceWeight * DECAY_WEIGHTS.semanticImportance +
      memory.confidence * DECAY_WEIGHTS.confidence;

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

/**
 * Compute utility score for a memory.
 *
 * Formula: prominence × ln(2 + confirmationCount)
 *
 * Automatic retrieval never boosts retention. The second argument is the
 * number of genuine user confirmations (normally timesConfirmed - 1).
 */
export function computeUtilityScore(prominence: number, confirmationCount: number): number {
  return prominence * Math.log(2 + confirmationCount);
}
