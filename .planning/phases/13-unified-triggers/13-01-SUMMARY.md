---
phase: 13-unified-triggers
plan: 01
subsystem: gateway
tags: [triggers, websocket, multi-channel, abstraction]

# Dependency graph
requires:
  - phase: 11-web-ui
    provides: ApiChannel with WebSocket support
  - phase: 12-loop-until-done
    provides: Agent loop-until-done behavior
provides:
  - TriggerSource interface for unified message/file sending
  - Multi-channel trigger dispatch in Gateway
  - ApiChannel as TriggerSource for WebSocket clients
  - parseUserIdPrefix utility for channel-prefixed user IDs
affects: [reminders, scheduled-tasks, proactive-messaging]

# Tech tracking
tech-stack:
  added: []
  patterns: [trigger-source-abstraction, channel-prefixed-userids]

key-files:
  created:
    - src/triggers/types.ts
    - src/triggers/index.ts
  modified:
    - src/gateway/gateway.ts
    - src/channels/api.ts

key-decisions:
  - "TriggerSource uses simple sendMessage/sendFile/getName interface"
  - "Channel prefixes (telegram:, api:) in userId enable explicit routing"
  - "Fallback to first available trigger source maintains backward compat"
  - "TelegramChannel wrapped in adapter pattern (doesn't modify original)"
  - "ApiChannel directly implements TriggerSource interface"
  - "WebSocket clients tracked by ws-{clientId} userId pattern"

patterns-established:
  - "TriggerSource pattern: interface with sendMessage, sendFile, getName"
  - "Channel prefix pattern: channel:userId for explicit routing"
  - "Type guard pattern for optional interface detection"

issues-created: []

# Metrics
duration: 12min
completed: 2026-02-04
---

# Phase 13-01: Unified Triggers Summary

**TriggerSource interface decouples reminder/notification routing from specific channels, enabling multi-channel dispatch to Telegram and WebSocket clients**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-04T12:15:00Z
- **Completed:** 2026-02-04T12:27:27Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Created TriggerSource abstraction with sendMessage/sendFile/getName interface
- Gateway now maintains registry of trigger sources for multi-channel dispatch
- ApiChannel implements TriggerSource, can broadcast to WebSocket clients by userId
- Reminder triggers, file sends, and message sends route through abstraction
- Backward compatible: Telegram-only setups work unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Create TriggerSource abstraction and multi-channel dispatch** - `f3ae958` (feat)
2. **Task 2: Add message broadcast to ApiChannel for trigger support** - `d934cbd` (feat)

**Plan metadata:** `205bb4a` (docs: complete plan)

## Files Created/Modified
- `src/triggers/types.ts` - TriggerSource interface and parseUserIdPrefix utility
- `src/triggers/index.ts` - Module exports
- `src/gateway/gateway.ts` - TriggerSourceRegistry, resolveTriggerSource, refactored handlers
- `src/channels/api.ts` - TriggerSource implementation with WebSocket client tracking

## Decisions Made
- TriggerSource interface kept minimal (3 methods) for easy implementation
- TelegramChannel wrapped via adapter (no modification to original class)
- ApiChannel directly implements interface (natural fit with WebSocket)
- Channel-prefixed userIds (telegram:12345, api:ws-abc) enable explicit routing
- Type guard used to detect TriggerSource capability in ApiChannel

## Deviations from Plan

None - plan executed exactly as written

## Issues Encountered
None

## Next Phase Readiness
- Trigger abstraction ready for additional channels (e.g., Discord, Slack)
- Web UI can receive proactive notifications via WebSocket
- Reminder system can target specific channels via userId prefix

---
*Phase: 13-unified-triggers*
*Completed: 2026-02-04*
