---
name: board
description: Manage the task board - view, create, move, prioritize, and track work items
user-invocable: true
triggers: [board, kanban, tasks, todo, plate, "what's next", remind, reminder, schedule,
           work items, priorities, progress, status, overview, "how am i doing"]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [view, add, move, update, done, archive, detail, snooze]
      description: "Action to perform on the board"
    column:
      type: string
      enum: [inbox, backlog, scheduled, in_progress, waiting, done, archived]
      description: "Filter by column (for view) or target column (for move)"
    priority:
      type: string
      enum: [urgent, high, medium, low]
      description: "Priority level (for add/update/view filter)"
    label:
      type: string
      description: "Filter by label (for view)"
    title:
      type: string
      description: "Item title/message (for add/update)"
    kind:
      type: string
      enum: [nudge, task]
      description: "nudge=message reminder, task=sub-agent work (for add/update)"
    trigger_time:
      type: string
      description: "For ONE-OFF items only: 'in 30 min', 'tomorrow 9am', 'at 3pm', 'today 7pm'. For recurring schedules (every day / daily / every Monday / weekdays / weekends) use the `recurring` object instead — do NOT put 'every day at 8am' in trigger_time."
    recurring:
      type: object
      description: "USE THIS for any user request containing 'every day', 'daily', 'every Monday/Tuesday/...', 'weekdays', or 'weekends'. Example: user says 'remind me every day at 8am to take vitamins' → pass recurring={type:'daily',hour:8,minute:0} and leave trigger_time unset. The item will automatically re-fire on the next occurrence after each trigger."
      properties:
        type:
          type: string
          enum: [daily, weekly, weekdays, weekends]
          description: "daily=every day, weekly=one specific day of the week (requires dayOfWeek), weekdays=Mon-Fri, weekends=Sat-Sun"
        hour:
          type: integer
          description: "Hour in 24h format (0-23). For '8am' use 8, for '8pm' use 20."
        minute:
          type: integer
          description: "Minute (0-59)"
        dayOfWeek:
          type: integer
          description: "Day of week for type='weekly': 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday"
    labels:
      type: array
      items:
        type: string
      description: "Labels/tags (for add/update)"
    goal_id:
      type: string
      description: "Link to a goal (for add/update)"
    task_config:
      type: object
      description: "Sub-agent task config (for add with kind=task)"
      properties:
        goal:
          type: string
        tools:
          type: array
          items:
            type: string
    item_id:
      type: string
      description: "Item ID (for move/update/done/archive/detail/snooze)"
    status:
      type: string
      enum: [inbox, backlog, scheduled, in_progress, waiting, done, archived]
      description: "Target column (for move)"
    result:
      type: string
      description: "Completion note (for done)"
    time:
      type: string
      description: "New time for snooze, e.g. '1 hour', 'tomorrow 9am'"
  required: [action]
metadata:
  openclaw:
    emoji: "📋"
    requires:
      bins: []
---

# Board Skill

Unified kanban task board that replaces the reminder and progress skills.

## Columns
- **inbox**: Untriaged items (agent-created proactive triggers)
- **backlog**: Triaged, not yet scheduled
- **scheduled**: Has a trigger time, waiting to fire
- **in_progress**: Being worked on
- **waiting**: Blocked on something
- **done**: Completed
- **archived**: Dismissed/expired/old done

## Actions
- `view`: Show the board. Optional filters: column, priority, label
- `add`: Create a new item. Required: title. Optional: kind, trigger_time, priority, labels, goal_id, task_config, recurring
- `move`: Move item to a column. Required: item_id, status (target column)
- `update`: Edit an item. Required: item_id. Optional: title, priority, labels, trigger_time, kind
- `done`: Mark complete. Required: item_id. Optional: result (completion note)
- `archive`: Dismiss/archive an item. Required: item_id
- `detail`: Show full item detail with result. Required: item_id
- `snooze`: Reschedule trigger time. Required: item_id, time

## Priority Levels
urgent > high > medium (default) > low

## Item Kinds
- `nudge`: A message/reminder delivered to the user
- `task`: Sub-agent work that runs autonomously and stores results

## Recurring vs one-off

The system supports both. **Pick the right one:**

- **One-off**: use `trigger_time` — e.g. "remind me tomorrow at 9am" → `trigger_time: "tomorrow 9am"`. Fires once, then done.
- **Recurring**: use the `recurring` object — e.g. "remind me every day at 8am" → `recurring: {"type":"daily","hour":8,"minute":0}`. Automatically re-fires on each next occurrence forever until the user archives it.

If the user says any of these, they want **recurring** (never `trigger_time`):

| User says | Use |
|---|---|
| "every day at 8am" / "daily at 8am" | `recurring: {"type":"daily","hour":8,"minute":0}` |
| "every Monday at 9am" | `recurring: {"type":"weekly","hour":9,"minute":0,"dayOfWeek":1}` |
| "every weekday at 9am" / "weekdays at 9am" | `recurring: {"type":"weekdays","hour":9,"minute":0}` |
| "every weekend at 10am" / "weekends at 10am" | `recurring: {"type":"weekends","hour":10,"minute":0}` |

`dayOfWeek`: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.

`hour` is 24h: 8am=8, noon=12, 2pm=14, 8pm=20.

**Never** put "every day at 8am" as a string into `trigger_time` — use the `recurring` object.
