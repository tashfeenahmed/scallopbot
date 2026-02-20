---
name: glob
description: Find files matching a glob pattern in the workspace
user-invocable: false
triggers: [glob, find, files, pattern, match, search files]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    pattern:
      type: string
      description: "Glob pattern to match (e.g. '**/*.ts', 'src/**/*.{js,ts}')"
    path:
      type: string
      description: "Directory to search in (relative to workspace, default: '.')"
  required: [pattern]
metadata:
  openclaw:
    emoji: "\U0001F50D"
    requires:
      bins: []
---

# Glob Skill

Find files matching a glob pattern in the workspace.

## When to Use

Use the glob skill for:

- **Finding files by extension**: `**/*.ts`, `**/*.test.ts`
- **Locating config files**: `**/tsconfig.json`, `**/.env*`
- **Scoped searches**: Find files within a subdirectory
- **Multiple extensions**: `**/*.{ts,js,tsx,jsx}`

## Input Format

```json
{
  "pattern": "**/*.ts",
  "path": "src"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | string | Yes | - | Glob pattern (`*`, `**`, `?`, `{a,b}` supported) |
| `path` | string | No | `.` | Directory to search in |

## Output Format

```json
{
  "success": true,
  "output": "src/index.ts\nsrc/utils/helper.ts",
  "exitCode": 0
}
```

## Limitations

- Maximum 200 results returned
- Respects .gitignore rules
- Skips .git/, node_modules/, and binary files
