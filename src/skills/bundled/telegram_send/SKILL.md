---
name: telegram_send
description: Send a message to a Telegram user or chat
user-invocable: true
triggers: [telegram, send message, message user, notify, send telegram]
scripts:
  run: "scripts/run.ts"
metadata:
  openclaw:
    emoji: "\U0001F4E8"
    requires:
      bins: []
---

# Telegram Send Skill

Send messages to Telegram users or chats. Uses the bot's active Telegram connection to deliver messages with markdown formatting support.

## When to Use

Use this skill when you need to:

- **Send notifications**: Alert users about completed tasks or important updates
- **Respond to users**: Send messages to specific chat IDs
- **Proactive messaging**: Deliver scheduled reminders or status updates

## Input Format

The skill accepts JSON arguments via the `SKILL_ARGS` environment variable:

```json
{
  "chat_id": "123456789",
  "message": "Hello! This is a test message."
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chat_id` | string \| number | Yes | Telegram chat ID or user ID to send to |
| `message` | string | Yes | Message text to send (markdown supported) |

## Output Format

The skill returns JSON to stdout:

```json
{
  "success": true,
  "output": "Message sent to 123456789",
  "exitCode": 0
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | True if message sent successfully |
| `output` | string | Confirmation message |
| `error` | string | Error message if operation failed |
| `exitCode` | number | Process exit code (0 = success) |

## Examples

### Send a simple message

```json
{
  "chat_id": "123456789",
  "message": "Task completed successfully!"
}
```

### Send a formatted message

```json
{
  "chat_id": "123456789",
  "message": "**Status Update**\n\nYour file has been processed.\n- Records: 1,250\n- Errors: 0"
}
```

## Prerequisites

- Telegram bot must be running (via Gateway)
- The chat_id must be a valid Telegram user or group chat ID
- The bot must have permission to send messages to the target chat
