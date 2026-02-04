---
name: bash
description: Execute shell commands in the workspace directory
user-invocable: false
triggers: [command, shell, terminal, execute, run, bash]
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
| `output` | string | Captured stdout (truncated at 30KB) |
| `error` | string | Captured stderr or error message |
| `exitCode` | number | Process exit code |

## Safety Considerations

1. **No interactive commands**: Commands requiring user input will hang or fail
2. **Avoid destructive operations**: Always confirm before `rm -rf`, `git reset --hard`, etc.
3. **Sensitive data**: Don't echo secrets or credentials to output
4. **Long-running processes**: Use appropriate timeouts; default is 60 seconds
5. **Resource limits**: Output is truncated at 30KB to prevent memory issues

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
