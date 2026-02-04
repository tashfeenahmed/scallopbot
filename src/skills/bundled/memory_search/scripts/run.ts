/**
 * Memory Search Skill Execution Script
 *
 * Wraps existing HybridSearch to expose memory search via skill interface.
 * Receives arguments via SKILL_ARGS environment variable.
 */

import {
  MemoryStore,
  HybridSearch,
  type MemoryType,
  type SearchResult,
} from '../../../../memory/index.js';

// Lazy singleton instances (initialized on first use)
let memoryStore: MemoryStore | null = null;
let hybridSearch: HybridSearch | null = null;

/**
 * Get or create HybridSearch singleton
 */
function getHybridSearch(): HybridSearch {
  if (!hybridSearch) {
    if (!memoryStore) {
      memoryStore = new MemoryStore();
    }
    hybridSearch = new HybridSearch({ store: memoryStore });
  }
  return hybridSearch;
}

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

  // Validate args is an object
  if (!args || typeof args !== 'object') {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS must be a JSON object',
      exitCode: 1,
    });
  }

  const argsObj = args as Record<string, unknown>;

  // Validate required query field
  if (!argsObj.query || typeof argsObj.query !== 'string') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing or invalid "query" field in SKILL_ARGS',
      exitCode: 1,
    });
  }

  // Validate optional type field
  const validTypes = ['raw', 'fact', 'summary', 'preference', 'context', 'all'];
  if (argsObj.type && !validTypes.includes(argsObj.type as string)) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid type "${argsObj.type}". Must be one of: ${validTypes.join(', ')}`,
      exitCode: 1,
    });
  }

  // Validate optional limit field
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
 * Format search results for output
 */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No memories found matching the query.';
  }

  const formatted = results.map((result, index) => {
    const entry = result.entry;
    const lines: string[] = [];
    lines.push(`--- Result ${index + 1} (score: ${result.score.toFixed(3)}, match: ${result.matchType}) ---`);
    lines.push(`ID: ${entry.id}`);
    lines.push(`Type: ${entry.type}`);
    lines.push(`Content: ${entry.content}`);
    lines.push(`Timestamp: ${entry.timestamp.toISOString()}`);
    if (entry.tags?.length) {
      lines.push(`Tags: ${entry.tags.join(', ')}`);
    }
    return lines.join('\n');
  });

  return `Found ${results.length} memories:\n\n${formatted.join('\n\n')}`;
}

/**
 * Execute memory search
 */
async function executeSearch(args: MemorySearchArgs): Promise<void> {
  try {
    const search = getHybridSearch();

    // Determine type: default to 'fact', use undefined for 'all'
    const type: MemoryType | undefined = args.type === 'all' ? undefined : (args.type as MemoryType || 'fact');

    // Apply limit with max cap
    const limit = Math.min(args.limit || 10, 50);

    const results = search.search(args.query, {
      type,
      limit,
      subject: args.subject,
      recencyBoost: true,
      userSubjectBoost: 1.5,
    });

    outputResult({
      success: true,
      output: formatSearchResults(results),
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
  }
}

// Main execution
const args = parseArgs();
executeSearch(args);
