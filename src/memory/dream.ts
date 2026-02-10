/**
 * Dream Orchestrator
 *
 * Unified entry point for the sleep-tick dream cycle. Coordinates
 * NREM consolidation followed by REM exploration in sequence,
 * following the biological NREM→REM ordering from PAD research.
 *
 * Pure function — no DB access. Delegates all logic to:
 * - nremConsolidate (nrem-consolidation.ts) for deep sleep consolidation
 * - remExplore (rem-exploration.ts) for creative association discovery
 *
 * Error isolation between phases:
 * - NREM failure → catch, set nrem=null, still attempt REM
 * - REM failure → catch, set rem=null, preserve NREM result
 *
 * Skip flags (skipNrem, skipRem) work independently for testing
 * or incremental rollout.
 */

import type { ScallopMemoryEntry, MemoryRelation } from './db.js';
import type { LLMProvider } from '../providers/types.js';
import { nremConsolidate, type NremConfig, type NremResult } from './nrem-consolidation.js';
import { remExplore, type RemConfig, type RemExplorationResult } from './rem-exploration.js';

// ============ Types ============

/** Configuration for the dream cycle */
export interface DreamConfig {
  /** Partial NREM config overrides */
  nrem?: Partial<NremConfig>;
  /** Partial REM config overrides */
  rem?: Partial<RemConfig>;
  /** Skip NREM consolidation phase */
  skipNrem?: boolean;
  /** Skip REM exploration phase */
  skipRem?: boolean;
}

/** Combined result of a dream cycle */
export interface DreamResult {
  /** NREM consolidation result, or null if skipped/failed */
  nrem: NremResult | null;
  /** REM exploration result, or null if skipped/failed */
  rem: RemExplorationResult | null;
}

// ============ Orchestrator ============

/**
 * Run a complete dream cycle: NREM consolidation followed by REM exploration.
 *
 * Sequential execution — NREM runs first, then REM. Each phase is wrapped
 * in try/catch for error isolation: a failure in one phase does not prevent
 * the other from running or returning its results.
 *
 * Pure async function. No DB access — caller provides memories, getRelations,
 * and LLM providers.
 *
 * @param memories - Array of candidate memories
 * @param getRelations - Callback to get relations for a memory ID
 * @param nremProvider - LLM provider for NREM consolidation
 * @param remProvider - LLM provider for REM exploration
 * @param config - Optional dream cycle configuration
 * @returns DreamResult with nrem and rem results (null if skipped/failed)
 */
export async function dream(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  nremProvider: LLMProvider,
  remProvider: LLMProvider,
  config?: DreamConfig,
): Promise<DreamResult> {
  let nrem: NremResult | null = null;
  let rem: RemExplorationResult | null = null;

  // Phase 1: NREM consolidation
  if (!config?.skipNrem) {
    try {
      nrem = await nremConsolidate(memories, getRelations, nremProvider, config?.nrem);
    } catch {
      // NREM failure — set null, continue to REM
      nrem = null;
    }
  }

  // Phase 2: REM exploration
  if (!config?.skipRem) {
    try {
      rem = await remExplore(memories, getRelations, remProvider, config?.rem);
    } catch {
      // REM failure — set null, preserve NREM result
      rem = null;
    }
  }

  return { nrem, rem };
}
