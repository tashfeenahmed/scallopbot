/**
 * Memory Relations Graph for ScallopMemory
 *
 * Manages relationships between memories:
 * - UPDATES: New memory supersedes old one
 * - EXTENDS: New memory enriches existing one
 * - DERIVES: Memory inferred from multiple sources
 */

import type {
  ScallopDatabase,
  ScallopMemoryEntry,
  MemoryRelation,
  RelationType,
} from './db.js';
import type { EmbeddingProvider } from './embeddings.js';
import { cosineSimilarity } from './embeddings.js';
import type { LLMProvider } from '../providers/types.js';
import {
  RelationshipClassifier,
  type ClassificationResult,
  type FactToClassify,
  type ExistingFact,
} from './relation-classifier.js';

// ============ Spreading Activation Types & Constants ============

/**
 * Configuration for spreading activation algorithm.
 * All fields have sensible defaults.
 */
export interface ActivationConfig {
  /** Maximum propagation steps (default: 3) */
  maxSteps?: number;
  /** Decay factor per hop (default: 0.5) */
  decayFactor?: number;
  /** Minimum activation to continue propagating (default: 0.01) */
  activationThreshold?: number;
  /** Gaussian noise sigma for retrieval diversity (default: 0.2, 0 = deterministic) */
  noiseSigma?: number;
  /** Minimum score to include in results (default: 0.05) */
  resultThreshold?: number;
  /** Maximum number of results (default: 10) */
  maxResults?: number;
}

/** Resolved config with all defaults applied */
interface ResolvedActivationConfig {
  maxSteps: number;
  decayFactor: number;
  activationThreshold: number;
  noiseSigma: number;
  resultThreshold: number;
  maxResults: number;
}

/** Default activation config values */
const DEFAULT_ACTIVATION_CONFIG: ResolvedActivationConfig = {
  maxSteps: 3,
  decayFactor: 0.5,
  activationThreshold: 0.01,
  noiseSigma: 0.2,
  resultThreshold: 0.05,
  maxResults: 10,
};

/**
 * Edge weights by relation type and direction.
 * Based on ACT-R/SYNAPSE research:
 * - UPDATES: strong bidirectional (0.9/0.9) — both versions highly relevant
 * - EXTENDS: forward-weighted (0.7/0.5) — extension more informative than base
 * - DERIVES: reverse-weighted (0.4/0.6) — sources more relevant than derivations
 */
export const EDGE_WEIGHTS: Record<RelationType, { forward: number; reverse: number }> = {
  UPDATES: { forward: 0.9, reverse: 0.9 },
  EXTENDS: { forward: 0.7, reverse: 0.5 },
  DERIVES: { forward: 0.4, reverse: 0.6 },
};

/**
 * Get the edge weight for a relation traversal from a given node.
 * Multiplies directional weight by the relation's confidence.
 */
export function getEdgeWeight(relation: MemoryRelation, fromId: string): number {
  const weights = EDGE_WEIGHTS[relation.relationType];
  const isForward = relation.sourceId === fromId;
  const directionWeight = isForward ? weights.forward : weights.reverse;
  return directionWeight * relation.confidence;
}

/**
 * Generate Gaussian noise using the Box-Muller transform.
 * Returns 0 when sigma is 0 (deterministic mode).
 */
export function gaussianNoise(sigma: number): number {
  if (sigma === 0) return 0;
  const u1 = Math.random();
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(Math.max(1e-10, u1))) * Math.cos(2 * Math.PI * u2);
}

/**
 * Spreading activation algorithm for memory graph traversal.
 *
 * Pure function. Uses synchronous double-buffered propagation.
 * Replaces unranked BFS with scored, decay-weighted activation propagation.
 *
 * @param seedId - Starting node ID
 * @param getRelations - Function to get relations for a node
 * @param config - Activation configuration
 * @returns Map of nodeId → activation score (seed excluded)
 */
export function spreadActivation(
  seedId: string,
  getRelations: (id: string) => MemoryRelation[],
  config: ActivationConfig = {},
): Map<string, number> {
  const cfg: ResolvedActivationConfig = {
    ...DEFAULT_ACTIVATION_CONFIG,
    ...config,
  };
  const retention = 1 - cfg.decayFactor;

  let current = new Map<string, number>([[seedId, 1.0]]);

  for (let step = 0; step < cfg.maxSteps; step++) {
    const next = new Map<string, number>();

    for (const [id, activation] of current) {
      if (activation < cfg.activationThreshold) continue;

      // Retention: node keeps some activation
      next.set(id, Math.min(1.0, (next.get(id) ?? 0) + activation * retention));

      // Spread to neighbors
      const relations = getRelations(id);
      const degree = relations.length || 1;

      for (const rel of relations) {
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        const edgeWeight = getEdgeWeight(rel, id);
        const spread = activation * edgeWeight * cfg.decayFactor / degree;
        next.set(neighborId, Math.min(1.0, (next.get(neighborId) ?? 0) + spread));
      }
    }

    current = next;
  }

  // Remove seed from results
  current.delete(seedId);

  // Apply noise multiplicatively
  if (cfg.noiseSigma > 0) {
    for (const [id, score] of current) {
      const noisy = score * (1 + gaussianNoise(cfg.noiseSigma));
      current.set(id, Math.max(0, Math.min(1.0, noisy)));
    }
  }

  // Filter by resultThreshold
  for (const [id, score] of current) {
    if (score < cfg.resultThreshold) {
      current.delete(id);
    }
  }

  // Limit to maxResults (keep highest scores)
  if (current.size > cfg.maxResults) {
    const sorted = [...current.entries()].sort((a, b) => b[1] - a[1]);
    current = new Map(sorted.slice(0, cfg.maxResults));
  }

  return current;
}

// ============ End Spreading Activation ============

/**
 * Options for relation detection
 */
export interface RelationDetectionOptions {
  /** Similarity threshold for UPDATES detection (default: 0.7) */
  updateThreshold?: number;
  /** Similarity threshold for EXTENDS detection (default: 0.5) */
  extendThreshold?: number;
  /** Maximum relations to detect per memory (default: 5) */
  maxRelations?: number;
}

/**
 * Result of relation detection
 */
export interface DetectedRelation {
  sourceId: string;
  targetId: string;
  relationType: RelationType;
  confidence: number;
  reason: string;
}

/**
 * Relation Graph Manager
 */
export class RelationGraph {
  private db: ScallopDatabase;
  private embedder?: EmbeddingProvider;
  private options: Required<RelationDetectionOptions>;
  private classifier?: RelationshipClassifier;

  constructor(
    db: ScallopDatabase,
    embedder?: EmbeddingProvider,
    options: RelationDetectionOptions = {},
    classifierProvider?: LLMProvider,
  ) {
    this.db = db;
    this.embedder = embedder;
    this.options = {
      updateThreshold: options.updateThreshold ?? 0.7,
      extendThreshold: options.extendThreshold ?? 0.5,
      maxRelations: options.maxRelations ?? 5,
    };

    if (classifierProvider) {
      this.classifier = new RelationshipClassifier(classifierProvider);
    }
  }

  /**
   * Add an UPDATES relationship (new supersedes old)
   */
  addUpdatesRelation(newMemoryId: string, oldMemoryId: string, confidence: number = 0.8): MemoryRelation {
    return this.db.addRelation(newMemoryId, oldMemoryId, 'UPDATES', confidence);
  }

  /**
   * Add an EXTENDS relationship (new enriches existing)
   */
  addExtendsRelation(newMemoryId: string, existingMemoryId: string, confidence: number = 0.8): MemoryRelation {
    return this.db.addRelation(newMemoryId, existingMemoryId, 'EXTENDS', confidence);
  }

  /**
   * Add a DERIVES relationship (memory inferred from sources)
   */
  addDerivesRelation(derivedMemoryId: string, sourceMemoryId: string, confidence: number = 0.8): MemoryRelation {
    return this.db.addRelation(derivedMemoryId, sourceMemoryId, 'DERIVES', confidence);
  }

  /**
   * Get all relations for a memory
   */
  getRelations(memoryId: string): MemoryRelation[] {
    return this.db.getRelations(memoryId);
  }

  /**
   * Get memories that this memory updates
   */
  getUpdatedMemories(memoryId: string): ScallopMemoryEntry[] {
    const relations = this.db.getOutgoingRelations(memoryId, 'UPDATES');
    return relations
      .map((r) => this.db.getMemory(r.targetId))
      .filter((m): m is ScallopMemoryEntry => m !== null);
  }

  /**
   * Get memories that this memory extends
   */
  getExtendedMemories(memoryId: string): ScallopMemoryEntry[] {
    const relations = this.db.getOutgoingRelations(memoryId, 'EXTENDS');
    return relations
      .map((r) => this.db.getMemory(r.targetId))
      .filter((m): m is ScallopMemoryEntry => m !== null);
  }

  /**
   * Get source memories that this derived memory is based on
   */
  getSourceMemories(derivedMemoryId: string): ScallopMemoryEntry[] {
    const relations = this.db.getOutgoingRelations(derivedMemoryId, 'DERIVES');
    return relations
      .map((r) => this.db.getMemory(r.targetId))
      .filter((m): m is ScallopMemoryEntry => m !== null);
  }

  /**
   * Get memories derived from this memory
   */
  getDerivedMemories(sourceMemoryId: string): ScallopMemoryEntry[] {
    const relations = this.db.getIncomingRelations(sourceMemoryId, 'DERIVES');
    return relations
      .map((r) => this.db.getMemory(r.sourceId))
      .filter((m): m is ScallopMemoryEntry => m !== null);
  }

  /**
   * Get the latest version of a memory (following UPDATES chain)
   */
  getLatestVersion(memoryId: string): ScallopMemoryEntry | null {
    const memory = this.db.getMemory(memoryId);
    if (!memory) return null;

    // Follow UPDATES chain to find the most recent version
    const incoming = this.db.getIncomingRelations(memoryId, 'UPDATES');
    if (incoming.length === 0) return memory;

    // Recursively find latest via UPDATES chain
    return this.getLatestVersion(incoming[0].sourceId);
  }

  /**
   * Get full update history for a memory
   */
  getUpdateHistory(memoryId: string): ScallopMemoryEntry[] {
    const history: ScallopMemoryEntry[] = [];
    const visited = new Set<string>();

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const memory = this.db.getMemory(id);
      if (!memory) return;

      history.push(memory);

      // Get what this memory updates (older versions)
      const older = this.db.getOutgoingRelations(id, 'UPDATES');
      for (const rel of older) {
        traverse(rel.targetId);
      }
    };

    // Find the latest version first
    const latest = this.getLatestVersion(memoryId);
    if (latest) {
      traverse(latest.id);
    }

    // Sort by document date (newest first)
    history.sort((a, b) => b.documentDate - a.documentDate);

    return history;
  }

  /**
   * Detect potential relations for a new memory.
   * Optimized: uses batch embeddings, early exit on high confidence,
   * and pre-filters candidates by category.
   *
   * When an LLM classifier is available, batches all similarity-passing
   * candidates into a single LLM call. Falls back to regex heuristics
   * when no classifier is configured or on LLM failure.
   */
  async detectRelations(
    newMemory: ScallopMemoryEntry,
    candidateMemories?: ScallopMemoryEntry[]
  ): Promise<DetectedRelation[]> {
    // Get candidates if not provided - filter by same category for relevance
    const candidates = candidateMemories ?? this.db.getMemoriesByUser(newMemory.userId, {
      category: newMemory.category,
      isLatest: true,
      limit: 30, // Reduced from 50 - category filter makes this more targeted
    });

    // Filter out the new memory itself
    const filtered = candidates.filter((m) => m.id !== newMemory.id);

    if (filtered.length === 0 || !this.embedder) {
      return [];
    }

    // Get embedding for new memory
    const newEmbedding = newMemory.embedding ?? await this.embedder.embed(newMemory.content);

    // Batch-embed candidates that lack embeddings
    const candidatesNeedingEmbedding = filtered.filter(c => !c.embedding);
    if (candidatesNeedingEmbedding.length > 0) {
      try {
        const batchEmbeddings = await this.embedder.embedBatch(
          candidatesNeedingEmbedding.map(c => c.content)
        );
        for (let i = 0; i < candidatesNeedingEmbedding.length; i++) {
          candidatesNeedingEmbedding[i].embedding = batchEmbeddings[i];
        }
      } catch {
        // Fallback: skip candidates without embeddings
      }
    }

    // Collect candidates that pass similarity threshold
    const similarCandidates: Array<{ memory: ScallopMemoryEntry; similarity: number }> = [];
    for (const candidate of filtered) {
      const candidateEmbedding = candidate.embedding;
      if (!candidateEmbedding) continue;

      const similarity = cosineSimilarity(newEmbedding, candidateEmbedding);
      if (similarity >= this.options.extendThreshold) {
        similarCandidates.push({ memory: candidate, similarity });
      }
    }

    if (similarCandidates.length === 0) {
      return [];
    }

    // Use LLM classifier if available, otherwise regex fallback
    let detected: DetectedRelation[];
    if (this.classifier) {
      detected = await this.classifyWithLLM(newMemory, similarCandidates);
    } else {
      detected = this.classifyWithRegex(newMemory, similarCandidates);
    }

    // Sort by confidence
    detected.sort((a, b) => b.confidence - a.confidence);

    return detected.slice(0, this.options.maxRelations);
  }

  /**
   * Classify relations using LLM-based RelationshipClassifier.
   * Falls back to regex if LLM call fails.
   *
   * Note: RelationshipClassifier internally catches LLM errors and returns
   * { classification: 'NEW', confidence: 0.5, reason: '...failed...' }.
   * We detect this pattern to trigger regex fallback.
   */
  private async classifyWithLLM(
    newMemory: ScallopMemoryEntry,
    similarCandidates: Array<{ memory: ScallopMemoryEntry; similarity: number }>,
  ): Promise<DetectedRelation[]> {
    try {
      const newFact = this.memoryToFact(newMemory);
      const existingFacts = similarCandidates.map(c => this.memoryToExistingFact(c.memory));

      let classificationResults: ClassificationResult[];

      if (similarCandidates.length === 1) {
        // Single candidate: use classify()
        const result = await this.classifier!.classify(newFact, existingFacts);
        classificationResults = [result];
      } else {
        // Multiple candidates: use classifyBatch() for efficiency
        // classifyBatch takes new facts to classify against existing facts.
        // Here we have one new fact but want to classify it against each existing fact.
        // We send one new fact per existing candidate so the LLM compares each pair.
        const newFacts = similarCandidates.map(() => newFact);
        classificationResults = await this.classifier!.classifyBatch(newFacts, existingFacts);
      }

      // Detect LLM failure: classifier swallows errors and returns all NEW with
      // confidence 0.5 and a "failed" reason. Fall back to regex in this case.
      const allFailed = classificationResults.every(
        r => r.classification === 'NEW' && r.confidence === 0.5 && r.reason.includes('failed')
      );
      if (allFailed) {
        return this.classifyWithRegex(newMemory, similarCandidates);
      }

      // Map classification results to DetectedRelation[]
      const detected: DetectedRelation[] = [];
      for (let i = 0; i < classificationResults.length; i++) {
        const result = classificationResults[i];
        const candidate = similarCandidates[i];

        // Filter out NEW classifications (no relation)
        if (result.classification === 'NEW') {
          continue;
        }

        const relation: DetectedRelation = {
          sourceId: newMemory.id,
          targetId: result.targetId ?? candidate.memory.id,
          relationType: result.classification as RelationType,
          confidence: result.confidence,
          reason: result.reason,
        };

        detected.push(relation);

        // Early exit: high-confidence UPDATE found
        if (relation.relationType === 'UPDATES' && relation.confidence >= 0.85) {
          break;
        }
      }

      return detected;
    } catch {
      // LLM threw an uncaught error — fall back to regex for all candidates
      return this.classifyWithRegex(newMemory, similarCandidates);
    }
  }

  /**
   * Classify relations using regex-based heuristics (original behavior).
   */
  private classifyWithRegex(
    newMemory: ScallopMemoryEntry,
    similarCandidates: Array<{ memory: ScallopMemoryEntry; similarity: number }>,
  ): DetectedRelation[] {
    const detected: DetectedRelation[] = [];

    for (const { memory: candidate, similarity } of similarCandidates) {
      const relation = this.classifyRelation(newMemory, candidate, similarity);

      if (relation) {
        detected.push(relation);

        // Early exit: high-confidence UPDATE found
        if (relation.relationType === 'UPDATES' && relation.confidence >= 0.85) {
          break;
        }
      }

      if (detected.length >= this.options.maxRelations) {
        break;
      }
    }

    return detected;
  }

  /**
   * Convert a ScallopMemoryEntry to FactToClassify for the LLM classifier.
   */
  private memoryToFact(memory: ScallopMemoryEntry): FactToClassify {
    return {
      content: memory.content,
      subject: memory.userId,
      category: memory.category,
    };
  }

  /**
   * Convert a ScallopMemoryEntry to ExistingFact for the LLM classifier.
   */
  private memoryToExistingFact(memory: ScallopMemoryEntry): ExistingFact {
    return {
      id: memory.id,
      content: memory.content,
      subject: memory.userId,
      category: memory.category,
    };
  }

  /**
   * Classify the relationship type between two memories
   */
  private classifyRelation(
    newMemory: ScallopMemoryEntry,
    existingMemory: ScallopMemoryEntry,
    similarity: number
  ): DetectedRelation | null {
    const newContent = newMemory.content.toLowerCase();
    const existingContent = existingMemory.content.toLowerCase();

    // Check for UPDATES (contradiction/replacement)
    if (similarity >= this.options.updateThreshold) {
      // High similarity but different values suggests update
      if (this.detectContradiction(newContent, existingContent)) {
        return {
          sourceId: newMemory.id,
          targetId: existingMemory.id,
          relationType: 'UPDATES',
          confidence: similarity,
          reason: 'High similarity with contradicting values',
        };
      }
    }

    // Check for EXTENDS (enrichment)
    if (similarity >= this.options.extendThreshold && similarity < this.options.updateThreshold) {
      // Medium similarity suggests related but different info
      if (this.detectEnrichment(newContent, existingContent)) {
        return {
          sourceId: newMemory.id,
          targetId: existingMemory.id,
          relationType: 'EXTENDS',
          confidence: similarity,
          reason: 'Related content with additional details',
        };
      }
    }

    return null;
  }

  /**
   * Normalize a value by stripping prepositions and trimming.
   * "at Dublin" -> "dublin", "in Dublin" -> "dublin", "is Dublin" -> "dublin"
   */
  private normalizeValue(value: string): string {
    return value
      .replace(/^(?:is|at|in|for|the|a|an)\s+/i, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Detect if two contents contradict each other.
   * Normalizes prepositions before comparison so "office is Dublin"
   * and "office at Dublin" are recognized as the same value.
   */
  private detectContradiction(newContent: string, existingContent: string): boolean {
    // Common patterns that indicate contradiction - capture value with surrounding prepositions
    const patterns = [
      { extract: /lives?\s+(?:in\s+)?([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /works?\s+(?:at|for|with)\s+([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /office\s+(?:is\s+|at\s+|in\s+)?([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /prefers?\s+([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /name[:\s]+([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /based\s+(?:in\s+)?([a-z\s]+?)(?:\.|,|$)/i },
      { extract: /located\s+(?:in\s+|at\s+)?([a-z\s]+?)(?:\.|,|$)/i },
    ];

    for (const { extract } of patterns) {
      const newMatch = newContent.match(extract);
      const existingMatch = existingContent.match(extract);

      if (newMatch && existingMatch) {
        const newVal = this.normalizeValue(newMatch[1]);
        const existingVal = this.normalizeValue(existingMatch[1]);

        if (newVal !== existingVal && newVal.length > 0 && existingVal.length > 0) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Detect if new content enriches existing content
   */
  private detectEnrichment(newContent: string, existingContent: string): boolean {
    // Check if new content is longer and contains existing keywords
    if (newContent.length > existingContent.length * 1.2) {
      const existingWords = existingContent.split(/\s+/).filter((w) => w.length > 3);
      const matchCount = existingWords.filter((w) => newContent.includes(w)).length;

      // If most existing words appear in new content, it's enrichment
      if (matchCount >= existingWords.length * 0.5) {
        return true;
      }
    }

    return false;
  }

  /**
   * Apply detected relations to the database
   */
  applyRelations(relations: DetectedRelation[]): MemoryRelation[] {
    const applied: MemoryRelation[] = [];

    for (const rel of relations) {
      const memoryRelation = this.db.addRelation(
        rel.sourceId,
        rel.targetId,
        rel.relationType,
        rel.confidence
      );
      applied.push(memoryRelation);
    }

    return applied;
  }

  /**
   * Get related memories for context injection
   */
  getRelatedMemoriesForContext(memoryId: string, maxDepth: number = 2): ScallopMemoryEntry[] {
    const related: ScallopMemoryEntry[] = [];
    const visited = new Set<string>();

    const traverse = (id: string, depth: number) => {
      if (depth > maxDepth || visited.has(id)) return;
      visited.add(id);

      const relations = this.db.getRelations(id);

      for (const rel of relations) {
        const relatedId = rel.sourceId === id ? rel.targetId : rel.sourceId;

        if (!visited.has(relatedId)) {
          const memory = this.db.getMemory(relatedId);
          if (memory && memory.isLatest) {
            related.push(memory);
            traverse(relatedId, depth + 1);
          }
        }
      }
    };

    traverse(memoryId, 0);

    return related;
  }

  /**
   * Get related memories using spreading activation.
   *
   * Replaces BFS with scored, decay-weighted activation propagation.
   * Multiplies activation by memory prominence for final ranking.
   * Filters to isLatest memories only.
   * Falls back to getRelatedMemoriesForContext on any error.
   *
   * @param memoryId - Seed memory ID
   * @param config - Optional activation configuration
   * @returns ScallopMemoryEntry[] sorted by final score descending
   */
  getRelatedMemoriesWithActivation(
    memoryId: string,
    config?: ActivationConfig,
  ): ScallopMemoryEntry[] {
    try {
      const activationMap = spreadActivation(
        memoryId,
        (id) => this.db.getRelations(id),
        config,
      );

      // Score each memory: activation * prominence, filter to isLatest
      const scored: Array<{ memory: ScallopMemoryEntry; score: number }> = [];

      for (const [id, activation] of activationMap) {
        const memory = this.db.getMemory(id);
        if (!memory || !memory.isLatest) continue;

        const score = activation * memory.prominence;
        if (score >= (config?.resultThreshold ?? DEFAULT_ACTIVATION_CONFIG.resultThreshold)) {
          scored.push({ memory, score });
        }
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      // Limit to maxResults
      const maxResults = config?.maxResults ?? DEFAULT_ACTIVATION_CONFIG.maxResults;
      return scored.slice(0, maxResults).map(s => s.memory);
    } catch {
      // Fall back to BFS-based retrieval on any error
      return this.getRelatedMemoriesForContext(memoryId);
    }
  }
}

/**
 * Create a RelationGraph instance
 */
export function createRelationGraph(
  db: ScallopDatabase,
  embedder?: EmbeddingProvider,
  options?: RelationDetectionOptions,
  classifierProvider?: LLMProvider,
): RelationGraph {
  return new RelationGraph(db, embedder, options, classifierProvider);
}
