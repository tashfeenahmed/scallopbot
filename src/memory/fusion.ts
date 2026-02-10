/**
 * Memory Fusion Engine
 *
 * Detects clusters of decaying related memories and merges them into
 * consolidated summaries using LLM-guided content fusion.
 *
 * Pure functions following the reranker.ts pattern:
 * - No DB access — caller provides memories and getRelations callback
 * - LLMProvider passed as argument, not constructor injection
 * - Graceful null return on any LLM error
 *
 * Pipeline: findFusionClusters() -> fuseMemoryCluster() per cluster
 */

import type { ScallopMemoryEntry, MemoryRelation, MemoryCategory } from './db.js';
import type { LLMProvider, CompletionRequest } from '../providers/types.js';
import { PROMINENCE_THRESHOLDS } from './decay.js';

// ============ Types ============

/** Configuration for fusion cluster detection */
export interface FusionConfig {
  /** Minimum cluster size to consider for fusion (default: 3) */
  minClusterSize: number;
  /** Maximum number of clusters to return per tick (default: 5) */
  maxClusters: number;
  /** Minimum prominence for fusion candidates (default: DORMANT = 0.1) */
  minProminence: number;
  /** Maximum prominence for fusion candidates (default: ACTIVE = 0.5) */
  maxProminence: number;
  /** Allow clusters to span multiple categories (default: false). When true, BFS components are used directly without category splitting. */
  crossCategory?: boolean;
}

/** Result of fusing a memory cluster via LLM */
export interface FusionResult {
  /** Consolidated summary text */
  summary: string;
  /** Max importance from source memories */
  importance: number;
  /** Most common category from source memories */
  category: MemoryCategory;
  /** Min confidence from source memories (conservative) */
  confidence: number;
}

/** Default fusion configuration */
export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  minClusterSize: 3,
  maxClusters: 5,
  minProminence: PROMINENCE_THRESHOLDS.DORMANT, // 0.1
  maxProminence: PROMINENCE_THRESHOLDS.ACTIVE,  // 0.5
  crossCategory: false,
};

// ============ Cluster Detection ============

/**
 * Find clusters of related dormant memories suitable for fusion.
 *
 * Pure function. Uses BFS via getRelations callback to find connected
 * components among dormant memories, then splits by category.
 *
 * Filters:
 * - Only isLatest=true memories
 * - Only prominence in [minProminence, maxProminence) range
 * - Excludes static_profile and derived memoryTypes
 *
 * @param memories - Array of candidate memories
 * @param getRelations - Callback to get relations for a memory ID (same as spreadActivation)
 * @param options - Partial FusionConfig overrides
 * @returns Array of memory clusters, sorted by size descending, capped at maxClusters
 */
export function findFusionClusters(
  memories: ScallopMemoryEntry[],
  getRelations: (memoryId: string) => MemoryRelation[],
  options?: Partial<FusionConfig>,
): ScallopMemoryEntry[][] {
  const config: FusionConfig = { ...DEFAULT_FUSION_CONFIG, ...options };

  // Step 1: Filter to eligible memories
  const eligible = memories.filter(m =>
    m.isLatest &&
    m.prominence >= config.minProminence &&
    m.prominence < config.maxProminence &&
    m.memoryType !== 'static_profile' &&
    m.memoryType !== 'derived'
  );

  if (eligible.length === 0) {
    return [];
  }

  // Build lookup sets/maps for BFS
  const eligibleIds = new Set(eligible.map(m => m.id));
  const memoryMap = new Map(eligible.map(m => [m.id, m]));

  // Step 2: BFS to find connected components among eligible memories
  const visited = new Set<string>();
  const components: ScallopMemoryEntry[][] = [];

  for (const memory of eligible) {
    if (visited.has(memory.id)) continue;

    // BFS from this memory
    const component: ScallopMemoryEntry[] = [];
    const queue = [memory.id];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const mem = memoryMap.get(id);
      if (mem) {
        component.push(mem);
      }

      // Traverse relations to find neighbors within eligible set
      const relations = getRelations(id);
      for (const rel of relations) {
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        if (eligibleIds.has(neighborId) && !visited.has(neighborId)) {
          queue.push(neighborId);
        }
      }
    }

    if (component.length > 0) {
      components.push(component);
    }
  }

  // Step 3: Optionally split each component by category into sub-clusters
  let categoryClusters: ScallopMemoryEntry[][];

  if (config.crossCategory) {
    // Cross-category mode: use BFS components directly as clusters
    categoryClusters = components;
  } else {
    // Default mode: split each component by category
    categoryClusters = [];
    for (const component of components) {
      const byCategory = new Map<MemoryCategory, ScallopMemoryEntry[]>();
      for (const mem of component) {
        const existing = byCategory.get(mem.category) || [];
        existing.push(mem);
        byCategory.set(mem.category, existing);
      }

      for (const group of byCategory.values()) {
        categoryClusters.push(group);
      }
    }
  }

  // Step 4: Filter by minClusterSize
  const filtered = categoryClusters.filter(c => c.length >= config.minClusterSize);

  // Step 5: Sort by size descending and cap at maxClusters
  filtered.sort((a, b) => b.length - a.length);

  return filtered.slice(0, config.maxClusters);
}

// ============ LLM Fusion ============

/**
 * Fuse a cluster of memories into a single consolidated summary using an LLM.
 *
 * Pure async function. Returns FusionResult on success, null on any failure:
 * - Empty cluster -> null
 * - LLM call throws -> null
 * - LLM returns invalid JSON -> null
 * - Summary longer than combined sources -> null (validation)
 *
 * @param cluster - Array of memories to fuse
 * @param provider - LLM provider for generating the summary
 * @returns FusionResult or null on failure
 */
export async function fuseMemoryCluster(
  cluster: ScallopMemoryEntry[],
  provider: LLMProvider,
): Promise<FusionResult | null> {
  if (cluster.length === 0) {
    return null;
  }

  try {
    const request = buildFusionPrompt(cluster);
    const response = await provider.complete(request);

    // Extract text from ContentBlock[] response (same pattern as reranker.ts)
    const responseText = Array.isArray(response.content)
      ? response.content.map(block => 'text' in block ? block.text : '').join('')
      : String(response.content);

    // Parse LLM response
    const parsed = parseFusionResponse(responseText);
    if (!parsed) {
      return null;
    }

    // Validate: summary must be shorter than combined source content
    const combinedLength = cluster.reduce((sum, m) => sum + m.content.length, 0);
    if (parsed.summary.length >= combinedLength) {
      return null;
    }

    // Calculate derived values from source memories
    const importance = Math.max(...cluster.map(m => m.importance));
    const confidence = Math.min(...cluster.map(m => m.confidence));
    const category = getMostCommonCategory(cluster);

    return {
      summary: parsed.summary,
      importance,
      category,
      confidence,
    };
  } catch {
    // LLM call failed — return null (caller decides fallback)
    return null;
  }
}

/**
 * Build a CompletionRequest for the fusion LLM call.
 *
 * System prompt instructs merging memories into a single coherent summary.
 * User message lists all memory contents with categories and importance.
 * Requests JSON response with summary, importance, and category.
 * Uses low temperature (0.1) for consistency.
 *
 * Exported for testing (same pattern as buildRerankPrompt).
 */
export function buildFusionPrompt(cluster: ScallopMemoryEntry[]): CompletionRequest {
  const system = `You are a memory consolidation engine. Merge these related memories into a SINGLE concise summary that preserves ALL important facts.

Rules:
1. The summary MUST be shorter than all memories combined
2. Preserve ALL distinct facts — do not drop any unique information
3. Use natural language, not a list
4. The summary should read as a single coherent memory entry
5. Set importance to the highest importance among source memories
6. Set category to the most common category

Respond with JSON only:
{"summary": "...", "importance": 1-10, "category": "preference|fact|event|relationship|insight"}`;

  const memoryLines = cluster
    .map((m, i) => `${i + 1}. [${m.category}] "${m.content}" (importance: ${m.importance})`)
    .join('\n');

  const userMessage = `MEMORIES TO MERGE:
${memoryLines}

Merge into a single concise summary (JSON only):`;

  return {
    messages: [{ role: 'user', content: userMessage }],
    system,
    temperature: 0.1,
    maxTokens: 500,
  };
}

// ============ Internal Helpers ============

/**
 * Parse LLM fusion response to extract summary, importance, and category.
 *
 * Expects JSON with { summary, importance, category }.
 * Returns null if parsing fails or required fields are missing.
 */
function parseFusionResponse(responseText: string): { summary: string; importance: number; category: string } | null {
  if (!responseText || responseText.trim().length === 0) {
    return null;
  }

  // Extract JSON object from response (may have surrounding text)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    if (
      typeof parsed.summary !== 'string' ||
      parsed.summary.trim().length === 0
    ) {
      return null;
    }

    return {
      summary: parsed.summary,
      importance: typeof parsed.importance === 'number' ? parsed.importance : 5,
      category: typeof parsed.category === 'string' ? parsed.category : 'fact',
    };
  } catch {
    return null;
  }
}

/**
 * Get the most common category among a set of memories.
 * Ties broken by the order categories appear in the cluster.
 */
function getMostCommonCategory(memories: ScallopMemoryEntry[]): MemoryCategory {
  const counts = new Map<MemoryCategory, number>();

  for (const mem of memories) {
    counts.set(mem.category, (counts.get(mem.category) || 0) + 1);
  }

  let maxCategory: MemoryCategory = memories[0].category;
  let maxCount = 0;

  for (const [category, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxCategory = category;
    }
  }

  return maxCategory;
}
