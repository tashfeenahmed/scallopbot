/**
 * Brave Search API Tool
 *
 * Provides web search capability using the Brave Search API.
 * Much more reliable than browser-based searches (no CAPTCHAs).
 */

import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition } from '../providers/types.js';

export interface BraveSearchConfig {
  apiKey: string;
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
  query?: {
    original: string;
  };
}

export class BraveSearchTool implements Tool {
  public readonly name = 'web_search';
  public readonly description = 'Search the web using Brave Search API';

  private apiKey: string;

  public readonly definition: ToolDefinition = {
    name: 'web_search',
    description: `Search the web for information. Use this for:
- Current events, news, sports scores
- Looking up people, companies, products
- Finding documentation, tutorials
- Fact-checking information
- Any question about the real world

This is the PREFERRED way to search the web - much faster and more reliable than browser navigation.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 20)',
        },
        freshness: {
          type: 'string',
          enum: ['pd', 'pw', 'pm', 'py'],
          description: 'Filter by freshness: pd=past day, pw=past week, pm=past month, py=past year',
        },
      },
      required: ['query'],
    },
  };

  constructor(config: BraveSearchConfig) {
    this.apiKey = config.apiKey;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const count = Math.min((input.count as number) || 5, 20);
    const freshness = input.freshness as string | undefined;

    if (!query || query.trim().length === 0) {
      return {
        success: false,
        output: '',
        error: 'Search query is required',
      };
    }

    context.logger.info({ query, count, freshness }, 'Searching with Brave Search API');

    try {
      // Build URL with query parameters
      const params = new URLSearchParams({
        q: query,
        count: count.toString(),
        text_decorations: 'false',
        search_lang: 'en',
        country: 'us',
      });

      if (freshness) {
        params.append('freshness', freshness);
      }

      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        context.logger.error({ status: response.status, error: errorText }, 'Brave Search API error');
        return {
          success: false,
          output: '',
          error: `Search API error: ${response.status} - ${errorText.substring(0, 200)}`,
        };
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

      if (results.length === 0) {
        return {
          success: true,
          output: `No results found for: "${query}"`,
        };
      }

      // Format results
      const formattedResults = results.slice(0, count).map((r, i) => {
        const age = r.age ? ` (${r.age})` : '';
        return `${i + 1}. ${r.title}${age}\n   ${r.url}\n   ${r.description}`;
      }).join('\n\n');

      context.logger.info({ query, resultCount: results.length }, 'Search completed');

      return {
        success: true,
        output: `Search results for "${query}":\n\n${formattedResults}`,
      };
    } catch (error) {
      const err = error as Error;
      context.logger.error({ error: err.message }, 'Brave Search failed');
      return {
        success: false,
        output: '',
        error: `Search failed: ${err.message}`,
      };
    }
  }
}

/**
 * Initialize the Brave Search tool from environment
 */
export function initializeBraveSearch(): BraveSearchTool | null {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new BraveSearchTool({ apiKey });
}
