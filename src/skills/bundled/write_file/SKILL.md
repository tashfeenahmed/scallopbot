---
name: write_file
description: Write or create a file in the workspace
user-invocable: false
triggers: [write, create, save, new file]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Path to the file to write (relative to workspace or absolute)"
    content:
      type: string
      description: "Content to write to the file"
    append:
      type: boolean
      description: "Append to file instead of overwriting (default: false)"
    createDirs:
      type: boolean
      description: "Create parent directories if they don't exist (default: true)"
  required: [path, content]
metadata:
  openclaw:
    emoji: "\u270D\uFE0F"
    requires:
      bins: []
---

# Write File Skill

Write content to a file, creating it if it doesn't exist.

## When to Use

Use the write_file skill for:

- **Creating new files**: New source files, configs, documentation
- **Overwriting files**: Replace entire file contents
- **Appending to files**: Add content to end of existing file
- **Creating with directories**: Auto-create parent directories

## Input Format

```json
{
  "path": "src/new-file.ts",
  "content": "export const hello = 'world';",
  "createDirs": true
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | - | Path to file (relative to workspace) |
| `content` | string | Yes | - | Content to write |
| `append` | boolean | No | false | Append instead of overwrite |
| `createDirs` | boolean | No | true | Create parent directories |

## Output Format

```json
{
  "success": true,
  "output": "File written: src/new-file.ts (42 bytes)",
  "exitCode": 0
}
```

## Examples

### Create a new file

```json
{
  "path": "src/utils/helper.ts",
  "content": "export function helper() {\n  return 'help';\n}\n"
}
```

### Append to a file

```json
{
  "path": "log.txt",
  "content": "New log entry\n",
  "append": true
}
```

## Security

- Paths are validated to stay within workspace
- Cannot write to system directories
- Symlinks escaping workspace are blocked
