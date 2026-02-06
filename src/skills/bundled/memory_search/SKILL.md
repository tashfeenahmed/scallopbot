---
name: memory_search
description: "Search the user's long-term memory for stored facts and past context. Use when the user references something personal, past conversations, or people/projects by name. Do NOT use for current events, news, or real-time info — use bash with web-search for that."
user-invocable: true
triggers: [remember, recall, memory, search memories, what do you know]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F9E0"
    requires:
      bins: []
---

# Memory Search Skill

Search through stored memories using hybrid search combining BM25 keyword matching and semantic similarity. Returns ranked results with relevance scores.

## When to Use

Use the memory_search skill for:

- **Finding user facts**: Recall what you've learned about the user
- **Searching preferences**: Find stored user preferences
- **Retrieving context**: Get relevant past conversation context
- **Subject-specific queries**: Find facts about specific people (user, friends, family)

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "query": "what does the user like to eat"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query - keywords, phrases, or natural language questions |
| `type` | string | No | Filter by memory type: raw, fact, summary, preference, context, or all. Default: fact |
| `subject` | string | No | Filter to facts about specific person (e.g., "user", "Hamza", "John") |
| `limit` | number | No | Maximum results to return (default: 10, max: 50) |

### Memory Types

- **fact** (default): Extracted facts about the user or others
- **preference**: User preferences and settings
- **raw**: Unprocessed conversation data
- **summary**: Condensed summaries
- **context**: Processed contextual information
- **all**: Search all memory types

## Output Format

The skill returns JSON to stdout:

```json
{
  "success": true,
  "output": "Found 3 memories:\n\n--- Result 1 (score: 0.850) ---\nContent: User enjoys Italian food...",
  "exitCode": 0
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if search completed successfully |
| `output` | string | Formatted search results or error message |
| `error` | string | Error message if search failed |
| `exitCode` | number | Process exit code (0 = success) |

## Examples

### Basic fact search

```json
{ "query": "user's favorite food" }
```

### Search with subject filter

```json
{ "query": "birthday", "subject": "user" }
```

### Search all memory types

```json
{ "query": "conversation about work", "type": "all", "limit": 20 }
```

### Search for preferences

```json
{ "query": "notification settings", "type": "preference" }
```

## Search Behavior

- **Hybrid search**: Combines BM25 keyword matching with semantic similarity
- **Default type**: Searches "fact" type by default (not raw logs)
- **Recency boost**: Recent memories ranked higher by default
- **User boost**: Facts about the user get 1.5x score boost
- **Relevance scoring**: Results sorted by combined relevance score
