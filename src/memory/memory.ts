/**
 * Gardener Memory System
 * Hot collector, background gardener, and hybrid search
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Logger } from 'pino';
import { nanoid } from 'nanoid';

export type MemoryType = 'raw' | 'fact' | 'summary' | 'preference' | 'context';

export interface MemoryEntry {
  id: string;
  content: string;
  type: MemoryType;
  timestamp: Date;
  sessionId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export type PartialMemoryEntry = Omit<MemoryEntry, 'id'> & { id?: string };

export interface MemoryStoreOptions {
  /** Path to JSONL file for persistence (optional) */
  filePath?: string;
  /** Auto-save on every add/update/delete (default: true if filePath provided) */
  autoSave?: boolean;
}

/**
 * In-memory store for memories with optional disk persistence
 */
export class MemoryStore {
  private memories: Map<string, MemoryEntry> = new Map();
  private filePath: string | null;
  private autoSave: boolean;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: MemoryStoreOptions = {}) {
    this.filePath = options.filePath || null;
    this.autoSave = options.autoSave ?? !!options.filePath;
  }

  /**
   * Load memories from disk
   */
  async load(): Promise<void> {
    if (!this.filePath) return;

    try {
      await fs.access(this.filePath);
    } catch {
      // File doesn't exist yet, that's fine
      return;
    }

    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line) as MemoryEntry;
          // Restore Date objects
          entry.timestamp = new Date(entry.timestamp);
          this.memories.set(entry.id, entry);
        } catch {
          // Skip invalid lines
        }
      }
    } catch {
      // File read error, start fresh
    }
  }

  /**
   * Save all memories to disk (full rewrite)
   */
  async save(): Promise<void> {
    if (!this.filePath) return;

    // Queue saves to prevent concurrent writes
    this.saveQueue = this.saveQueue.then(async () => {
      const dir = path.dirname(this.filePath!);
      await fs.mkdir(dir, { recursive: true });

      const lines = Array.from(this.memories.values())
        .map((m) => JSON.stringify(m))
        .join('\n');

      await fs.writeFile(this.filePath!, lines + '\n', 'utf-8');
    });

    await this.saveQueue;
  }

  /**
   * Append a single entry to disk (more efficient for adds)
   */
  private async appendEntry(entry: MemoryEntry): Promise<void> {
    if (!this.filePath || !this.autoSave) return;

    this.saveQueue = this.saveQueue.then(async () => {
      const dir = path.dirname(this.filePath!);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(this.filePath!, JSON.stringify(entry) + '\n', 'utf-8');
    });

    await this.saveQueue;
  }

  add(entry: PartialMemoryEntry): MemoryEntry {
    const id = entry.id || nanoid();
    const memory: MemoryEntry = {
      ...entry,
      id,
    };
    this.memories.set(id, memory);

    // Append to disk if auto-save enabled
    if (this.autoSave && this.filePath) {
      // Fire and forget - don't block on disk write
      this.appendEntry(memory).catch(() => {});
    }

    return memory;
  }

  get(id: string): MemoryEntry | undefined {
    return this.memories.get(id);
  }

  delete(id: string): boolean {
    const result = this.memories.delete(id);

    // Save full state on delete (can't append a delete)
    if (result && this.autoSave && this.filePath) {
      this.save().catch(() => {});
    }

    return result;
  }

  update(id: string, updates: Partial<MemoryEntry>): MemoryEntry | undefined {
    const existing = this.memories.get(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...updates, id };
    this.memories.set(id, updated);

    // Save full state on update (can't append an update)
    if (this.autoSave && this.filePath) {
      this.save().catch(() => {});
    }

    return updated;
  }

  search(query: string): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.content.toLowerCase().includes(lowerQuery)) {
        results.push(memory);
      }
    }

    return results;
  }

  searchByTag(tag: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.tags?.includes(tag)) {
        results.push(memory);
      }
    }

    return results;
  }

  searchByType(type: MemoryType): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.type === type) {
        results.push(memory);
      }
    }

    return results;
  }

  getBySession(sessionId: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];

    for (const memory of this.memories.values()) {
      if (memory.sessionId === sessionId) {
        results.push(memory);
      }
    }

    return results;
  }

  getRecent(limit: number): MemoryEntry[] {
    const all = Array.from(this.memories.values());
    return all
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getAll(): MemoryEntry[] {
    return Array.from(this.memories.values());
  }

  clear(): void {
    this.memories.clear();

    // Clear the file too
    if (this.autoSave && this.filePath) {
      this.save().catch(() => {});
    }
  }

  /**
   * Get the configured file path
   */
  getFilePath(): string | null {
    return this.filePath;
  }

  /**
   * Get memory count
   */
  size(): number {
    return this.memories.size;
  }
}

export interface CollectOptions {
  content: string;
  sessionId: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface HotCollectorOptions {
  store: MemoryStore;
  maxBuffer?: number;
}

/**
 * Hot Collector - collects memories during conversation
 */
export class HotCollector {
  private store: MemoryStore;
  private buffers: Map<string, MemoryEntry[]> = new Map();
  private maxBuffer: number;

  constructor(options: HotCollectorOptions) {
    this.store = options.store;
    this.maxBuffer = options.maxBuffer ?? 100;
  }

  collect(options: CollectOptions): MemoryEntry {
    const entry: MemoryEntry = {
      id: nanoid(),
      content: options.content,
      type: 'raw',
      timestamp: new Date(),
      sessionId: options.sessionId,
      tags: options.tags,
      metadata: {
        ...options.metadata,
        source: options.source,
      },
    };

    let buffer = this.buffers.get(options.sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(options.sessionId, buffer);
    }

    buffer.push(entry);

    // Trim buffer if over limit
    if (buffer.length > this.maxBuffer) {
      buffer.shift();
    }

    return entry;
  }

  getBuffer(sessionId: string): MemoryEntry[] {
    return this.buffers.get(sessionId) || [];
  }

  flush(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return;

    for (const entry of buffer) {
      this.store.add(entry);
    }

    this.buffers.set(sessionId, []);
  }

  clear(sessionId: string): void {
    this.buffers.set(sessionId, []);
  }

  flushAll(): void {
    for (const sessionId of this.buffers.keys()) {
      this.flush(sessionId);
    }
  }
}

/**
 * Extracted fact with subject attribution
 */
export interface ExtractedFact {
  /** The fact content */
  content: string;
  /** Who the fact is about: "user" or a person's name */
  subject: string;
}

/**
 * Relationship types we track
 */
const RELATIONSHIP_TYPES = [
  'friend', 'flatmate', 'roommate', 'colleague', 'coworker',
  'brother', 'sister', 'mom', 'dad', 'mother', 'father',
  'wife', 'husband', 'partner', 'boss', 'manager', 'teammate',
];

/**
 * Extract the current subject context from text
 * Looks for patterns like "my flatmate X" and tracks X as the subject
 */
function findThirdPartySubject(text: string): Map<number, string> {
  const subjectRanges = new Map<number, string>();

  // Pattern: "my <relationship> <Name>" - marks the following clauses as about Name
  // Use [Mm]y to match both "my" and "My"
  const myRelPattern = /[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)\s+([A-Z][a-z]+)/g;

  // Pattern: "<Name> is my <relationship>" - marks preceding/following as about Name
  const isMyPattern = /([A-Z][a-z]+)\s+is\s+[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)/g;

  let match;

  // Find "my flatmate Hamza" patterns
  while ((match = myRelPattern.exec(text)) !== null) {
    const name = match[2];
    const startPos = match.index;
    // This subject applies from here to end of sentence or next subject
    subjectRanges.set(startPos, name);
  }

  // Find "Hamza is my flatmate" patterns
  while ((match = isMyPattern.exec(text)) !== null) {
    const name = match[1];
    const startPos = match.index;
    subjectRanges.set(startPos, name);
  }

  return subjectRanges;
}

/**
 * Determine subject for a fact at a given position
 */
function getSubjectAtPosition(position: number, subjectRanges: Map<number, string>): string {
  let currentSubject = 'user';
  let lastPos = -1;

  for (const [pos, subject] of subjectRanges) {
    if (pos <= position && pos > lastPos) {
      currentSubject = subject;
      lastPos = pos;
    }
  }

  return currentSubject;
}

/**
 * Extract facts from text with subject attribution
 */
export function extractFacts(text: string): ExtractedFact[] {
  if (!text.trim()) return [];

  const facts: ExtractedFact[] = [];
  const subjectRanges = findThirdPartySubject(text);

  // Name patterns (user's own name) - case insensitive for "i'm", "I'm" etc
  const namePatterns = [
    /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
  ];

  // Location patterns - case insensitive for "i live", "I live" etc
  const locationPatterns = [
    /(?:i live in|i'm from|i am from|i'm in|located in|based in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my home is in|my house is in|my apartment is in|my flat is in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my address is)\s+(.+?)(?:\.|$)/gi,
  ];

  // Office/workplace location patterns
  const officePatterns = [
    /(?:my office is (?:at|in|on)|my workplace is (?:at|in)|i work (?:at|from|in))\s+(.+?)(?:\.|,|$)/gi,
    /(?:our office is (?:at|in)|the office is (?:at|in))\s+(.+?)(?:\.|,|$)/gi,
  ];

  // Job patterns - user (case insensitive for "i work")
  const userJobPatterns = [
    /(?:i work as|i am a|i'm a|work as a|my job is|my role is|my position is)\s+([a-z]+(?:\s+[a-z]+)*)/gi,
    /(?:i work at|i'm working at|i am employed at|i work for|i'm at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my company is|i work for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ];

  // Project/interest patterns
  const projectPatterns = [
    /(?:i'm working on|i am working on|i'm building|i am building|my project is)\s+(.+?)(?:\.|,|$)/gi,
    /(?:i'm learning|i am learning|i'm studying|i am studying)\s+(.+?)(?:\.|,|$)/gi,
  ];

  // Job patterns - third party (comes after relationship mention) - NO 'i' flag to preserve case matching
  // Pattern for company names (capitalized): "works at Google"
  const thirdPartyJobPattern = /(?:works at|working at|employed at|employed by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
  // Pattern for job titles (lowercase): "is a doctor", "is an engineer"
  const thirdPartyJobTitlePattern = /(?:is a|is an)\s+([a-z]+(?:\s+[a-z]+)*)/g;

  // Location patterns - third party - NO 'i' flag
  const thirdPartyLocationPattern = /(?:lives in|is from|is based in|is in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;

  // Preference patterns
  const preferencePatterns = [
    /(?:i prefer|i like|i love|i enjoy|i hate|i dislike)\s+([^.,!?]+)/gi,
  ];

  // Extract user's name
  for (const pattern of namePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Name: ${match[1]}`,
        subject: 'user',
      });
    }
  }

  // Extract user's location
  for (const pattern of locationPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Location: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract office/workplace location
  for (const pattern of officePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Office: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract projects/interests
  for (const pattern of projectPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Project: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract user's job
  for (const pattern of userJobPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: 'user',
      });
    }
  }

  // Extract preferences (always user)
  for (const pattern of preferencePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Preference: ${match[0].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract third party jobs (e.g., "my flatmate Hamza works at Henry Schein")
  let match;
  while ((match = thirdPartyJobPattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    // Only add if this is about a third party (not the user)
    if (subject !== 'user') {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract third party job titles (e.g., "my brother Ahmed is a doctor")
  while ((match = thirdPartyJobTitlePattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    // Only add if this is about a third party (not the user)
    if (subject !== 'user') {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract third party locations (e.g., "my friend John lives in London")
  while ((match = thirdPartyLocationPattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    if (subject !== 'user') {
      facts.push({
        content: `Location: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract relationships (my friend X, my flatmate Y, etc.) - NO 'i' flag to preserve case matching for names
  // Use [Mm]y to match both "my" and "My"
  const relationshipPattern1 = /[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)\s+(?:is\s+|named\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
  const relationshipPattern2 = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+is\s+[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)/g;

  while ((match = relationshipPattern1.exec(text)) !== null) {
    const relationship = match[1];
    const name = match[2];
    facts.push({
      content: `Relationship: ${relationship} is ${name}`,
      subject: name,
    });
  }

  while ((match = relationshipPattern2.exec(text)) !== null) {
    const name = match[1];
    const relationship = match[2];
    facts.push({
      content: `Relationship: ${relationship} is ${name}`,
      subject: name,
    });
  }

  // Deduplicate by content+subject
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = `${f.subject}:${f.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Summarize multiple memories into a compact form
 */
export function summarizeMemories(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  // Group by type
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const mem of memories) {
    const group = byType.get(mem.type) || [];
    group.push(mem);
    byType.set(mem.type, group);
  }

  const parts: string[] = [];

  // Summarize each type
  for (const [type, mems] of byType) {
    if (mems.length === 1) {
      parts.push(mems[0].content);
    } else {
      // Simple concatenation with dedup
      const unique = [...new Set(mems.map((m) => m.content))];
      if (unique.length <= 3) {
        parts.push(unique.join('. '));
      } else {
        parts.push(`${type}: ${unique.slice(0, 3).join(', ')} (and ${unique.length - 3} more)`);
      }
    }
  }

  return parts.join(' | ');
}

export interface BackgroundGardenerOptions {
  store: MemoryStore;
  logger: Logger;
  interval?: number;
  /** ScallopMemoryStore for decay processing (optional) */
  scallopStore?: ScallopMemoryStore;
}

// Import ScallopMemoryStore type for decay processing
import type { ScallopMemoryStore } from './scallop-store.js';

/**
 * Background Gardener - processes and organizes memories
 */
export class BackgroundGardener {
  private store: MemoryStore;
  private logger: Logger;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private embedder: TFIDFEmbedder;
  private scallopStore: ScallopMemoryStore | null = null;

  /** Patterns indicating contradictory information */
  private static readonly CONTRADICTION_PATTERNS = [
    // Preference changes
    { category: 'preference', patterns: ['prefer', 'like', 'want', 'use', 'favor'] },
    // Name/identity
    { category: 'identity', patterns: ['name is', 'called', 'known as', 'goes by'] },
    // Location
    { category: 'location', patterns: ['live in', 'based in', 'located in', 'from'] },
    // Work/job
    { category: 'work', patterns: ['work at', 'work for', 'employed at', 'job is', 'works as'] },
    // Tool/technology choices
    { category: 'technology', patterns: ['uses', 'codes in', 'programs in', 'develops with'] },
  ];

  constructor(options: BackgroundGardenerOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ component: 'gardener' });
    this.interval = options.interval ?? 60000; // Default 1 minute
    this.embedder = new TFIDFEmbedder();
    this.scallopStore = options.scallopStore ?? null;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      this.processMemories();
    }, this.interval);

    this.logger.info('Background gardener started');
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('Background gardener stopped');
  }

  processMemories(): void {
    this.logger.debug('Processing memories');

    // Process ScallopMemory decay if enabled
    if (this.scallopStore) {
      const decayResult = this.scallopStore.processDecay();
      if (decayResult.updated > 0 || decayResult.archived > 0) {
        this.logger.debug(
          { updated: decayResult.updated, archived: decayResult.archived },
          'ScallopMemory decay processed'
        );
      }
    }

    // Get raw memories that need processing
    const rawMemories = this.store.searchByType('raw');

    for (const memory of rawMemories) {
      // Only extract facts from USER messages, not tool results or assistant responses
      // Tool results contain web search data about random people, not about the user
      const source = memory.metadata?.source;
      const isUserMessage = source === 'user';

      if (isUserMessage) {
        // Extract facts only from what the user says
        const facts = extractFacts(memory.content);

        for (const fact of facts) {
          this.store.add({
            content: fact.content,
            type: 'fact',
            timestamp: new Date(),
            sessionId: memory.sessionId,
            metadata: {
              sourceId: memory.id,
              subject: fact.subject, // Track WHO the fact is about
            },
          });
        }
      }

      // Update original memory type to prevent reprocessing
      this.store.update(memory.id, { type: 'context' });
    }

    // Run maintenance tasks
    this.deduplicate();
    this.linkRelatedFacts();
    this.pruneOutdatedFacts();
  }

  deduplicate(): void {
    const facts = this.store.searchByType('fact');
    const seen = new Map<string, string>();
    const toDelete: string[] = [];

    for (const fact of facts) {
      const normalized = fact.content.toLowerCase().trim();

      // Check for similar content
      let isDuplicate = false;
      for (const [existing, _id] of seen) {
        if (this.isSimilar(normalized, existing)) {
          toDelete.push(fact.id);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        seen.set(normalized, fact.id);
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    if (toDelete.length > 0) {
      this.logger.debug({ removed: toDelete.length }, 'Deduplicated memories');
    }
  }

  /**
   * Link semantically related facts bidirectionally
   */
  linkRelatedFacts(): void {
    const facts = this.store.searchByType('fact');

    // Skip if too few facts
    if (facts.length < 2) return;

    // Build embeddings for all facts
    const embeddings = new Map<string, number[]>();
    for (const fact of facts) {
      embeddings.set(fact.id, this.embedder.embedSync(fact.content));
    }

    // Find related pairs
    const relatedPairs: Array<[string, string, number]> = [];
    const processedPairs = new Set<string>();

    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const factA = facts[i];
        const factB = facts[j];
        const pairKey = [factA.id, factB.id].sort().join('|');

        if (processedPairs.has(pairKey)) continue;
        processedPairs.add(pairKey);

        const embeddingA = embeddings.get(factA.id)!;
        const embeddingB = embeddings.get(factB.id)!;
        const similarity = cosineSimilarity(embeddingA, embeddingB);

        // Link if similarity is high enough (but not a duplicate)
        if (similarity > 0.3 && similarity < 0.95) {
          relatedPairs.push([factA.id, factB.id, similarity]);
        }
      }
    }

    // Apply bidirectional links
    let linksAdded = 0;
    for (const [idA, idB] of relatedPairs) {
      const factA = this.store.get(idA);
      const factB = this.store.get(idB);

      if (!factA || !factB) continue;

      // Get existing related IDs
      const relatedA = (factA.metadata?.relatedIds as string[]) || [];
      const relatedB = (factB.metadata?.relatedIds as string[]) || [];

      // Add bidirectional links if not already present
      if (!relatedA.includes(idB)) {
        this.store.update(idA, {
          metadata: { ...factA.metadata, relatedIds: [...relatedA, idB] },
        });
        linksAdded++;
      }

      if (!relatedB.includes(idA)) {
        this.store.update(idB, {
          metadata: { ...factB.metadata, relatedIds: [...relatedB, idA] },
        });
        linksAdded++;
      }
    }

    if (linksAdded > 0) {
      this.logger.debug({ linksAdded }, 'Linked related facts');
    }
  }

  /**
   * Detect and prune outdated/contradicted facts
   */
  pruneOutdatedFacts(): void {
    const facts = this.store.searchByType('fact');

    // Group facts by category
    const categorized = new Map<string, MemoryEntry[]>();

    for (const fact of facts) {
      const category = this.categorizeFactContent(fact.content);
      if (category) {
        const existing = categorized.get(category) || [];
        existing.push(fact);
        categorized.set(category, existing);
      }
    }

    // Within each category, find contradictions (newer supersedes older)
    const toMarkSuperseded: string[] = [];

    for (const [category, categoryFacts] of categorized) {
      // Sort by timestamp descending (newest first)
      categoryFacts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      // Check for contradictions within the category
      for (let i = 0; i < categoryFacts.length; i++) {
        const newerFact = categoryFacts[i];

        // Skip if already superseded
        if (newerFact.metadata?.superseded) continue;

        for (let j = i + 1; j < categoryFacts.length; j++) {
          const olderFact = categoryFacts[j];

          // Skip if already superseded
          if (olderFact.metadata?.superseded) continue;

          // Check if same subject but different value (contradiction)
          if (this.detectContradiction(newerFact.content, olderFact.content, category)) {
            toMarkSuperseded.push(olderFact.id);

            // Link newer fact to superseded one
            this.store.update(newerFact.id, {
              metadata: {
                ...newerFact.metadata,
                supersedes: olderFact.id,
              },
            });
          }
        }
      }
    }

    // Mark superseded facts
    for (const id of toMarkSuperseded) {
      const fact = this.store.get(id);
      if (fact) {
        this.store.update(id, {
          metadata: {
            ...fact.metadata,
            superseded: true,
            supersededAt: new Date().toISOString(),
          },
        });
      }
    }

    // Delete facts that have been superseded for more than 7 days
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toDelete: string[] = [];

    for (const fact of facts) {
      if (fact.metadata?.superseded && fact.metadata?.supersededAt) {
        const supersededAt = new Date(fact.metadata.supersededAt as string);
        if (supersededAt < oneWeekAgo) {
          toDelete.push(fact.id);
        }
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    if (toMarkSuperseded.length > 0 || toDelete.length > 0) {
      this.logger.debug(
        { superseded: toMarkSuperseded.length, deleted: toDelete.length },
        'Pruned outdated facts'
      );
    }
  }

  /**
   * Categorize a fact by its content type
   */
  private categorizeFactContent(content: string): string | null {
    const lower = content.toLowerCase();

    for (const { category, patterns } of BackgroundGardener.CONTRADICTION_PATTERNS) {
      for (const pattern of patterns) {
        if (lower.includes(pattern)) {
          // Extract subject for more precise categorization
          const subject = this.extractSubject(lower, pattern);
          return subject ? `${category}:${subject}` : category;
        }
      }
    }

    return null;
  }

  /**
   * Extract subject from a fact statement
   */
  private extractSubject(content: string, pattern: string): string | null {
    // Find words before the pattern (likely the subject)
    const patternIndex = content.indexOf(pattern);
    if (patternIndex <= 0) return null;

    const before = content.slice(0, patternIndex).trim();
    const words = before.split(/\s+/).filter((w) => w.length > 2);

    // Return last meaningful word as subject
    const meaningfulWords = words.filter((w) => !['the', 'user', 'they', 'i'].includes(w));
    return meaningfulWords.length > 0 ? meaningfulWords[meaningfulWords.length - 1] : null;
  }

  /**
   * Detect if two facts contradict each other
   */
  private detectContradiction(newer: string, older: string, _category: string): boolean {
    const newerLower = newer.toLowerCase();
    const olderLower = older.toLowerCase();

    // Extract values after the pattern
    for (const { patterns } of BackgroundGardener.CONTRADICTION_PATTERNS) {
      for (const pattern of patterns) {
        if (newerLower.includes(pattern) && olderLower.includes(pattern)) {
          const newerValue = newerLower.split(pattern)[1]?.trim() || '';
          const olderValue = olderLower.split(pattern)[1]?.trim() || '';

          // If values are different, it's a contradiction
          if (newerValue && olderValue && newerValue !== olderValue) {
            // Check they're not just elaborating (substring)
            if (!newerValue.includes(olderValue) && !olderValue.includes(newerValue)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Get related facts for a given fact ID
   */
  getRelatedFacts(factId: string): MemoryEntry[] {
    const fact = this.store.get(factId);
    if (!fact) return [];

    const relatedIds = (fact.metadata?.relatedIds as string[]) || [];
    return relatedIds
      .map((id) => this.store.get(id))
      .filter((f): f is MemoryEntry => f !== undefined);
  }

  /**
   * Check if a fact has been superseded
   */
  isSuperseded(factId: string): boolean {
    const fact = this.store.get(factId);
    return !!fact?.metadata?.superseded;
  }

  /**
   * Get active (non-superseded) facts only
   */
  getActiveFacts(): MemoryEntry[] {
    return this.store.searchByType('fact').filter((f) => !f.metadata?.superseded);
  }

  private isSimilar(a: string, b: string): boolean {
    // Simple similarity check - could be enhanced with proper similarity algorithm
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;

    // Word overlap
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    const overlap = intersection.length / Math.min(wordsA.size, wordsB.size);

    return overlap > 0.8;
  }
}

export interface BM25Options {
  avgDocLength: number;
  docCount: number;
  k1?: number;
  b?: number;
}

/**
 * Calculate BM25 score for a query against a document
 */
export function calculateBM25Score(
  query: string,
  document: string,
  options: BM25Options
): number {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;

  const queryTerms = query.toLowerCase().split(/\s+/);
  const docTerms = document.toLowerCase().split(/\s+/);
  const docLength = docTerms.length;

  // Calculate term frequencies
  const docTermFreq = new Map<string, number>();
  for (const term of docTerms) {
    docTermFreq.set(term, (docTermFreq.get(term) || 0) + 1);
  }

  let score = 0;

  for (const term of queryTerms) {
    const tf = docTermFreq.get(term) || 0;
    if (tf === 0) continue;

    // Simple IDF approximation
    const idf = Math.log((options.docCount + 0.5) / (1 + 0.5));

    // BM25 term score
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / options.avgDocLength));

    score += idf * (numerator / denominator);
  }

  return score;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  matchType: 'keyword' | 'semantic' | 'hybrid';
}

export interface SearchOptions {
  limit?: number;
  type?: MemoryType;
  recencyBoost?: boolean;
  sessionId?: string;
  /** Minimum score threshold (default: 0.01). Results below this are filtered out. */
  minScore?: number;
  /** Filter to only include facts about a specific subject (e.g., "user", "Hamza") */
  subject?: string;
  /** Boost score for facts about the user (default: 1.5) */
  userSubjectBoost?: number;
}

export interface HybridSearchOptions {
  store: MemoryStore;
  /** Embedding provider for semantic search */
  embedder?: EmbeddingProvider;
  /** Weight for BM25 score (default: 0.5) */
  bm25Weight?: number;
  /** Weight for semantic score (default: 0.5) */
  semanticWeight?: number;
}

// Import embedding types
import type { EmbeddingProvider } from './embeddings.js';
import { TFIDFEmbedder, cosineSimilarity, EmbeddingCache } from './embeddings.js';

/**
 * Hybrid Search - combines BM25 and vector similarity
 *
 * Uses real vector embeddings for semantic search with configurable weights.
 */
export class HybridSearch {
  private store: MemoryStore;
  private embedder: EmbeddingProvider;
  private embeddingCache: EmbeddingCache;
  private bm25Weight: number;
  private semanticWeight: number;
  private initialized = false;

  constructor(options: HybridSearchOptions) {
    this.store = options.store;
    this.embedder = options.embedder || new TFIDFEmbedder();
    this.embeddingCache = new EmbeddingCache();
    this.bm25Weight = options.bm25Weight ?? 0.5;
    this.semanticWeight = options.semanticWeight ?? 0.5;
  }

  /**
   * Initialize embeddings for existing memories
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const memories = this.store.getAll();

    // Add documents to TF-IDF for IDF calculation
    if (this.embedder instanceof TFIDFEmbedder) {
      this.embedder.addDocuments(memories.map((m) => m.content));
    }

    // Pre-compute embeddings for existing memories
    for (const memory of memories) {
      if (!this.embeddingCache.has(memory.id)) {
        const embedding = await this.embedder.embed(memory.content);
        this.embeddingCache.set(memory.id, embedding);

        // Also store in memory entry
        this.store.update(memory.id, { embedding });
      }
    }

    this.initialized = true;
  }

  /**
   * Add embedding for a new memory
   */
  async addMemoryEmbedding(memory: MemoryEntry): Promise<void> {
    if (!this.embeddingCache.has(memory.id)) {
      // Update TF-IDF corpus
      if (this.embedder instanceof TFIDFEmbedder) {
        this.embedder.addDocument(memory.content);
      }

      const embedding = await this.embedder.embed(memory.content);
      this.embeddingCache.set(memory.id, embedding);

      // Store in memory entry
      this.store.update(memory.id, { embedding });
    }
  }

  /**
   * Search with hybrid BM25 + vector similarity
   * If query is empty, returns all matching memories sorted by recency
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 10;
    const allMemories = this.store.getAll();

    // Filter by type and session if specified
    let candidates = allMemories;
    if (options.type) {
      candidates = candidates.filter((m) => m.type === options.type);
    }
    if (options.sessionId) {
      candidates = candidates.filter((m) => m.sessionId === options.sessionId);
    }
    // Filter by subject if specified
    if (options.subject) {
      candidates = candidates.filter((m) => {
        const subject = m.metadata?.subject as string | undefined;
        return subject?.toLowerCase() === options.subject?.toLowerCase();
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Handle empty query: return all candidates sorted by recency
    // This is useful for getting all user facts without needing a specific search term
    if (!query.trim()) {
      const results: SearchResult[] = candidates
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit)
        .map((memory) => ({
          entry: memory,
          score: 1.0,
          matchType: 'keyword' as const,
        }));
      return results;
    }

    // Calculate average document length
    const avgDocLength =
      candidates.reduce((sum, m) => sum + m.content.split(/\s+/).length, 0) /
      candidates.length;

    const bm25Options: BM25Options = {
      avgDocLength,
      docCount: candidates.length,
    };

    // Score each candidate
    const results: SearchResult[] = [];
    const userSubjectBoost = options.userSubjectBoost ?? 1.5;

    for (const memory of candidates) {
      const bm25Score = calculateBM25Score(query, memory.content, bm25Options);
      const semanticScore = this.calculateSemanticScore(query, memory);

      // Combine scores with configurable weights
      let combinedScore = bm25Score * this.bm25Weight + semanticScore * this.semanticWeight;

      // Apply recency boost if enabled
      if (options.recencyBoost) {
        const ageMs = Date.now() - memory.timestamp.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyMultiplier = Math.exp(-ageDays / 7); // Decay over ~1 week
        combinedScore *= 1 + recencyMultiplier * 0.5;
      }

      // Apply user subject boost - facts about the user are more likely to be relevant
      const subject = memory.metadata?.subject as string | undefined;
      if (subject?.toLowerCase() === 'user') {
        combinedScore *= userSubjectBoost;
      }

      // Filter by minimum score threshold
      const minScore = options.minScore ?? 0.01;
      if (combinedScore >= minScore) {
        results.push({
          entry: memory,
          score: combinedScore,
          matchType: bm25Score > semanticScore ? 'keyword' : 'semantic',
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Async search with real-time embedding computation
   */
  async searchAsync(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const allMemories = this.store.getAll();

    // Filter by type and session if specified
    let candidates = allMemories;
    if (options.type) {
      candidates = candidates.filter((m) => m.type === options.type);
    }
    if (options.sessionId) {
      candidates = candidates.filter((m) => m.sessionId === options.sessionId);
    }
    // Filter by subject if specified
    if (options.subject) {
      candidates = candidates.filter((m) => {
        const subject = m.metadata?.subject as string | undefined;
        return subject?.toLowerCase() === options.subject?.toLowerCase();
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Calculate average document length
    const avgDocLength =
      candidates.reduce((sum, m) => sum + m.content.split(/\s+/).length, 0) /
      candidates.length;

    const bm25Options: BM25Options = {
      avgDocLength,
      docCount: candidates.length,
    };

    // Get query embedding
    const queryEmbedding = await this.embedder.embed(query);

    // Score each candidate
    const results: SearchResult[] = [];
    const userSubjectBoost = options.userSubjectBoost ?? 1.5;

    for (const memory of candidates) {
      const bm25Score = calculateBM25Score(query, memory.content, bm25Options);

      // Get cached embedding or compute new one
      let memoryEmbedding = memory.embedding || this.embeddingCache.get(memory.id);
      if (!memoryEmbedding) {
        memoryEmbedding = await this.embedder.embed(memory.content);
        this.embeddingCache.set(memory.id, memoryEmbedding);
      }

      // Calculate semantic similarity using cosine similarity
      const semanticScore = cosineSimilarity(queryEmbedding, memoryEmbedding);

      // Combine scores with configurable weights
      let combinedScore = bm25Score * this.bm25Weight + semanticScore * this.semanticWeight;

      // Apply recency boost if enabled
      if (options.recencyBoost) {
        const ageMs = Date.now() - memory.timestamp.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyMultiplier = Math.exp(-ageDays / 7); // Decay over ~1 week
        combinedScore *= 1 + recencyMultiplier * 0.5;
      }

      // Apply user subject boost - facts about the user are more likely to be relevant
      const subject = memory.metadata?.subject as string | undefined;
      if (subject?.toLowerCase() === 'user') {
        combinedScore *= userSubjectBoost;
      }

      // Filter by minimum score threshold
      const minScore = options.minScore ?? 0.01;
      if (combinedScore >= minScore) {
        results.push({
          entry: memory,
          score: combinedScore,
          matchType: bm25Score > semanticScore ? 'keyword' : 'semantic',
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Calculate semantic score using vector similarity
   */
  private calculateSemanticScore(query: string, memory: MemoryEntry): number {
    // For TF-IDF embedder, we can compute embeddings synchronously
    if (this.embedder instanceof TFIDFEmbedder) {
      // Get query embedding
      const queryEmbedding = this.embedder.embedSync(query);

      // Get or compute memory embedding
      let memoryEmbedding = memory.embedding || this.embeddingCache.get(memory.id);
      if (!memoryEmbedding) {
        memoryEmbedding = this.embedder.embedSync(memory.content);
        this.embeddingCache.set(memory.id, memoryEmbedding);
      }

      return cosineSimilarity(queryEmbedding, memoryEmbedding);
    }

    // Check for cached embedding (for non-TF-IDF embedders)
    const memoryEmbedding = memory.embedding || this.embeddingCache.get(memory.id);

    if (memoryEmbedding) {
      // Use synchronous embedding for query if available
      const queryEmbedding = this.embedSync(query);
      if (queryEmbedding) {
        return cosineSimilarity(queryEmbedding, memoryEmbedding);
      }
    }

    // Fallback to simple word overlap if no embeddings available
    return this.calculateFallbackScore(query, memory);
  }

  /**
   * Synchronous embed for TF-IDF (it's actually sync under the hood)
   */
  private embedSync(text: string): number[] | null {
    if (this.embedder instanceof TFIDFEmbedder) {
      return this.embedder.embedSync(text);
    }
    return null;
  }

  /**
   * Fallback score calculation using word overlap
   */
  private calculateFallbackScore(query: string, memory: MemoryEntry): number {
    const queryTerms = new Set(query.toLowerCase().split(/\s+/));
    const memTerms = new Set(memory.content.toLowerCase().split(/\s+/));

    // Direct overlap
    const overlap = [...queryTerms].filter((t) => memTerms.has(t)).length;

    // Tag matching
    let tagScore = 0;
    if (memory.tags) {
      for (const tag of memory.tags) {
        if (queryTerms.has(tag.toLowerCase())) {
          tagScore += 1;
        }
      }
    }

    const totalScore = overlap + tagScore;
    const maxPossible = queryTerms.size + 2;

    return totalScore / maxPossible;
  }

  /**
   * Get embedding provider info
   */
  getEmbedderInfo(): { name: string; dimension: number; available: boolean } {
    return {
      name: this.embedder.name,
      dimension: this.embedder.dimension,
      available: this.embedder.isAvailable(),
    };
  }

  /**
   * Clear embedding cache
   */
  clearCache(): void {
    this.embeddingCache.clear();
  }
}
