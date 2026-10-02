/**
 * Web tools: native `webfetch` and an in-process `web_search` with a
 * 20-minute single-flight cache. Tool names are unchanged.
 *
 * Wire with one call: `registerWebTools(skillRegistry, deps)`.
 */

import { defineSkill } from '../../skills/sdk.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { SkillHandlerFn } from '../../skills/types.js';
import { webFetch, WEBFETCH_CAP_CHARS, type WebFetchDeps } from './fetch.js';
import { cachedSearch, parseSearchArgs, type SearchDeps } from './search.js';

export { webFetch, htmlToText, WEBFETCH_CAP_CHARS } from './fetch.js';
export { braveSearch, cachedSearch, clearSearchCache, searchCacheKey, SEARCH_CACHE_TTL_MS } from './search.js';
export { unusableWebContentReason } from './content-quality.js';

export interface WebToolDeps {
  fetch?: WebFetchDeps;
  search?: SearchDeps;
}

const WEBFETCH_DESCRIPTION = `Fetch a URL (http/https) and return its text with HTML stripped. Results over ${WEBFETCH_CAP_CHARS} chars show the head and tail; the full text is saved to a file whose path is in the result (page it with read_file offset/limit). No JavaScript rendering.`;

export function registerWebTools(
  registry: Pick<SkillRegistry, 'registerSkill' | 'getSkill'>,
  deps: WebToolDeps = {},
): void {
  const fetchTool = defineSkill('webfetch', WEBFETCH_DESCRIPTION)
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        max_length: { type: 'number', description: `Max characters to return (default and max ${WEBFETCH_CAP_CHARS})` },
      },
      required: ['url'],
    })
    .onNativeExecute(ctx => webFetch(ctx.args, ctx, deps.fetch))
    .build();
  registry.registerSkill(fetchTool.skill);

  const handler: SkillHandlerFn = async (ctx) => {
    const parsed = parseSearchArgs(ctx.args);
    if ('error' in parsed) return { success: false, output: parsed.error };
    return cachedSearch(parsed, deps.search);
  };

  // Keep the bundled SKILL.md's description, schema and env gating; swap in
  // the in-process handler so the cache is shared across turns.
  const disk = registry.getSkill('web_search');
  if (disk) {
    registry.registerSkill({ ...disk, source: 'sdk', hasScripts: true, handler });
    return;
  }
  const searchTool = defineSkill('web_search', 'Search the web (Brave). Call this tool directly; never run web-search through bash.')
    .userInvocable(false)
    .requiresEnv('BRAVE_SEARCH_API_KEY')
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results from 1 to 20' },
        freshness: { type: 'string', description: 'Optional recency filter; pd, pw, pm, or py' },
      },
      required: ['query'],
    })
    .onNativeExecute(handler)
    .build();
  registry.registerSkill(searchTool.skill);
}
