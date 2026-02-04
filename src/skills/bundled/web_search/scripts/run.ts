/**
 * Web Search Skill Execution Script
 *
 * Searches the web using Brave Search API and returns JSON results.
 * Receives arguments via SKILL_ARGS environment variable.
 */

// Types
interface SearchArgs {
  query: string;
  count?: number;
  freshness?: string;
}

interface SearchResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveWebResults {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
  news?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
}

// Constants
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const VALID_FRESHNESS = ['pd', 'pw', 'pm', 'py'];

/**
 * Output result as JSON and exit
 */
function outputResult(result: SearchResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

/**
 * Parse and validate arguments from SKILL_ARGS
 */
function parseArgs(): SearchArgs {
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

  const query = (argsObj.query as string).trim();
  if (query.length === 0) {
    outputResult({
      success: false,
      output: '',
      error: 'Query cannot be empty',
      exitCode: 1,
    });
  }

  // Validate count
  let count = DEFAULT_COUNT;
  if (argsObj.count !== undefined) {
    if (typeof argsObj.count !== 'number' || argsObj.count < 1) {
      outputResult({
        success: false,
        output: '',
        error: 'Count must be a positive number',
        exitCode: 1,
      });
    }
    count = Math.min(argsObj.count as number, MAX_COUNT);
  }

  // Validate freshness
  let freshness: string | undefined;
  if (argsObj.freshness !== undefined) {
    if (typeof argsObj.freshness !== 'string' || !VALID_FRESHNESS.includes(argsObj.freshness)) {
      outputResult({
        success: false,
        output: '',
        error: `Invalid freshness value. Must be one of: ${VALID_FRESHNESS.join(', ')}`,
        exitCode: 1,
      });
    }
    freshness = argsObj.freshness;
  }

  return { query, count, freshness };
}

/**
 * Format search results into readable string
 */
function formatResults(results: BraveSearchResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const formatted = results.map((r, i) => {
    const age = r.age ? ` (${r.age})` : '';
    return `${i + 1}. ${r.title}${age}\n   ${r.url}\n   ${r.description}`;
  }).join('\n\n');

  return `Search results for "${query}":\n\n${formatted}`;
}

/**
 * Execute web search
 */
async function executeSearch(args: SearchArgs): Promise<void> {
  // Get API key from environment
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    outputResult({
      success: false,
      output: '',
      error: 'BRAVE_SEARCH_API_KEY environment variable not set',
      exitCode: 1,
    });
  }

  // Build URL with query parameters
  const params = new URLSearchParams({
    q: args.query,
    count: (args.count ?? DEFAULT_COUNT).toString(),
    text_decorations: 'false',
    search_lang: 'en',
    country: 'us',
  });

  if (args.freshness) {
    params.append('freshness', args.freshness);
  }

  try {
    const response = await fetch(`${BRAVE_API_URL}?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      outputResult({
        success: false,
        output: '',
        error: `Search API error: ${response.status} - ${errorText.substring(0, 200)}`,
        exitCode: 1,
      });
    }

    const data = await response.json() as BraveWebResults;

    // Combine web and news results
    const results: BraveSearchResult[] = [];

    if (data.web?.results) {
      for (const r of data.web.results) {
        results.push({
          title: r.title,
          url: r.url,
          description: r.description,
          age: r.age,
        });
      }
    }

    if (data.news?.results) {
      for (const r of data.news.results) {
        results.push({
          title: `[NEWS] ${r.title}`,
          url: r.url,
          description: r.description,
          age: r.age,
        });
      }
    }

    // Limit to requested count
    const limitedResults = results.slice(0, args.count ?? DEFAULT_COUNT);

    outputResult({
      success: true,
      output: formatResults(limitedResults, args.query),
      exitCode: 0,
    });
  } catch (error) {
    const err = error as Error;
    outputResult({
      success: false,
      output: '',
      error: `Search failed: ${err.message}`,
      exitCode: 1,
    });
  }
}

// Main execution
const args = parseArgs();
executeSearch(args);
