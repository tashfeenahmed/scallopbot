---
name: goals
description: Create, list, update, and complete goals, milestones, and tasks with hierarchical tracking
user-invocable: true
triggers: [goal, goals, milestone, task, objective, target, kanban, tracking]
scripts:
  run: "scripts/run.ts"
inputSchema:
  type: object
  properties:
    action:
      type: string
      enum: [create, list, show, activate, complete, reopen, update, delete]
      description: "Action to perform on goals"
    type:
      type: string
      enum: [goal, milestone, task]
      description: "Item type (for create/list)"
    title:
      type: string
      description: "Title/description (for create/update)"
    parent_id:
      type: string
      description: "Parent ID (goal for milestone, milestone for task)"
    id:
      type: string
      description: "Item ID (for show/activate/complete/reopen/update/delete)"
    status:
      type: string
      enum: [backlog, active, completed]
      description: "Filter by status (for list) or set status (for update)"
    due:
      type: string
      description: "Due date (e.g., 'next week', '2024-03-15', 'in 30 days')"
    checkin:
      type: string
      enum: [daily, weekly, biweekly, monthly, none]
      description: "Proactive check-in frequency (for goals)"
    tags:
      type: array
      items:
        type: string
      description: "Tags for organization"
  required: [action]
metadata:
  openclaw:
    emoji: "🎯"
    requires:
      bins: []
---

# Goals Skill

Manage hierarchical goals with a simple kanban workflow (backlog -> active -> completed).

## Structure

Goals are organized hierarchically:
- **Goals** - High-level objectives (e.g., "Learn Spanish")
- **Milestones** - Major checkpoints within a goal (e.g., "Complete Duolingo basics")
- **Tasks** - Specific action items within a milestone (e.g., "Finish lesson 5")

## When to Use

Use the goals skill for:

- **Creating goals**: "I want to learn Python this year"
- **Breaking down goals**: Add milestones and tasks to goals
- **Tracking progress**: View current status and progress percentages
- **Status updates**: Mark items as active or completed
- **Proactive check-ins**: Set up periodic reminders for goal progress

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

### Create a goal

```json
{
  "action": "create",
  "type": "goal",
  "title": "Learn Spanish",
  "checkin": "weekly",
  "due": "2024-12-31"
}
```

### Create a milestone

```json
{
  "action": "create",
  "type": "milestone",
  "title": "Complete Duolingo basics",
  "parent_id": "goal_abc123"
}
```

### Create a task

```json
{
  "action": "create",
  "type": "task",
  "title": "Finish lessons 1-5",
  "parent_id": "milestone_def456"
}
```

### List goals

```json
{
  "action": "list",
  "type": "goal",
  "status": "active"
}
```

### Show goal hierarchy

```json
{
  "action": "show",
  "id": "goal_abc123"
}
```

### Complete an item

```json
{
  "action": "complete",
  "id": "task_xyz789"
}
```

### Activate an item

```json
{
  "action": "activate",
  "id": "goal_abc123"
}
```

### Reopen a completed item

```json
{
  "action": "reopen",
  "id": "task_xyz789"
}
```

### Update an item

```json
{
  "action": "update",
  "id": "goal_abc123",
  "title": "Master Spanish",
  "due": "2025-06-30"
}
```

### Delete an item

```json
{
  "action": "delete",
  "id": "goal_abc123"
}
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of: create, list, show, activate, complete, reopen, update, delete |
| `type` | string | For create/list | Item type: goal, milestone, or task |
| `title` | string | For create | Title/description of the item |
| `parent_id` | string | For milestone/task | Parent ID (goal for milestone, milestone for task) |
| `id` | string | For show/activate/complete/reopen/update/delete | Item ID |
| `status` | string | For list/update | Filter or set: backlog, active, completed |
| `due` | string | Optional | Due date (parsed naturally) |
| `checkin` | string | For goals | Check-in frequency: daily, weekly, biweekly, monthly, none |
| `tags` | array | Optional | Tags for organization |

## Output Format

```json
{
  "success": true,
  "output": "Goal created: Learn Spanish (ID: abc123)",
  "exitCode": 0
}
```

## Examples

### Set up a learning goal

1. Create the main goal:
```json
{"action": "create", "type": "goal", "title": "Learn Spanish", "checkin": "weekly"}
```

2. Add milestones:
```json
{"action": "create", "type": "milestone", "title": "Complete Duolingo basics", "parent_id": "abc123"}
```

3. Add tasks:
```json
{"action": "create", "type": "task", "title": "Finish lesson 5", "parent_id": "def456"}
```

4. Activate the goal:
```json
{"action": "activate", "id": "abc123"}
```

5. Complete tasks as you progress:
```json
{"action": "complete", "id": "task789"}
```

6. View progress:
```json
{"action": "show", "id": "abc123"}
```
