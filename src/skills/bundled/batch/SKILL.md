---
name: batch
description: Execute multiple tool calls in parallel within a single response
user-invocable: false
disable-model-invocation: true
triggers: [batch, parallel, concurrent, multi tool]
metadata:
  openclaw:
    emoji: "\u26A1"
    requires:
      bins: []
---

# Batch Skill

Execute multiple tool calls in parallel within a single response.

## How It Works

This is a documentation-only skill — there is no script to run. Instead, the agent should emit multiple `tool_use` blocks in a single response. The agent loop already handles parallel tool execution natively.

## When to Use

Use batch execution when:

- **Independent operations**: Multiple file reads, searches, or edits that don't depend on each other
- **Gathering information**: Reading several files at once to understand a codebase
- **Parallel writes**: Writing multiple independent files simultaneously
- **Speed optimization**: When operations can run concurrently

## How to Use

Simply include multiple tool calls in a single response. For example, to read three files at once:

```
[tool_use: read_file with path="src/a.ts"]
[tool_use: read_file with path="src/b.ts"]
[tool_use: read_file with path="src/c.ts"]
```

All three will execute in parallel and results will be returned together.

## Guidelines

- Only batch **independent** operations — if tool B depends on tool A's result, run them sequentially
- The agent loop handles execution, error handling, and result aggregation automatically
- Each tool call in the batch is executed independently — one failure does not affect others
- Results are returned in the order the tools complete
