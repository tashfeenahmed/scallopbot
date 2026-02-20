---
name: grep
description: Search file contents using regex patterns
user-invocable: false
triggers: [grep, search, find text, regex, rg, ripgrep]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    pattern:
      type: string
      description: "Regex pattern to search for"
    path:
      type: string
      description: "Directory to search in (relative to workspace, default: '.')"
    glob:
      type: string
      description: "Glob pattern to filter files (e.g. '*.ts')"
    context:
      type: number
      description: "Number of context lines before and after each match (default: 0)"
    max_results:
      type: number
      description: "Maximum number of matches to return (default: 50)"
  required: [pattern]
metadata:
  openclaw:
    emoji: "\U0001F50E"
    requires:
      bins: []
---

# Grep Skill

Search file contents using regex patterns. Uses ripgrep (`rg`) when available for speed, falls back to pure JavaScript.

## When to Use

Use the grep skill for:

- **Finding code references**: Search for function calls, variable usage
- **Finding strings**: Search for error messages, log entries
- **Regex searching**: Complex pattern matching across files
- **Scoped searches**: Search within specific file types

## Input Format

```json
{
  "pattern": "function\\s+\\w+",
  "path": "src",
  "glob": "*.ts",
  "context": 2,
  "max_results": 20
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | string | Yes | - | Regex pattern to search for |
| `path` | string | No | `.` | Directory to search in |
| `glob` | string | No | - | Glob pattern to filter files |
| `context` | number | No | 0 | Context lines around matches |
| `max_results` | number | No | 50 | Maximum matches returned |

## Output Format

```
src/index.ts:5: export function main() {
src/utils.ts:12: function helper(x: number) {
```

## Limitations

- Maximum 50 results by default (configurable)
- Skips binary files
- Respects .gitignore rules
