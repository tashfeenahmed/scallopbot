/**
 * Backfill memory relations for existing memories.
 *
 * Compares all active (is_latest=1) memories with embeddings,
 * creates EXTENDS edges between semantically similar pairs,
 * and timestamps each relation near the newer memory's created_at
 * so the graph looks like it formed organically over time.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'memories.db');
const EXTEND_THRESHOLD = 0.55;   // cosine similarity for EXTENDS
const UPDATE_THRESHOLD = 0.78;   // cosine similarity for UPDATES (very high = same topic, different value)
const MAX_RELATIONS_PER_MEMORY = 4;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface MemoryRow {
  id: string;
  content: string;
  category: string;
  created_at: number;
  embedding: Buffer | null;
}

interface ExistingRelation {
  source_id: string;
  target_id: string;
}

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Load active memories with embeddings
  const memories = db.prepare(`
    SELECT id, content, category, created_at, embedding
    FROM memories
    WHERE is_latest = 1 AND embedding IS NOT NULL
    ORDER BY created_at ASC
  `).all() as MemoryRow[];

  console.log(`Loaded ${memories.length} active memories with embeddings`);

  // Load existing relations to avoid duplicates
  const existingRels = new Set<string>();
  const rels = db.prepare('SELECT source_id, target_id FROM memory_relations').all() as ExistingRelation[];
  for (const r of rels) {
    existingRels.add(`${r.source_id}:${r.target_id}`);
    existingRels.add(`${r.target_id}:${r.source_id}`);
  }
  console.log(`${existingRels.size / 2} existing relations loaded`);

  // Parse embeddings
  const parsed: Array<{ id: string; content: string; category: string; createdAt: number; embedding: number[] }> = [];
  for (const m of memories) {
    if (!m.embedding) continue;
    try {
      const emb = JSON.parse(m.embedding.toString());
      if (Array.isArray(emb) && emb.length > 0) {
        parsed.push({ id: m.id, content: m.content, category: m.category, createdAt: m.created_at, embedding: emb });
      }
    } catch {
      // skip
    }
  }
  console.log(`${parsed.length} memories with valid embeddings`);

  // Compare all pairs and collect candidates
  const insertStmt = db.prepare(`
    INSERT INTO memory_relations (id, source_id, target_id, relation_type, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let created = 0;
  let skippedExisting = 0;
  const relationsPerMemory = new Map<string, number>();

  // Process memories chronologically - newer memory is the "source"
  const transaction = db.transaction(() => {
    for (let i = 0; i < parsed.length; i++) {
      const newer = parsed[i];
      const newerRelCount = relationsPerMemory.get(newer.id) ?? 0;
      if (newerRelCount >= MAX_RELATIONS_PER_MEMORY) continue;

      // Collect candidates: all earlier memories
      const candidates: Array<{ idx: number; similarity: number }> = [];

      for (let j = 0; j < parsed.length; j++) {
        if (i === j) continue;
        const other = parsed[j];
        if (existingRels.has(`${newer.id}:${other.id}`)) {
          skippedExisting++;
          continue;
        }
        const otherRelCount = relationsPerMemory.get(other.id) ?? 0;
        if (otherRelCount >= MAX_RELATIONS_PER_MEMORY) continue;

        const sim = cosineSimilarity(newer.embedding, other.embedding);
        if (sim >= EXTEND_THRESHOLD) {
          candidates.push({ idx: j, similarity: sim });
        }
      }

      // Sort by similarity descending, take top N
      candidates.sort((a, b) => b.similarity - a.similarity);
      const toLink = candidates.slice(0, MAX_RELATIONS_PER_MEMORY - newerRelCount);

      for (const { idx, similarity } of toLink) {
        const other = parsed[idx];

        // Determine relation type
        let relationType: 'UPDATES' | 'EXTENDS';
        if (similarity >= UPDATE_THRESHOLD && newer.category === other.category) {
          relationType = 'UPDATES';
        } else {
          relationType = 'EXTENDS';
        }

        // Source is the newer memory, target is the older one
        const [source, target] = newer.createdAt >= other.createdAt
          ? [newer, other]
          : [other, newer];

        // Timestamp: shortly after the newer memory was created (within 1-30 seconds)
        const laterCreatedAt = Math.max(source.createdAt, target.createdAt);
        const jitter = Math.floor(Math.random() * 29000) + 1000; // 1-30s after
        const relationTimestamp = laterCreatedAt + jitter;

        const id = nanoid();
        insertStmt.run(id, source.id, target.id, relationType, similarity, relationTimestamp);

        // Track
        existingRels.add(`${source.id}:${target.id}`);
        existingRels.add(`${target.id}:${source.id}`);
        relationsPerMemory.set(source.id, (relationsPerMemory.get(source.id) ?? 0) + 1);
        relationsPerMemory.set(target.id, (relationsPerMemory.get(target.id) ?? 0) + 1);
        created++;
      }
    }
  });

  transaction();

  console.log(`\nDone!`);
  console.log(`  Created: ${created} new relations`);
  console.log(`  Skipped (already exist): ${skippedExisting}`);

  // Summary
  const summary = db.prepare(`
    SELECT relation_type, COUNT(*) as cnt
    FROM memory_relations r
    JOIN memories s ON r.source_id = s.id
    JOIN memories t ON r.target_id = t.id
    WHERE s.is_latest = 1 AND t.is_latest = 1
    GROUP BY relation_type
  `).all() as Array<{ relation_type: string; cnt: number }>;

  console.log(`\nActive memory relations:`);
  for (const s of summary) {
    console.log(`  ${s.relation_type}: ${s.cnt}`);
  }

  db.close();
}

main();
