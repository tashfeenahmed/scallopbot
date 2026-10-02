/**
 * `web_search` through the Brave Search API, with a 20-minute in-process
 * single-flight cache: identical queries share one request (even when issued
 * concurrently) and reuse its result for 20 minutes. Failures are not cached.
 */

export const SEARCH_CACHE_TTL_MS = 20 * 60 * 1000;
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const VALID_FRESHNESS = ['pd', 'pw', 'pm', 'py'];
const MAX_CACHE_ENTRIES = 200;

export interface SearchArgs {
  query: string;
  count: number;
  freshness?: string;
}

export interface SearchResult {
  success: boolean;
  output: string;
}

export interface SearchDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  now?: () => number;
}

interface BraveItem { title: string; url: string; description: string; age?: string }
interface BraveResponse {
  web?: { results?: BraveItem[] };
  news?: { results?: BraveItem[] };
}

export function parseSearchArgs(raw: Record<string, unknown>): SearchArgs | { error: string } {
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) return { error: 'Missing or empty "query"' };
  let count = DEFAULT_COUNT;
  if (raw.count !== undefined) {
    const n = typeof raw.count === 'string' ? Number(raw.count) : raw.count;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return { error: 'count must be a positive number' };
    count = Math.min(Math.floor(n), MAX_COUNT);
  }
  let freshness: string | undefined;
  if (raw.freshness !== undefined && raw.freshness !== '') {
    if (typeof raw.freshness !== 'string' || !VALID_FRESHNESS.includes(raw.freshness)) {
      return { error: `Invalid freshness; use one of ${VALID_FRESHNESS.join(', ')}` };
    }
    freshness = raw.freshness;
  }
  return { query, count, freshness };
}

function formatResults(results: BraveItem[], query: string): string {
  if (results.length === 0) return `No results found for: "${query}"`;
  const lines = results.map((r, i) => {
    const age = r.age ? ` (${r.age})` : '';
    return `${i + 1}. ${r.title}${age}\n   ${r.url}\n   ${r.description}`;
  });
  return `Search results for "${query}":\n\n${lines.join('\n\n')}`;
}

/** One uncached Brave request. */
export async function braveSearch(args: SearchArgs, deps: SearchDeps = {}): Promise<SearchResult> {
  const apiKey = deps.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return { success: false, output: 'BRAVE_SEARCH_API_KEY is not set' };
  const params = new URLSearchParams({
    q: args.query,
    count: String(args.count),
    text_decorations: 'false',
    search_lang: 'en',
    country: 'us',
  });
  if (args.freshness) params.append('freshness', args.freshness);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${BRAVE_API_URL}?${params}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, output: `Search API error: ${response.status} - ${text.slice(0, 200)}` };
    }
    const data = await response.json() as BraveResponse;
    const results: BraveItem[] = [
      ...(data.web?.results ?? []),
      ...(data.news?.results ?? []).map(r => ({ ...r, title: `[NEWS] ${r.title}` })),
    ].slice(0, args.count);
    return { success: true, output: formatResults(results, args.query) };
  } catch (e) {
    return { success: false, output: `Search failed: ${(e as Error).message}` };
  }
}

interface CacheEntry { expiresAt: number; promise: Promise<SearchResult> }
const cache = new Map<string, CacheEntry>();

export function searchCacheKey(args: SearchArgs): string {
  return JSON.stringify([args.query.toLowerCase().replace(/\s+/g, ' '), args.count, args.freshness ?? '']);
}

/** Cached + single-flight search. */
export function cachedSearch(args: SearchArgs, deps: SearchDeps = {}): Promise<SearchResult> {
  const now = (deps.now ?? Date.now)();
  const key = searchCacheKey(args);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;

  const promise = braveSearch(args, deps).then((result) => {
    // Only successful results stay cached.
    if (!result.success && cache.get(key)?.promise === promise) cache.delete(key);
    return result;
  });
  cache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, promise });
  if (cache.size > MAX_CACHE_ENTRIES) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now || cache.size > MAX_CACHE_ENTRIES) cache.delete(k);
      if (cache.size <= MAX_CACHE_ENTRIES) break;
    }
  }
  return promise;
}

export function clearSearchCache(): void {
  cache.clear();
}
