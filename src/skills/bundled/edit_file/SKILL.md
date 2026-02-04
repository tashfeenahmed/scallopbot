---
name: edit_file
description: Make targeted edits to a file by replacing specific text
user-invocable: false
triggers: [edit, modify, change, update, replace]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Path to the file to edit (relative to workspace or absolute)"
    old_string:
      type: string
      description: "The exact text to find and replace"
    new_string:
      type: string
      description: "The text to replace it with"
    replace_all:
      type: boolean
      description: "Replace all occurrences (default: false, replaces first only)"
  required: [path, old_string, new_string]
metadata:
  openclaw:
    emoji: "\u270F\uFE0F"
    requires:
      bins: []
---

# Edit File Skill

Make targeted edits to a file by finding and replacing specific text.

## When to Use

Use the edit_file skill for:

- **Modifying code**: Change function implementations, fix bugs
- **Updating configs**: Change values in configuration files
- **Refactoring**: Rename variables, update imports
- **Precise edits**: Make specific changes without rewriting entire file

## Input Format

```json
{
  "path": "src/config.ts",
  "old_string": "const DEBUG = false;",
  "new_string": "const DEBUG = true;"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Path to file (relative to workspace) |
| `old_string` | string | Yes | - | Exact text to find |
| `new_string` | string | Yes | - | Replacement text |
| `replace_all` | boolean | No | false | Replace all occurrences |

## Output Format

```json
{
  "success": true,
  "output": "Edited file: src/config.ts (1 replacement made)",
  "exitCode": 0
}
```

## Important Notes

1. **Exact match required**: `old_string` must match exactly (including whitespace)
2. **Unique match**: For single replacement, `old_string` should be unique in the file
3. **Include context**: If text isn't unique, include surrounding lines for context

## Examples

### Simple replacement

```json
{
  "path": "src/app.ts",
  "old_string": "const version = '1.0.0';",
  "new_string": "const version = '1.0.1';"
}
```

### Replace all occurrences

```json
{
  "path": "src/utils.ts",
  "old_string": "oldFunctionName",
  "new_string": "newFunctionName",
  "replace_all": true
}
```

### Multi-line replacement

```json
{
  "path": "src/component.tsx",
  "old_string": "function Button() {\n  return <button>Click</button>;\n}",
  "new_string": "function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}"
}
```

## Security

- Paths are validated to stay within workspace
- Cannot edit system files
- File must exist (use write_file to create new files)
