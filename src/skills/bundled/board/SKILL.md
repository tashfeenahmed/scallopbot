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
      description: "When to trigger, e.g. 'in 30 min', 'tomorrow 9am', 'at 3pm' (for add/update/snooze)"
    recurring:
      type: object
      description: "Recurring schedule (for add)"
      properties:
        type:
          type: string
          enum: [daily, weekly, weekdays, weekends]
        hour:
          type: integer
        minute:
          type: integer
        dayOfWeek:
          type: integer
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
