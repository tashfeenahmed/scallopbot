/**
 * Memory Search Skill Execution Script
 *
 * Opens the SQLite memories database directly (safe in WAL mode)
 * and searches using BM25 keyword scoring.
 */

import * as path from 'path';
import {
  ScallopDatabase,
  type ScallopMemoryEntry,
} from '../../../../memory/db.js';
import { calculateBM25Score, buildDocFreqMap, type BM25Options } from '../../../../memory/memory.js';

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
 * Score and rank memories using BM25
 */
function searchMemories(
  memories: ScallopMemoryEntry[],
  query: string,
  limit: number
): { memory: ScallopMemoryEntry; score: number }[] {
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

  const results: { memory: ScallopMemoryEntry; score: number }[] = [];

  for (const memory of memories) {
    const score = calculateBM25Score(query, memory.content, bm25Options);

    // Boost for exact substring match
    const boostedScore = memory.content.toLowerCase().includes(query.toLowerCase())
      ? score * 1.5
      : score;

    if (boostedScore > 0.01) {
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
function executeSearch(args: MemorySearchArgs): void {
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
    const results = searchMemories(candidates, args.query, limit);

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
