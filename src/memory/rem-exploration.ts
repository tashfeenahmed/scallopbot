/**
 * REM Exploration Module
 *
 * Stochastic seed sampling, high-noise spreading activation for neighbor
 * discovery, and LLM-judge connection validation.
 *
 * Implements the REM phase of the dream cycle:
 * - sampleSeeds: diversity-weighted seed selection with category caps
 * - buildConnectionJudgePrompt: structured LLM request for connection evaluation
 * - parseJudgeResponse: JSON parsing with NO_CONNECTION and failure handling
 * - remExplore: full pipeline orchestration with per-seed error isolation
 *
 * Pure functions following the nrem-consolidation.ts pattern:
 * - No DB access — caller provides memories and getRelations callback
 * - LLMProvider passed as argument, not constructor injection
 * - Per-seed error isolation (try/catch, increment failures)
 *
 * Pipeline: filterByProminence → sampleSeeds → spreadActivation per seed →
 *           filterKnownRelations → LLM judge → collect discoveries
 */

import type { ScallopMemoryEntry, MemoryRelation } from './db.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';
import { spreadActivation, gaussianNoise } from './relations.js';

// ============ Types ============

/** Configuration for REM exploration */
export interface RemConfig {
  /** Gaussian noise sigma for spreading activation (default: 0.6) */
  noiseSigma: number;
  /** Maximum number of seeds per cycle (default: 6) */
  maxSeeds: number;
  /** Maximum candidates per seed after activation (default: 8) */
  maxCandidatesPerSeed: number;
  /** Gaussian noise sigma for seed weighting (default: 0.3) */
  seedNoiseSigma: number;
  /** Maximum seeds per category for diversity (default: 2) */
  maxSeedsPerCategory: number;
  /** Maximum propagation steps for spreading activation (default: 4) */
  maxSteps: number;
  /** Decay factor per hop for spreading activation (default: 0.4) */
  decayFactor: number;
  /** Minimum activation score to include in results (default: 0.02) */
  resultThreshold: number;
  /** Minimum activation to continue propagating (default: 0.005) */
  activationThreshold: number;
  /** Minimum average judge score to accept a connection (default: 3.0) */
  minJudgeScore: number;
  /** Prominence window for eligible memories */
  prominenceWindow: { min: number; max: number };
}

/** A discovered novel connection between two memories */
export interface RemDiscovery {
  /** ID of the seed memory */
  seedId: string;
  /** ID of the discovered neighbor */
  neighborId: string;
  /** LLM-generated description of the novel connection */
  connectionDescription: string;
  /** Confidence score from LLM judge (0.0-1.0) */
  confidence: number;
  /** Novelty score from LLM judge (1-5) */
  noveltyScore: number;
  /** Plausibility score from LLM judge (1-5) */
  plausibilityScore: number;
  /** Usefulness score from LLM judge (1-5) */
  usefulnessScore: number;
}

/** Result of a full REM exploration cycle */
export interface RemExplorationResult {
  /** Number of seeds explored */
  seedsExplored: number;
  /** Number of candidates evaluated by LLM judge */
  candidatesEvaluated: number;
  /** Accepted novel connections */
  discoveries: RemDiscovery[];
  /** Number of per-seed failures */
  failures: number;
}

/** Default REM configuration */
export const DEFAULT_REM_CONFIG: RemConfig = {
  noiseSigma: 0.6,
  maxSeeds: 6,
  maxCandidatesPerSeed: 8,
  seedNoiseSigma: 0.3,
  maxSeedsPerCategory: 2,
  maxSteps: 4,
  decayFactor: 0.4,
  resultThreshold: 0.02,
  activationThreshold: 0.005,
  minJudgeScore: 3.0,
  prominenceWindow: { min: 0.05, max: 0.8 },
};

// ============ Seed Sampling ============

/**
 * Sample diverse seed memories for REM exploration.
 *
 * Weights each memory by importance x prominence x (1 + gaussianNoise(seedNoiseSigma)),
 * sorts descending, and takes top-K with category diversity (max maxSeedsPerCategory
 * per category).
 *
 * Pure function — uses gaussianNoise from relations.ts.
 *
 * @param memories - Array of eligible memories
 * @param config - Partial RemConfig overrides
 * @returns Array of selected seed memories (up to maxSeeds)
 */
export function sampleSeeds(
  memories: ScallopMemoryEntry[],
  config: Partial<RemConfig>,
): ScallopMemoryEntry[] {
  if (memories.length === 0) {
    return [];
  }

  const cfg = { ...DEFAULT_REM_CONFIG, ...config };

  // Weight each memory by importance x prominence x (1 + noise)
  const weighted = memories.map(m => ({
    memory: m,
    weight: m.importance * m.prominence * (1 + gaussianNoise(cfg.seedNoiseSigma)),
  }));

  // Sort descending by weight
  weighted.sort((a, b) => b.weight - a.weight);

  // Take top-K with category diversity
  const seeds: ScallopMemoryEntry[] = [];
  const categoryCounts = new Map<string, number>();

  for (const { memory } of weighted) {
    const catCount = categoryCounts.get(memory.category) ?? 0;
    if (catCount < cfg.maxSeedsPerCategory) {
      seeds.push(memory);
      categoryCounts.set(memory.category, catCount + 1);
      if (seeds.length >= cfg.maxSeeds) break;
    }
  }

  return seeds;
}

// ============ Connection Judge Prompt ============

/**
 * Build a CompletionRequest for the LLM connection judge.
 *
 * System prompt instructs evaluation of potential memory connections
 * during creative exploration. User message includes full content of
 * seed and neighbor plus any existing relations.
 *
 * Requests JSON with novelty, plausibility, usefulness scores (1-5).
 * If average >= minJudgeScore: include connection description + confidence.
 * Otherwise: NO_CONNECTION.
 *
 * Exported for testing.
 *
 * @param seed - Seed memory
 * @param neighbor - Discovered neighbor memory
 * @param existingRelations - Any known relations for context
 * @returns CompletionRequest ready for LLM call
 */
export function buildConnectionJudgePrompt(
  seed: ScallopMemoryEntry,
  neighbor: ScallopMemoryEntry,
  existingRelations: MemoryRelation[],
): CompletionRequest {
  const system = `You are a memory connection evaluator during creative exploration. You evaluate potential novel connections between memories discovered through stochastic graph traversal.

For each pair of memories, determine if there is a genuine novel insight connecting them.

Evaluate three dimensions (each 1-5):
1. NOVELTY: Is this connection non-obvious? Would it surprise the user?
2. PLAUSIBILITY: Is there a genuine conceptual bridge between these memories?
3. USEFULNESS: Could this connection inform future reasoning or actions?

If the average score >= 3.0, respond with JSON:
{"novelty": N, "plausibility": N, "usefulness": N, "connection": "one-sentence description of the novel link", "confidence": 0.0-1.0}

If the average score < 3.0, respond with JSON:
{"novelty": N, "plausibility": N, "usefulness": N, "connection": "NO_CONNECTION"}

Respond with JSON only.`;

  const relationLines = existingRelations.length > 0
    ? existingRelations
        .map(r => `- ${r.sourceId} ${r.relationType} ${r.targetId} (confidence: ${r.confidence})`)
        .join('\n')
    : 'No existing relations between these memories.';

  const userMessage = `SEED MEMORY:
"${seed.content}" [${seed.category}, importance: ${seed.importance}]

DISCOVERED NEIGHBOR:
"${neighbor.content}" [${neighbor.category}, importance: ${neighbor.importance}]

EXISTING RELATIONS:
${relationLines}

Evaluate the potential connection (JSON only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.3,
    maxTokens: 300,
  };
}

// ============ Response Parsing ============

/** Parsed result from the LLM judge */
interface JudgeResult {
  novelty: number;
  plausibility: number;
  usefulness: number;
  connection?: string;
  confidence?: number;
}

/**
 * Parse LLM judge response to extract scores and connection description.
 *
 * Follows the parseFusionResponse pattern from fusion.ts:
 * - Extract JSON from response text via regex
 * - Handle NO_CONNECTION case
 * - Return null on parse failure (graceful)
 *
 * @param text - Raw LLM response text
 * @returns Parsed JudgeResult or null on failure
 */
export function parseJudgeResponse(text: string): JudgeResult | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  // Extract JSON object from response (may have surrounding text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Require at least the score fields
    const novelty = typeof parsed.novelty === 'number' ? parsed.novelty : undefined;
    const plausibility = typeof parsed.plausibility === 'number' ? parsed.plausibility : undefined;
    const usefulness = typeof parsed.usefulness === 'number' ? parsed.usefulness : undefined;

    if (novelty === undefined || plausibility === undefined || usefulness === undefined) {
      return null;
    }

    return {
      novelty,
      plausibility,
      usefulness,
      connection: typeof parsed.connection === 'string' ? parsed.connection : undefined,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    };
  } catch {
    return null;
  }
}

// ============ Orchestrator ============

/**
 * REM exploration orchestrator.
 *
 * Orchestrates the full REM exploration pipeline:
 * 1. Filter memories by prominenceWindow
 * 2. Call sampleSeeds to select diverse seeds
 * 3. For each seed: spreadActivation with REM noise config
 * 4. Filter out neighbors that already have direct relations with seed
 * 5. For each remaining candidate: buildConnectionJudgePrompt -> LLM -> parseJudgeResponse
 * 6. Collect RemDiscovery for accepted connections (avg score >= minJudgeScore)
 * 7. Per-seed error isolation (try/catch, increment failures)
 *
 * Pure async function. No DB access — caller provides memories, getRelations,
 * and LLMProvider.
 *
 * @param memories - Array of candidate memories
 * @param getRelations - Callback to get relations for a memory ID
 * @param provider - LLM provider for connection judge
 * @param options - Optional partial config overrides
 * @returns RemExplorationResult with totals
 */
export async function remExplore(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  provider: LLMProvider,
  options?: Partial<RemConfig>,
): Promise<RemExplorationResult> {
  const config = { ...DEFAULT_REM_CONFIG, ...options };

  if (memories.length === 0) {
    return { seedsExplored: 0, candidatesEvaluated: 0, discoveries: [], failures: 0 };
  }

  // Step 1: Filter memories by prominence window
  const eligible = memories.filter(m =>
    m.prominence >= config.prominenceWindow.min &&
    m.prominence < config.prominenceWindow.max,
  );

  if (eligible.length === 0) {
    return { seedsExplored: 0, candidatesEvaluated: 0, discoveries: [], failures: 0 };
  }

  // Step 2: Sample diverse seeds
  const seeds = sampleSeeds(eligible, config);

  if (seeds.length === 0) {
    return { seedsExplored: 0, candidatesEvaluated: 0, discoveries: [], failures: 0 };
  }

  // Build a memory lookup for resolving neighbor IDs from activation results
  const memoryMap = new Map(eligible.map(m => [m.id, m]));

  // Step 3-7: Process each seed with error isolation
  const discoveries: RemDiscovery[] = [];
  let candidatesEvaluated = 0;
  let failures = 0;

  for (const seed of seeds) {
    try {
      // Step 3: Spreading activation with REM noise config
      const activationMap = spreadActivation(seed.id, getRelations, {
        maxSteps: config.maxSteps,
        decayFactor: config.decayFactor,
        noiseSigma: config.noiseSigma,
        resultThreshold: config.resultThreshold,
        maxResults: config.maxCandidatesPerSeed,
        activationThreshold: config.activationThreshold,
      });

      // Step 4: Filter out neighbors with direct relations to seed
      const seedRelations = getRelations(seed.id);
      const directlyConnected = new Set<string>();
      for (const rel of seedRelations) {
        const neighborId = rel.sourceId === seed.id ? rel.targetId : rel.sourceId;
        directlyConnected.add(neighborId);
      }

      const candidates: Array<{ memory: ScallopMemoryEntry; activation: number }> = [];
      for (const [neighborId, activation] of activationMap) {
        // Skip if directly connected to seed
        if (directlyConnected.has(neighborId)) continue;

        // Also check neighbor's relations for bidirectional coverage
        const neighborRelations = getRelations(neighborId);
        const hasDirectLink = neighborRelations.some(
          r => r.sourceId === seed.id || r.targetId === seed.id,
        );
        if (hasDirectLink) continue;

        const memory = memoryMap.get(neighborId);
        if (memory) {
          candidates.push({ memory, activation });
        }
      }

      if (candidates.length === 0) continue;

      // Step 5-6: LLM judge each candidate
      for (const { memory: neighbor } of candidates) {
        try {
          candidatesEvaluated++;

          const existingRelations = [
            ...getRelations(seed.id),
            ...getRelations(neighbor.id),
          ];

          const request = buildConnectionJudgePrompt(seed, neighbor, existingRelations);
          const response = await provider.complete(request);

          // Extract text from ContentBlock[] response
          const responseText = Array.isArray(response.content)
            ? response.content.map(block => 'text' in block ? block.text : '').join('')
            : String(response.content);

          const parsed = parseJudgeResponse(responseText);
          if (!parsed) continue;

          // Check NO_CONNECTION
          if (parsed.connection === 'NO_CONNECTION') continue;

          // Check average score against minJudgeScore
          const avgScore = (parsed.novelty + parsed.plausibility + parsed.usefulness) / 3;
          if (avgScore < config.minJudgeScore) continue;

          // Accepted discovery
          discoveries.push({
            seedId: seed.id,
            neighborId: neighbor.id,
            connectionDescription: parsed.connection || '',
            confidence: parsed.confidence ?? avgScore / 5,
            noveltyScore: parsed.novelty,
            plausibilityScore: parsed.plausibility,
            usefulnessScore: parsed.usefulness,
          });
        } catch {
          // Per-candidate failure — continue to next candidate
          continue;
        }
      }
    } catch {
      // Per-seed error isolation
      failures++;
    }
  }

  return {
    seedsExplored: seeds.length,
    candidatesEvaluated,
    discoveries,
    failures,
  };
}
