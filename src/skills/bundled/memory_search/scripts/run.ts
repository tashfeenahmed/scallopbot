/**
 * Memory Search Skill Execution Script
 *
 * Opens the SQLite memories database directly (safe in WAL mode)
 * and searches using hybrid BM25 keyword + Ollama/TF-IDF semantic scoring.
 * Uses stored Ollama embeddings on memories when available.
 */

import * as path from 'path';
import {
  ScallopDatabase,
  type ScallopMemoryEntry,
} from '../../../../memory/db.js';
import { calculateBM25Score, buildDocFreqMap, type BM25Options } from '../../../../memory/bm25.js';
import { TFIDFEmbedder, OllamaEmbedder, cosineSimilarity } from '../../../../memory/embeddings.js';

// Types
interface MemorySearchArgs {
  query: string;
  type?: string;
  subject?: string;
  limit?: number;
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

/**
 * Output result as JSON and exit
 */
function outputResult(result: SkillResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

/**
 * Parse and validate arguments from SKILL_ARGS
 */
function parseArgs(): MemorySearchArgs {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
  }

  let args: unknown;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }

  if (!args || typeof args !== 'object') {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS must be a JSON object',
      exitCode: 1,
    });
  }

  const argsObj = args as Record<string, unknown>;

  if (!argsObj.query || typeof argsObj.query !== 'string') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing or invalid "query" field in SKILL_ARGS',
      exitCode: 1,
    });
  }

  if (argsObj.limit !== undefined && (typeof argsObj.limit !== 'number' || argsObj.limit < 1)) {
    outputResult({
      success: false,
      output: '',
      error: 'limit must be a positive number',
      exitCode: 1,
    });
  }

  return argsObj as unknown as MemorySearchArgs;
}

/**
 * Try to get query embedding via Ollama. Returns undefined if unavailable.
 */
async function getOllamaQueryEmbedding(query: string): Promise<number[] | undefined> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  try {
    const embedder = new OllamaEmbedder({ baseUrl, model: 'nomic-embed-text' });
    return await embedder.embed(query);
  } catch {
    return undefined;
  }
}

/**
 * Score and rank memories using hybrid BM25 + semantic search.
 * Uses stored Ollama embeddings when available, falls back to TF-IDF.
 */
async function searchMemories(
  memories: ScallopMemoryEntry[],
  query: string,
  limit: number
): Promise<{ memory: ScallopMemoryEntry; score: number }[]> {
  if (memories.length === 0) return [];

  const contentTexts = memories.map((m) => m.content);
  const avgDocLength =
    contentTexts.reduce((sum, c) => sum + c.split(/\s+/).length, 0) / contentTexts.length;
  const docFreq = buildDocFreqMap(contentTexts);

  const bm25Options: BM25Options = {
    avgDocLength,
    docCount: memories.length,
    docFreq,
  };

  // Check if memories have stored embeddings (from Ollama during fact extraction)
  const hasStoredEmbeddings = memories.some(m => m.embedding !== null);

  // Try Ollama for query embedding if memories have stored embeddings
  let queryEmbedding: number[] | undefined;
  let useTfidf = true;
  if (hasStoredEmbeddings) {
    queryEmbedding = await getOllamaQueryEmbedding(query);
    if (queryEmbedding) {
      useTfidf = false;
    }
  }

  // Fall back to TF-IDF if Ollama unavailable or no stored embeddings
  let tfidfEmbedder: TFIDFEmbedder | undefined;
  let tfidfQueryEmbedding: number[] | undefined;
  if (useTfidf) {
    tfidfEmbedder = new TFIDFEmbedder();
    tfidfEmbedder.addDocuments(contentTexts);
    tfidfQueryEmbedding = tfidfEmbedder.embedSync(query);
  }

  const results: { memory: ScallopMemoryEntry; score: number }[] = [];

  for (const memory of memories) {
    const keywordScore = calculateBM25Score(query, memory.content, bm25Options);

    // Semantic score: use stored Ollama embedding or fall back to TF-IDF
    let semanticScore = 0;
    if (!useTfidf && queryEmbedding && memory.embedding) {
      semanticScore = cosineSimilarity(queryEmbedding, memory.embedding);
    } else if (tfidfEmbedder && tfidfQueryEmbedding) {
      const memEmbedding = tfidfEmbedder.embedSync(memory.content);
      semanticScore = cosineSimilarity(tfidfQueryEmbedding, memEmbedding);
    }

    // Combined: only count if there's actual relevance
    const relevanceScore = keywordScore * 0.5 + semanticScore * 0.5;

    // Boost for exact substring match
    const boostedScore = memory.content.toLowerCase().includes(query.toLowerCase())
      ? relevanceScore * 1.5
      : relevanceScore;

    if (boostedScore > 0.05) {
      results.push({ memory, score: boostedScore });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Format search results
 */
function formatResults(results: { memory: ScallopMemoryEntry; score: number }[]): string {
  if (results.length === 0) {
    return 'No memories found matching the query.';
  }

  const formatted = results.map((result, index) => {
    const m = result.memory;
    const lines: string[] = [];
    lines.push(`--- Result ${index + 1} (score: ${result.score.toFixed(3)}) ---`);
    lines.push(`Category: ${m.category}`);
    lines.push(`Content: ${m.content}`);
    lines.push(`Stored: ${new Date(m.documentDate).toISOString()}`);
    if (m.eventDate) {
      lines.push(`Event date: ${new Date(m.eventDate).toISOString()}`);
    }
    lines.push(`Prominence: ${m.prominence.toFixed(2)}`);
    if (m.metadata?.subject) {
      lines.push(`Subject: ${m.metadata.subject as string}`);
    }
    return lines.join('\n');
  });

  return `Found ${results.length} memories:\n\n${formatted.join('\n\n')}`;
}

/**
 * Execute memory search against SQLite database
 */
async function executeSearch(args: MemorySearchArgs): Promise<void> {
  const workspace = process.env.SKILL_WORKSPACE || process.env.AGENT_WORKSPACE || process.cwd();
  const dbPath = path.join(workspace, 'memories.db');

  let db: ScallopDatabase | null = null;
  try {
    db = new ScallopDatabase(dbPath);

    // Get candidate memories
    const allMemories = db.getAllMemories({ minProminence: 0.1, limit: 200 });

    // Filter by subject if requested
    let candidates = allMemories;
    if (args.subject) {
      const subjectLower = args.subject.toLowerCase();
      candidates = candidates.filter((m) => {
        const subject = m.metadata?.subject as string | undefined;
        return subject?.toLowerCase() === subjectLower;
      });
    }

    // Filter by category if requested (map old types to new categories)
    if (args.type && args.type !== 'all') {
      const categoryMap: Record<string, string[]> = {
        fact: ['fact', 'relationship'],
        preference: ['preference'],
        event: ['event'],
        insight: ['insight'],
      };
      const allowedCategories = categoryMap[args.type] || [args.type];
      candidates = candidates.filter((m) => allowedCategories.includes(m.category));
    }

    const limit = Math.min(args.limit || 10, 50);
    const results = await searchMemories(candidates, args.query, limit);

    outputResult({
      success: true,
      output: formatResults(results),
      exitCode: 0,
    });
  } catch (error) {
    const err = error as Error;
    outputResult({
      success: false,
      output: '',
      error: `Memory search failed: ${err.message}`,
      exitCode: 1,
    });
  } finally {
    db?.close();
  }
}

// Main execution
const args = parseArgs();
executeSearch(args);
