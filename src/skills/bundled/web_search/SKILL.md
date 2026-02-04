---
name: web_search
description: Search the web using Brave Search API
user-invocable: true
triggers: [search, web, google, lookup, find information]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F50D"
    requires:
      env: [BRAVE_SEARCH_API_KEY]
---

# Web Search Skill

Search the web for information using the Brave Search API. This is the preferred method for web searches - fast, reliable, and no CAPTCHAs.

## When to Use

Use the web search skill for:

- **Current events**: News, sports scores, recent developments
- **Research**: Looking up people, companies, products, technologies
- **Documentation**: Finding tutorials, API docs, code examples
- **Fact-checking**: Verifying information, getting authoritative sources
- **General knowledge**: Any question about the real world

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "query": "TypeScript tutorial 2024",
  "count": 5,
  "freshness": "pm"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | The search query |
| `count` | number | No | 5 | Number of results to return (max: 20) |
| `freshness` | string | No | - | Filter by recency: pd=past day, pw=past week, pm=past month, py=past year |

## Output Format

The skill returns JSON to stdout:

```json
{
  "success": true,
  "output": "Search results for \"TypeScript tutorial\":\n\n1. Learn TypeScript (2 days ago)\n   https://example.com\n   A comprehensive guide...",
  "exitCode": 0
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if search completed successfully |
| `output` | string | Formatted search results or error message |
| `error` | string | Error description if search failed |
| `exitCode` | number | 0 for success, 1 for error |

## Result Format

Each search result is formatted as:

```
N. Title (age)
   URL
   Description
```

News results are prefixed with `[NEWS]` in the title.

## Environment Requirements

- **BRAVE_SEARCH_API_KEY**: Required. Obtain from https://api.search.brave.com/

## Examples

### Basic search

```json
{ "query": "React hooks tutorial" }
```

### Get more results

```json
{
  "query": "Node.js best practices",
  "count": 10
}
```

### Recent results only

```json
{
  "query": "AI news",
  "freshness": "pd"
}
```

### Documentation lookup

```json
{
  "query": "Prisma schema relations",
  "count": 5,
  "freshness": "py"
}
```
