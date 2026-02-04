---
name: read_file
description: Read contents of a file from the workspace
user-invocable: false
triggers: [read, cat, view, show, display, contents]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Path to the file to read (relative to workspace or absolute)"
    offset:
      type: number
      description: "Line number to start reading from (1-indexed, default: 1)"
    limit:
      type: number
      description: "Maximum number of lines to read (default: all)"
    encoding:
      type: string
      description: "File encoding (default: utf-8)"
  required: [path]
metadata:
  openclaw:
    emoji: "\U0001F4D6"
    requires:
      bins: []
---

# Read File Skill

Read the contents of a file from the workspace.

## When to Use

Use the read_file skill for:

- **Reading source code**: View implementation details
- **Reading configuration**: Check config files, package.json, etc.
- **Reading documentation**: View README, docs, comments
- **Reading data files**: CSV, JSON, text files
- **Partial reads**: Read specific line ranges for large files

## Input Format

```json
{
  "path": "src/index.ts",
  "offset": 1,
  "limit": 100
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Path to file (relative to workspace) |
| `offset` | number | No | 1 | Start line (1-indexed) |
| `limit` | number | No | 2000 | Max lines to read |
| `encoding` | string | No | utf-8 | File encoding |

## Output Format

```json
{
  "success": true,
  "output": "file contents here...",
  "exitCode": 0,
  "metadata": {
    "path": "/full/path/to/file",
    "lines": 150,
    "size": 4096
  }
}
```

## Examples

### Read entire file

```json
{ "path": "package.json" }
```

### Read specific lines

```json
{
  "path": "src/app.ts",
  "offset": 100,
  "limit": 50
}
```

## Security

- Paths are validated to stay within workspace boundaries
- Symlinks that escape workspace are blocked
- Binary files return an error
