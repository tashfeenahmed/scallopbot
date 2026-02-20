---
name: question
description: Ask the user a clarifying question
user-invocable: false
triggers: [ask, question, clarify, confirm, prompt]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    question:
      type: string
      description: "The question to ask the user"
    options:
      type: array
      description: "Optional list of choices for the user to pick from"
      items:
        type: string
  required: [question]
metadata:
  openclaw:
    emoji: "\u2753"
    requires:
      bins: []
---

# Question Skill

Ask the user a clarifying question, optionally with multiple-choice options.

## When to Use

Use the question skill when:

- **Ambiguous instructions**: The user's request is unclear
- **Confirmation needed**: Before taking a destructive action
- **Multiple paths**: There are several valid approaches
- **Missing information**: You need details to proceed

## Input Format

```json
{
  "question": "Which database should I use?",
  "options": ["PostgreSQL", "SQLite", "MongoDB"]
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | Yes | - | The question to ask |
| `options` | string[] | No | - | List of options to choose from |

## Output Format

The question is formatted for display and returned as the tool result.
The agent incorporates this into its response to the user.
