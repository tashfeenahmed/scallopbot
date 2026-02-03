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

  constructor(
    db: ScallopDatabase,
    embedder?: EmbeddingProvider,
    options: RelationDetectionOptions = {}
  ) {
    this.db = db;
    this.embedder = embedder;
    this.options = {
      updateThreshold: options.updateThreshold ?? 0.7,
      extendThreshold: options.extendThreshold ?? 0.5,
      maxRelations: options.maxRelations ?? 5,
    };
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
   * Detect potential relations for a new memory
   */
  async detectRelations(
    newMemory: ScallopMemoryEntry,
    candidateMemories?: ScallopMemoryEntry[]
  ): Promise<DetectedRelation[]> {
    const detected: DetectedRelation[] = [];

    // Get candidates if not provided
    const candidates = candidateMemories ?? this.db.getMemoriesByUser(newMemory.userId, {
      category: newMemory.category,
      isLatest: true,
      limit: 50,
    });

    // Filter out the new memory itself
    const filtered = candidates.filter((m) => m.id !== newMemory.id);

    if (filtered.length === 0 || !this.embedder) {
      return detected;
    }

    // Get embedding for new memory
    const newEmbedding = newMemory.embedding ?? await this.embedder.embed(newMemory.content);

    for (const candidate of filtered) {
      // Get embedding for candidate
      const candidateEmbedding = candidate.embedding ?? await this.embedder.embed(candidate.content);

      // Calculate similarity
      const similarity = cosineSimilarity(newEmbedding, candidateEmbedding);

      // Detect relation type based on similarity and content analysis
      const relation = this.classifyRelation(newMemory, candidate, similarity);

      if (relation) {
        detected.push(relation);
      }

      // Stop if we have enough relations
      if (detected.length >= this.options.maxRelations) {
        break;
      }
    }

    // Sort by confidence
    detected.sort((a, b) => b.confidence - a.confidence);

    return detected.slice(0, this.options.maxRelations);
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
   * Detect if two contents contradict each other
   */
  private detectContradiction(newContent: string, existingContent: string): boolean {
    // Common patterns that indicate contradiction
    const patterns = [
      { key: 'lives in', extract: /lives? in ([a-z]+)/i },
      { key: 'works at', extract: /works? (?:at|for) ([a-z]+)/i },
      { key: 'office', extract: /office (?:is |at |in )?([a-z]+)/i },
      { key: 'prefers', extract: /prefers? ([a-z]+)/i },
      { key: 'name', extract: /name[: ]+([a-z]+)/i },
    ];

    for (const { extract } of patterns) {
      const newMatch = newContent.match(extract);
      const existingMatch = existingContent.match(extract);

      if (newMatch && existingMatch && newMatch[1] !== existingMatch[1]) {
        return true;
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
  options?: RelationDetectionOptions
): RelationGraph {
  return new RelationGraph(db, embedder, options);
}
