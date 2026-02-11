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
import { calculateBM25Score, buildDocFreqMap, SEARCH_WEIGHTS, type BM25Options } from '../../../../memory/bm25.js';
import { TFIDFEmbedder, OllamaEmbedder, cosineSimilarity } from '../../../../memory/embeddings.js';
import { rerankResults, type RerankCandidate } from '../../../../memory/reranker.js';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../../../../providers/types.js';

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
 * Create a minimal Groq LLM provider for re-ranking (standalone, no routing dependency).
 * Returns undefined if GROQ_API_KEY is not set.
 */
function createGroqRerankProvider(): LLMProvider | undefined {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return undefined;

  return {
    name: 'groq-rerank',
    isAvailable: () => true,
    complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
      const body = {
        model: 'llama-3.1-8b-instant',
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          ...request.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
        ],
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 500,
      };

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      return {
        content: [{ type: 'text', text: data.choices[0]?.message?.content ?? '' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        model: 'llama-3.1-8b-instant',
      };
    },
  };
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

    // Combined: use shared weights with multiplicative prominence
    const relevanceScore = keywordScore * SEARCH_WEIGHTS.keyword + semanticScore * SEARCH_WEIGHTS.semantic;
    const prominenceMultiplier = 0.5 + 0.5 * memory.prominence;
    const withProminence = relevanceScore * prominenceMultiplier;

    // Boost for exact substring match
    const boostedScore = memory.content.toLowerCase().includes(query.toLowerCase())
      ? withProminence * 1.5
      : withProminence;

    if (boostedScore > 0.05) {
      results.push({ memory, score: boostedScore });
    }
  }

  results.sort((a, b) => b.score - a.score);
  let topResults = results.slice(0, limit);

  // Optional LLM re-ranking pass (uses Groq if available)
  const rerankProvider = createGroqRerankProvider();
  if (rerankProvider && topResults.length > 0) {
    try {
      const candidates: RerankCandidate[] = topResults.map(r => ({
        id: r.memory.id,
        content: r.memory.content,
        originalScore: r.score,
      }));

      const reranked = await rerankResults(query, candidates, rerankProvider, { maxCandidates: 20 });

      const rerankedMap = new Map(reranked.map(r => [r.id, r.finalScore]));
      topResults = topResults
        .filter(r => rerankedMap.has(r.memory.id))
        .map(r => ({ ...r, score: rerankedMap.get(r.memory.id)! }))
        .sort((a, b) => b.score - a.score);
    } catch {
      // Re-ranking failed — keep original results
    }
  }

  return topResults;
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
