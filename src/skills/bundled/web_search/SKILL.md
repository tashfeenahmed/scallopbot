---
name: web_search
description: "Search the web through the scoped Brave integration. Call this tool directly; never invoke web-search through bash."
user-invocable: false
triggers: [search, web, google, lookup, find information, research]
scripts:
  run: scripts/run.ts
inputSchema:
  type: object
  properties:
    query:
      type: string
      description: Search query
    count:
      type: number
      description: Number of results from 1 to 20
    freshness:
      type: string
      description: Optional recency filter; pd, pw, pm, or py
  required: [query]
metadata:
  openclaw:
    emoji: "\U0001F50D"
    requires:
      env: [BRAVE_SEARCH_API_KEY]
    safety:
      readOnly: true
---

# Web Search Skill

Call `web_search` directly. Its scoped subprocess receives the Brave credential;
generic bash intentionally does not.

Example: `{ "query": "TypeScript tutorial", "count": 10 }`

## Quick Reference

```json
{"query":"React hooks tutorial","count":10}
{"query":"AI news","count":10,"freshness":"pd"}
```

## When to Use

Use `web_search` for:
- **Current events**: News, sports scores, recent developments
- **Research**: Looking up people, companies, products, technologies
- **Documentation**: Finding tutorials, API docs, code examples
- **Fact-checking**: Verifying information, getting authoritative sources
- **General knowledge**: Any question about the real world

## Output Format

Results are formatted as:
```
Search results for "query":

1. Title (age)
   https://example.com/url
   Description of the result...

2. Another Title (2 days ago)
   https://example.com/another
   Another description...
```

News results are prefixed with `[NEWS]` in the title.

## Tips

1. Use `freshness: "pd"` for breaking news.
2. Increase `count` for research tasks, up to 20.
3. Be specific in queries for better results.
4. Open primary result pages with `webfetch` before making factual claims.

## Environment

Requires `BRAVE_SEARCH_API_KEY` environment variable.
Get your API key from: https://api.search.brave.com/
