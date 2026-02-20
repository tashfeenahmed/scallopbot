---
name: ls
description: List files and directories in the workspace
user-invocable: false
triggers: [ls, list, dir, directory, files, folders]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    path:
      type: string
      description: "Directory path to list (relative to workspace, default: '.')"
    all:
      type: boolean
      description: "Include hidden files (default: false)"
    long:
      type: boolean
      description: "Show detailed info including size and modification time (default: false)"
  required: []
metadata:
  openclaw:
    emoji: "\U0001F4C2"
    requires:
      bins: []
---

# List Directory Skill

List files and directories in the workspace.

## When to Use

Use the ls skill for:

- **Exploring directories**: See what files exist in a folder
- **Understanding project structure**: Get an overview of files and folders
- **Checking for files**: Verify if a file or directory exists

## Input Format

```json
{
  "path": "src",
  "all": false,
  "long": true
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | No | `.` | Directory to list (relative to workspace) |
| `all` | boolean | No | false | Include hidden files |
| `long` | boolean | No | false | Show size, type, and modification time |

## Output Format

```json
{
  "success": true,
  "output": "src/\npackage.json\ntsconfig.json",
  "exitCode": 0
}
```

## Limitations

- Maximum 500 entries returned
- Paths validated to stay within workspace boundaries
