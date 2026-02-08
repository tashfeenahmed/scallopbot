---
name: bash
description: "Execute shell commands. Use for: running web-search and agent-browser CLIs, installing packages, running scripts (python3, node), system commands. This is your gateway to web search, browsing, and code execution."
user-invocable: false
triggers: [command, shell, terminal, execute, run, bash]
inputSchema:
  type: object
  properties:
    command:
      type: string
      description: "The bash command to execute"
    timeout:
      type: number
      description: "Timeout in milliseconds (default: 60000)"
    cwd:
      type: string
      description: "Working directory for execution"
    max_output:
      type: number
      description: "Maximum output size in bytes (default: 30720). Increase when you need to see more output (e.g. long test runs, large search results). Max: 204800."
  required: [command]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F4BB"
    requires:
      bins: [bash]
---

# Bash Skill

Execute shell commands in the workspace directory with output capture and timeout handling.

## When to Use

Use the bash skill for:

- **Running commands**: Execute shell commands like `ls`, `npm`, `git`, etc.
- **Checking system state**: Check file existence, disk space, process status
- **File operations**: Move, copy, delete files (when dedicated file skills aren't appropriate)
- **Package management**: Install dependencies, run build scripts
- **Testing**: Run test suites, linters, type checkers

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "command": "echo 'Hello World'",
  "timeout": 60000,
  "cwd": "/path/to/directory"
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | - | The bash command to execute |
| `timeout` | number | No | 60000 | Timeout in milliseconds |
| `cwd` | string | No | workspace | Working directory for execution |
| `max_output` | number | No | 30720 | Max output bytes. Increase for long test runs or large search results. Max: 204800 |

## Output Format

The skill returns JSON to stdout:

```json
{
  "success": true,
  "output": "command output here",
  "error": "stderr content if any",
  "exitCode": 0
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if command exited with code 0 |
| `output` | string | Captured stdout (truncated at max_output limit, default 30KB) |
| `error` | string | Captured stderr or error message |
| `exitCode` | number | Process exit code |

## Safety Considerations

1. **No interactive commands**: Commands requiring user input will hang or fail
2. **Avoid destructive operations**: Always confirm before `rm -rf`, `git reset --hard`, etc.
3. **Sensitive data**: Don't echo secrets or credentials to output
4. **Long-running processes**: Use appropriate timeouts; default is 60 seconds
5. **Resource limits**: Output is truncated at 30KB by default (adjustable via `max_output`, up to 200KB)

## Security Features

The bash skill includes basic protections against accidental damage:

### Dangerous Command Blocking

The following patterns are automatically blocked with exit code 126:

- `rm -rf /` and variations (root filesystem removal)
- `--no-preserve-root` flag (bypassing safety)
- Fork bombs like `:(){ :|:& };:`
- Direct device access (`/dev/sda`, `/dev/nvme`, etc.)
- Filesystem formatting (`mkfs` commands)
- `dd` writes to raw devices
- Writes to system directories (`/etc`, `/boot`, `/sys`, `/proc`)

### Path Restrictions

The `cwd` parameter is validated to prevent escaping the workspace:

- Path traversal with `../` that escapes workspace is blocked
- Symlinks that resolve outside workspace are blocked
- All paths are resolved relative to the workspace root

**Note:** These are basic protections to prevent obvious accidents, not a security sandbox. They don't protect against determined malicious use.

## Examples

### Check directory contents

```json
{ "command": "ls -la" }
```

### Run tests with timeout

```json
{
  "command": "npm test",
  "timeout": 120000
}
```

### Execute in specific directory

```json
{
  "command": "git status",
  "cwd": "/path/to/repo"
}
```

### Check Node.js version

```json
{ "command": "node --version" }
```
