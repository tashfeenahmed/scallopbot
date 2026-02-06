---
name: progress
description: Check progress on goals and get a summary of active work
user-invocable: true
triggers: [progress, how am i doing, status, tracking, overview]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    goal_id:
      type: string
      description: "Specific goal ID to check (optional, shows all if omitted)"
    verbose:
      type: boolean
      description: "Show detailed breakdown with all milestones and tasks"
metadata:
  openclaw:
    emoji: "📊"
    requires:
      bins: []
---

# Progress Skill

Get a quick overview of your goal progress.

## When to Use

Use the progress skill when you want to:

- Get a summary of all active goals
- Check progress on a specific goal
- See what tasks are pending
- Get an overview of overdue items

## Input Format

### Check all goals

```json
{}
```

### Check specific goal

```json
{
  "goal_id": "abc123"
}
```

### Detailed breakdown

```json
{
  "verbose": true
}
```

## Output Format

The skill returns a formatted progress report:

```
GOAL PROGRESS SUMMARY

Learn Spanish [50%] ████████░░░░░░░░ Due: Dec 31
  2/4 milestones | 5/10 tasks

Build Portfolio Website [25%] ████░░░░░░░░░░░░ OVERDUE
  1/4 milestones | 3/12 tasks
```

## Examples

### Quick overview

```json
{}
```

Output:
```
GOAL PROGRESS SUMMARY

Learn Spanish [50%] ████████░░░░░░░░ Due: Dec 31
  2/4 milestones | 5/10 tasks

No overdue goals.
```

### Detailed view

```json
{"verbose": true}
```

Output:
```
GOAL PROGRESS SUMMARY

Learn Spanish [50%]
  [x] Complete Duolingo basics (100%)
      [x] Finish lessons 1-5
      [x] Complete review quiz
  [ ] Start conversation practice (0%)
      [ ] Find language partner
      [ ] Schedule first session
```
