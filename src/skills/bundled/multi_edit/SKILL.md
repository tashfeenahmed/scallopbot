---
name: multi_edit
description: Apply multiple text replacements to a single file atomically
user-invocable: false
triggers: [multi edit, multiple edits, batch edit, bulk edit, refactor]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Path to the file to edit (relative to workspace)"
    edits:
      type: array
      description: "List of edits to apply in order"
      items:
        type: object
        properties:
          old_string:
            type: string
            description: "Text to find and replace"
          new_string:
            type: string
            description: "Replacement text"
        required: [old_string, new_string]
  required: [path, edits]
metadata:
  openclaw:
    emoji: "\u270F\uFE0F"
    requires:
      bins: []
---

# Multi Edit Skill

Apply multiple text replacements to a single file atomically. All edits succeed or none are applied.

## When to Use

Use multi_edit for:

- **Multiple related changes**: Rename a variable across a file
- **Refactoring**: Make several coordinated edits at once
- **Atomic updates**: Ensure partial edits don't corrupt the file

## Input Format

```json
{
  "path": "src/config.ts",
  "edits": [
    { "old_string": "const PORT = 3000", "new_string": "const PORT = 8080" },
    { "old_string": "const HOST = 'localhost'", "new_string": "const HOST = '0.0.0.0'" }
  ]
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | File path (relative to workspace) |
| `edits` | array | Yes | - | List of {old_string, new_string} pairs |

## Behavior

- Each edit replaces the **first occurrence** only
- Edits are simulated first — if any `old_string` is not found, all edits fail
- Ambiguous matches (multiple occurrences) cause failure
- No partial writes — all or nothing

## Limitations

- File must be within workspace boundaries
- Each old_string must appear exactly once in the file (after previous edits are simulated)
