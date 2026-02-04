---
name: reminder
description: Set, list, and cancel reminders that trigger messages at specified times
user-invocable: true
triggers: [remind, reminder, alarm, schedule, notify, timer]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [set, list, cancel]
      description: "Action to perform: set a new reminder, list active reminders, or cancel one"
    time:
      type: string
      description: "When to trigger (for 'set'). Examples: '5 minutes', 'at 10am', 'tomorrow at 9am', 'every day at 10am'"
    message:
      type: string
      description: "The reminder message (for 'set')"
    reminder_id:
      type: string
      description: "Reminder ID to cancel (for 'cancel')"
  required: [action]
metadata:
  openclaw:
    emoji: "\u23F0"
    requires:
      bins: []
---

# Reminder Skill

Set reminders that trigger messages back to the user at specified times.

## When to Use

Use the reminder skill for:

- **One-time reminders**: "remind me to call mom in 30 minutes"
- **Scheduled reminders**: "remind me at 3pm to take medicine"
- **Tomorrow reminders**: "remind me tomorrow at 9am about the meeting"
- **Recurring reminders**: "remind me every day at 10am to check email"
- **Managing reminders**: List or cancel existing reminders

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "action": "set",
  "time": "in 30 minutes",
  "message": "Call mom"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of: set, list, cancel |
| `time` | string | For set | When to trigger the reminder |
| `message` | string | For set | What to remind about |
| `reminder_id` | string | For cancel | ID of reminder to cancel |

### Time Format Examples

**Intervals:**
- `5 minutes`, `30 min`, `1 hour`, `2 hours`

**Absolute times:**
- `at 10am`, `at 3:30pm`, `at 14:00`
- `tomorrow at 9am`, `tomorrow at 3pm`

**Recurring:**
- `every day at 10am`, `daily at 9:30am`
- `every Monday at 9am`, `every friday at 3pm`
- `weekdays at 8am`, `weekends at 10am`

## Output Format

```json
{
  "success": true,
  "output": "Reminder set! I'll remind you \"Call mom\" in 30 minutes. Next trigger: Mon, Jan 20 at 3:30 PM. ID: abc123",
  "exitCode": 0
}
```

## Examples

### Set a one-time reminder

```json
{
  "action": "set",
  "time": "in 30 minutes",
  "message": "Take a break"
}
```

### Set a reminder for specific time

```json
{
  "action": "set",
  "time": "tomorrow at 8am",
  "message": "Bring milk"
}
```

### Set a recurring reminder

```json
{
  "action": "set",
  "time": "every day at 10am",
  "message": "Stand up and stretch"
}
```

### List active reminders

```json
{
  "action": "list"
}
```

### Cancel a reminder

```json
{
  "action": "cancel",
  "reminder_id": "abc123"
}
```
