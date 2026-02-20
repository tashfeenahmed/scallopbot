---
name: codesearch
description: Search for code definitions (functions, classes, interfaces, imports)
user-invocable: false
triggers: [codesearch, definition, find function, find class, find interface, symbol]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    query:
      type: string
      description: "Name or pattern to search for (e.g. 'handleSubmit', 'User')"
    path:
      type: string
      description: "Directory to search in (relative to workspace, default: '.')"
    language:
      type: string
      description: "Language filter: ts, js, py, go, rust, java (auto-detected if omitted)"
      enum: [ts, js, py, go, rust, java]
  required: [query]
metadata:
  openclaw:
    emoji: "\U0001F3AF"
    requires:
      bins: []
---

# Code Search Skill

Search for code definitions — functions, classes, interfaces, imports, and type definitions.

## When to Use

Use codesearch for:

- **Finding definitions**: Locate where a function or class is defined
- **Understanding structure**: Map out interfaces and types
- **Finding imports**: See what a module exports or imports
- **Language-aware search**: Filter by programming language

## Input Format

```json
{
  "query": "handleSubmit",
  "path": "src",
  "language": "ts"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Name or pattern to search for |
| `path` | string | No | `.` | Directory to search in |
| `language` | string | No | auto | Language: ts, js, py, go, rust, java |

## Supported Languages

- **TypeScript/JavaScript**: function, class, interface, type, enum, const/let/var, import/export
- **Python**: def, class, import
- **Go**: func, type, struct, interface
- **Rust**: fn, struct, enum, trait, impl, mod
- **Java**: class, interface, enum, method definitions

## Limitations

- Maximum 100 results
- Regex-based (not AST) — may have false positives
