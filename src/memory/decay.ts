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
   * Formula: prominence = base × decay_rate^age_days × access_boost × importance_weight
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

    // Get decay rate (combine type and category rates)
    const typeRate = this.config.typeDecayRates[memory.memoryType] ?? this.config.baseDecayRate;
    const categoryRate = this.config.categoryDecayRates[memory.category] ?? this.config.baseDecayRate;

    // Use the slower of the two rates (more preservation)
    const decayRate = Math.max(typeRate, categoryRate);

    // Age-based decay
    const ageDecay = Math.pow(decayRate, ageDays);

    // Access boost: 1 + (0.1 × min(access_count, 10))
    const accessCount = Math.min(memory.accessCount, this.config.maxAccessCount);
    const accessBoost = 1 + (this.config.accessBoostMultiplier * accessCount);

    // Recency of access boost
    let recencyBoost = 1.0;
    if (memory.lastAccessed) {
      const lastAccessAgeDays = (now - memory.lastAccessed) / (1000 * 60 * 60 * 24);
      // Boost decays over 7 days
      recencyBoost = 1 + 0.3 * Math.exp(-lastAccessAgeDays / 7);
    }

    // Importance weight: importance / 10
    const importanceWeight = memory.importance / 10;

    // Calculate weighted prominence
    const prominence =
      ageDecay * DECAY_WEIGHTS.age +
      accessBoost * DECAY_WEIGHTS.accessFrequency +
      recencyBoost * DECAY_WEIGHTS.recencyOfAccess +
      importanceWeight * DECAY_WEIGHTS.semanticImportance;

    // High-importance identity facts (importance >= 8) get extra protection
    if (memory.importance >= 8 && (memory.category === 'relationship' || memory.category === 'fact')) {
      return Math.max(0.5, Math.min(1, prominence));
    }

    // Normalize to 0-1 range
    return Math.max(0, Math.min(1, prominence));
  }

  /**
   * Calculate decay for all memories in database
   */
  calculateAllDecay(db: ScallopDatabase): Array<{ id: string; prominence: number }> {
    const memories = db.getAllMemories();
    const updates: Array<{ id: string; prominence: number }> = [];

    for (const memory of memories) {
      const newProminence = this.calculateProminence(memory);

      // Only update if changed significantly (avoid unnecessary writes)
      if (Math.abs(memory.prominence - newProminence) > 0.01) {
        updates.push({ id: memory.id, prominence: newProminence });
      }
    }

    return updates;
  }

  /**
   * Process decay for all memories (batch update)
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
