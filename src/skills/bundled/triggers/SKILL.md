---
name: triggers
description: List and manage proactive triggers (automatic follow-ups extracted from conversations)
user-invocable: true
triggers: [triggers, proactive, follow-ups, followups]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [list, cancel, cancel_all]
      description: "Action to perform: list pending triggers, cancel one, or cancel all"
    trigger_id:
      type: string
      description: "Trigger ID to cancel (for 'cancel')"
  required: [action]
metadata:
  openclaw:
    emoji: "\u{1F514}"
    requires:
      bins: []
---

# Triggers Skill

Manage proactive triggers - the automatic follow-ups extracted from your conversations.

## What are Proactive Triggers?

Unlike reminders (which you explicitly set), proactive triggers are automatically created when you mention:
- **Events**: "I have a meeting tomorrow", "dentist on Friday"
- **Commitments**: "I'll finish the report by EOD"
- **Goals**: "trying to lose weight", "learning Spanish"

The bot extracts these and creates follow-up triggers to check in on them.

## When to Use

Use the triggers skill to:
- **List triggers**: See all pending proactive follow-ups
- **Cancel one**: Remove a specific trigger you don't want
- **Cancel all**: Clear all pending triggers

## Input Format

```json
{
  "action": "list"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of: list, cancel, cancel_all |
| `trigger_id` | string | For cancel | ID of trigger to cancel |

## Examples

### List all pending triggers

```json
{
  "action": "list"
}
```

### Cancel a specific trigger

```json
{
  "action": "cancel",
  "trigger_id": "abc123"
}
```

### Cancel all pending triggers

```json
{
  "action": "cancel_all"
}
```

## Output Format

```json
{
  "success": true,
  "output": "Pending triggers:\n- [abc123] Doctor appointment (event_prep) - triggers Feb 10 at 8:00am\n- [def456] Gym follow-up (follow_up) - triggers Feb 8 at 9:00am",
  "exitCode": 0
}
```
