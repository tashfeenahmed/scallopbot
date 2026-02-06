---
name: web_search
description: "Search the web for current info. Use bash: web-search 'query'. Options: -n 10 (more results), --fresh pd (past day). Use for news, sports, research, fact-checking."
user-invocable: false
disable-model-invocation: true
triggers: [search, web, google, lookup, find information, research]
metadata:
  openclaw:
    emoji: "\U0001F50D"
    requires:
      bins: [web-search]
      env: [BRAVE_SEARCH_API_KEY]
---

# Web Search Skill (web-search CLI)

Use the `web-search` CLI via the `bash` tool for all web searches. Fast, reliable results from Brave Search API.

Example: `bash("web-search 'TypeScript tutorial'")`

## Quick Reference

```bash
# Basic search
web-search "your query here"

# Get more results (default: 5, max: 20)
web-search -n 10 "React hooks tutorial"

# Filter by recency
web-search --fresh pd "AI news"     # pd=past day
web-search --fresh pw "tech news"   # pw=past week
web-search --fresh pm "releases"    # pm=past month
web-search --fresh py "annual"      # py=past year

# Raw JSON output (for parsing)
web-search --json "query"

# Combine options
web-search -n 10 --fresh pd "breaking news"
```

## When to Use

Use web-search for:
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

## Examples

### Research a topic
```bash
web-search "how to implement OAuth 2.0"
```

### Get recent news
```bash
web-search --fresh pd -n 10 "technology news today"
```

### Find documentation
```bash
web-search "Prisma schema relations documentation"
```

### Fact check something
```bash
web-search "population of Tokyo 2024"
```

### Get raw data for processing
```bash
web-search --json "weather API providers" | jq '.web.results[0]'
```

## Tips

1. **Use quotes** around multi-word queries
2. **Use --fresh pd** for breaking news or recent events
3. **Increase count** with -n for research tasks
4. **Use --json** when you need to parse results programmatically
5. **Be specific** in queries for better results

## Environment

Requires `BRAVE_SEARCH_API_KEY` environment variable.
Get your API key from: https://api.search.brave.com/
