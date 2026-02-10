---
phase: 32-inner-thoughts-timing
plan: 03
subsystem: proactive
tags: [feedback-loop, engagement-detection, telegram, websocket, per-channel-formatting, pure-functions]

# Dependency graph
requires:
  - phase: 32-inner-thoughts-timing
    provides: inner thoughts module (32-01), timing model (32-02)
  - phase: 31-gap-scanner
    provides: gap signal types (gapType for formatting icons)
provides:
  - markScheduledItemActed DB method for trust score feedback
  - detectProactiveEngagement pure function for engagement detection
  - Per-channel proactive message formatters (Telegram text, WebSocket JSON)
  - ProactiveFormatInput/ProactiveWebSocketOutput types
affects: [32-04-wire-pipeline, 33-e2e-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-function-filter-map, channel-decoupled-formatting, icon-lookup-with-fallback]

key-files:
  created: [src/proactive/feedback.ts, src/proactive/feedback.test.ts, src/proactive/proactive-format.ts, src/proactive/proactive-format.test.ts]
  modified: [src/memory/db.ts, src/proactive/index.ts]

key-decisions:
  - "15-minute engagement window (conservative — err on side of leaving as 'fired')"
  - "Text-based Telegram format (not inline buttons — too complex for now)"
  - "Decoupled from channels/ — formatters don't import channel implementations"

patterns-established:
  - "Filter-map pattern for pure engagement detection"
  - "Channel-decoupled formatting with router function"

issues-created: []

# Metrics
duration: 4 min
completed: 2026-02-10
---

# Phase 32 Plan 03: Feedback Loop & Per-Channel Formatting Summary

**Pure-function feedback loop with 15-min engagement window, 'acted' DB status, and per-channel proactive formatters (Telegram icon+truncate+footer, WebSocket structured JSON)**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-10T19:28:45Z
- **Completed:** 2026-02-10T19:32:48Z
- **Tasks:** TDD cycle (RED + GREEN, no REFACTOR needed)
- **Files modified:** 6

## Accomplishments
- Added `markScheduledItemActed` DB method following existing dismissed pattern, with 'acted' status in ScheduledItemStatus union
- Created `detectProactiveEngagement` pure function — filters fired agent items within 15-min window, returns IDs to mark as acted
- Created `formatProactiveForTelegram` — icon prefix (5 gap types), 250-char truncation, dismiss footer
- Created `formatProactiveForWebSocket` — structured { type, content, category, urgency, source } object
- Created `formatProactiveMessage` channel router for telegram/api dispatch
- All 17 test cases passing across feedback and formatting modules

## Task Commits

Each TDD phase was committed atomically:

1. **RED: Failing tests for feedback loop and formatting** - `85e15a6` (test)
2. **GREEN: Implement feedback loop and per-channel formatting** - `69c80db` (feat)

No REFACTOR needed — implementation was clean on first pass.

## Files Created/Modified
- `src/proactive/feedback.ts` — Pure detectProactiveEngagement function with 15-min default window
- `src/proactive/feedback.test.ts` — 8 test cases covering all filter conditions and injectable parameters
- `src/proactive/proactive-format.ts` — Three formatters: Telegram, WebSocket, and channel router
- `src/proactive/proactive-format.test.ts` — 9 test cases covering icons, truncation, routing
- `src/memory/db.ts` — Added 'acted' to ScheduledItemStatus, markScheduledItemActed method
- `src/proactive/index.ts` — Added exports for timing-model, feedback, and proactive-format modules

## Decisions Made
- 15-minute engagement window (conservative per RESEARCH.md — better to leave as 'fired' than false-positive 'acted')
- Text-based Telegram format without inline buttons (complexity deferred per RESEARCH.md)
- Formatters decoupled from channels/ — no imports from channel implementations to avoid circular dependencies
- ProactiveWebSocketOutput as explicit type rather than extending WsResponse (wiring deferred to 32-04)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness
- Feedback loop ready for wiring into agent.processMessage (32-04)
- Per-channel formatters ready for scheduler delivery integration (32-04)
- markScheduledItemActed already consumed by trust-score.ts proactiveAcceptRate
- All proactive module exports complete for pipeline wiring

---
*Phase: 32-inner-thoughts-timing*
*Completed: 2026-02-10*
