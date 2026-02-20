---
name: apply_patch
description: Apply a unified diff patch to a file
user-invocable: false
triggers: [patch, diff, apply, unified diff, hunk]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Path to the file to patch (relative to workspace)"
    patch:
      type: string
      description: "Unified diff patch content (with @@ hunk headers)"
  required: [path, patch]
metadata:
  openclaw:
    emoji: "\U0001FA79"
    requires:
      bins: []
---

# Apply Patch Skill

Apply a unified diff patch to a file, supporting context line verification and fuzz tolerance.

## When to Use

Use apply_patch for:

- **Applying diffs**: Apply patches from code reviews or version control
- **Precise edits**: When you have exact diff output to apply
- **Multi-hunk changes**: Apply several related changes in diff format

## Input Format

```json
{
  "path": "src/app.ts",
  "patch": "@@ -5,3 +5,3 @@\n context line\n-old line\n+new line\n context line"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | File path (relative to workspace) |
| `patch` | string | Yes | - | Unified diff content with @@ headers |

## Patch Format

Standard unified diff format:
- `@@ -start,count +start,count @@` — hunk header
- Lines starting with ` ` (space) — context lines
- Lines starting with `-` — removed lines
- Lines starting with `+` — added lines
- `---`/`+++` headers are optional and stripped if present

## Behavior

- Context lines are verified with +/- 3 lines fuzz tolerance
- Hunks are applied bottom-up to avoid line shift cascading
- If any hunk fails to apply, the entire patch is rejected

## Limitations

- File must be within workspace boundaries
- Context lines must match (with fuzz tolerance)
