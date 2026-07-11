---
name: run_code
description: "Write and execute a throwaway multi-line program (python, javascript/node, or bash) and capture its output. Use this instead of bash when you need real logic — loops, parsing, math, data transforms, calling a library — rather than a single shell command. The agent authors a small program on the fly and runs it as a first-class action."
user-invocable: false
triggers: [code, script, compute, calculate, parse, transform, program]
inputSchema:
  type: object
  properties:
    language:
      type: string
      enum: [python, javascript, bash]
      description: "Language to run the code in. 'python' uses python3, 'javascript' uses node, 'bash' uses bash."
    code:
      type: string
      description: "The full source of the program to execute. Multi-line is fine. Print results to stdout."
    timeout:
      type: number
      description: "Timeout in milliseconds (default: 60000, max: 120000)."
  required: [language, code]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F9EE"
    safety:
      localWrite: true
    requires:
      bins: [node]
---

# Run Code Skill

Author a small program and run it. This is the "code-execution-as-action"
primitive: rather than being limited to a fixed catalog of tools, the agent can
write a throwaway script to do exactly what a task needs and execute it.

## When to Use

Reach for `run_code` over `bash` when the task is really a small *program*:

- **Data transforms**: parse JSON/CSV, reshape, aggregate, filter
- **Math / computation**: anything beyond a one-liner
- **Using a library**: call a python or node module to do the heavy lifting
- **Generating a tool on the fly**: write the logic once, run it, read the result

For a single shell command (`ls`, `git status`, `npm install`), use `bash`.

## Input

```json
{
  "language": "python",
  "code": "import json\nprint(json.dumps({'sum': sum(range(10))}))",
  "timeout": 60000
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `language` | string | Yes | - | `python`, `javascript`, or `bash` |
| `code` | string | Yes | - | Full program source; print results to stdout |
| `timeout` | number | No | 60000 | Timeout in ms (max 120000) |

## Output

```json
{
  "success": true,
  "output": "{\"sum\": 45}\n",
  "error": "",
  "exitCode": 0,
  "language": "python"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if the program exited 0 |
| `output` | string | Captured stdout |
| `error` | string | Captured stderr (or error message) |
| `exitCode` | number | Process exit code |

## Notes

- The program runs in the workspace directory; temp source files are written to
  the OS temp dir and cleaned up after execution.
- `python` requires `python3` on PATH; if it's missing, the result explains how
  to install it. `javascript` runs under `node`. `bash` runs under `bash`.
- Output is captured up to 1 MB; long-running programs are killed at the timeout.
- This is not a security sandbox — the same trust model as the `bash` skill.
