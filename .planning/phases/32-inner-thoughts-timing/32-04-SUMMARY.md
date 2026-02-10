---
phase: 32-inner-thoughts-timing
plan: 04
subsystem: proactive
tags: [inner-thoughts, timing-model, deepTick, sleepTick, scheduler, per-channel-formatting, feedback-loop, engagement-detection]

# Dependency graph
requires:
  - phase: 32-inner-thoughts-timing/01
    provides: evaluateInnerThoughts, shouldRunInnerThoughts, InnerThoughtsInput/InnerThoughtsResult types
  - phase: 32-inner-thoughts-timing/02
    provides: computeDeliveryTime, isInQuietHours, TimingContext/DeliveryTiming types
  - phase: 32-inner-thoughts-timing/03
    provides: detectProactiveEngagement, formatProactiveMessage, markScheduledItemActed DB method
  - phase: 31-gap-scanner/04
    provides: Gap scanner pipeline in sleepTick with per-user error isolation
provides:
  - Inner thoughts evaluation wired into BackgroundGardener.deepTick
  - computeDeliveryTime replaces fixed 30-min delay in gap scanner (sleepTick)
  - Per-channel proactive formatting in UnifiedScheduler.sendFormattedMessage
  - checkEngagement method on UnifiedScheduler for trust feedback loop
  - 'proactive' WsResponse type in ApiChannel
  - Structured proactive JSON parsing in ApiChannel.sendMessage
  - Inner thoughts types/functions exported from memory/index.ts
  - 5 integration tests verifying pipeline wiring
affects: [33-e2e-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-user-inner-thoughts-in-deepTick, timing-model-replacement-of-fixed-delay, per-channel-send-formatting, engagement-check-on-user-message]

key-files:
  created: [src/memory/inner-thoughts-integration.test.ts]
  modified: [src/memory/memory.ts, src/memory/index.ts, src/proactive/scheduler.ts, src/channels/api.ts]

key-decisions:
  - "Inner thoughts runs in deepTick (6h cycle) after session summarization, not sleepTick"
  - "Gap scanner timing uses computeDeliveryTime with severity-to-urgency mapping"
  - "checkEngagement is a public method on UnifiedScheduler (called by gateway/agent, not evaluated internally)"
  - "ApiChannel.sendMessage parses JSON to detect structured proactive messages"
  - "Per-channel formatting only applies to agent-sourced items (user reminders unchanged)"

patterns-established:
  - "deepTick inner thoughts: per-user iteration with 6h recency filter on session summaries"
  - "Severity-to-urgency mapping for gap scanner timing: high->high, medium->medium, default->low"
  - "Structured proactive JSON parsing in WebSocket sendMessage"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 32 Plan 04: Wire Inner Thoughts & Timing into Pipeline Summary

**Inner thoughts wired into deepTick with timing-model delivery, per-channel proactive formatting in scheduler, engagement detection closing trust feedback loop, and 5 integration tests verifying end-to-end pipeline**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T19:35:07Z
- **Completed:** 2026-02-10T19:43:00Z
- **Tasks:** 3 completed
- **Files modified:** 5 (4 modified + 1 created)

## Accomplishments
- Inner thoughts evaluation runs in deepTick for users with recent session summaries (within 6h), creates scheduled items with timing model delivery
- Gap scanner in sleepTick now uses computeDeliveryTime instead of fixed 30-min delay, with severity-to-urgency mapping
- UnifiedScheduler.sendFormattedMessage applies per-channel proactive formatting (Telegram icon+footer, WebSocket structured JSON) for agent-sourced items
- checkEngagement method on UnifiedScheduler detects user engagement and marks fired items as 'acted' via detectProactiveEngagement
- WsResponse type includes 'proactive' with category/urgency/source fields; ApiChannel.sendMessage parses structured proactive JSON
- 5 integration tests verify: skip without summaries, proact creates item, distress suppression, timing model in gap scanner, engagement detection

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire inner thoughts into deepTick and update gap scanner timing** - `ef3a59c` (feat)
2. **Task 2: Wire timing, formatting, and feedback into UnifiedScheduler** - `735ca69` (feat)
3. **Task 3: Integration test and export wiring** - `9b54366` (test)

## Files Created/Modified
- `src/memory/memory.ts` - Inner thoughts evaluation in deepTick (step 7), computeDeliveryTime in sleepTick gap scanner
- `src/memory/index.ts` - Exports for inner thoughts types/functions (evaluateInnerThoughts, shouldRunInnerThoughts, etc.)
- `src/proactive/scheduler.ts` - Per-channel formatting in sendFormattedMessage, checkEngagement public method
- `src/channels/api.ts` - 'proactive' WsResponse type with category/urgency/source fields, structured JSON parsing in sendMessage
- `src/memory/inner-thoughts-integration.test.ts` - 5 integration tests for pipeline wiring

## Decisions Made
- Inner thoughts runs in deepTick after all other steps (step 7), using recent session summaries (6h window) as the session boundary signal, not a custom timer
- Gap scanner severity mapped to timing urgency: high->high, medium->medium, default->low. This allows the timing model to prioritize urgent gap signals
- checkEngagement is a public method rather than an internal evaluate() hook, because the scheduler doesn't know when users send messages. The gateway/agent calls it
- ApiChannel.sendMessage uses try/catch JSON.parse to detect structured proactive messages, falling back to plain trigger type for non-JSON strings
- Per-channel formatting only applies to agent-sourced items; user-sourced reminders are sent unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Auto-fix bug] Fixed integration test for engagement detection item setup**
- **Found during:** Task 3 (Integration tests)
- **Issue:** Test created item with `status: 'fired'` via addScheduledItem, but `markScheduledItemFired` only updates items with status 'pending'/'processing', leaving firedAt as null
- **Fix:** Create item as 'pending' (default), then call markScheduledItemFired to properly transition status and set firedAt
- **Files modified:** src/memory/inner-thoughts-integration.test.ts
- **Verification:** All 5 integration tests pass
- **Committed in:** 9b54366 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (test setup bug), 0 deferred
**Impact on plan:** Auto-fix necessary for correct test behavior. No scope creep.

## Issues Encountered
- 2 pre-existing test failures in src/memory/scallop.test.ts (memory fusion deep tick scenario) — confirmed these failures exist on the main branch before this plan's changes. Not caused by 32-04.

## Next Phase Readiness
- Phase 32 (Inner Thoughts & Timing) is complete: all 4 plans executed
- All Phase 32 features are live: inner thoughts in deepTick, timing model replacing fixed delays, per-channel formatting, engagement detection feedback loop
- Ready for Phase 33 (E2E Cognitive Testing)

---
*Phase: 32-inner-thoughts-timing*
*Completed: 2026-02-10*
