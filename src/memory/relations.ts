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

    // If already latest, return it
    if (memory.isLatest) return memory;

    // Find what updates this memory
    const incoming = this.db.getIncomingRelations(memoryId, 'UPDATES');
    if (incoming.length === 0) return memory;

    // Recursively find latest
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
