---
phase: 32-inner-thoughts-timing
plan: 02
subsystem: proactive
tags: [timing-model, quiet-hours, active-hours, pure-functions, vitest]

# Dependency graph
requires:
  - phase: 32-inner-thoughts-timing
    provides: inner thoughts evaluation module (32-01)
  - phase: 24-heartbeat-tier-enhancements
    provides: quiet hours concept (BackgroundGardener)
provides:
  - computeDeliveryTime pure function for optimal proactive message timing
  - isInQuietHours standalone quiet hours detection with wrap-around
  - TimingContext/DeliveryTiming types for proactive delivery infrastructure
affects: [32-03-feedback-loop, 32-04-wiring, 33-e2e-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [injectable-now pure functions for timing, strategy-priority-chain pattern]

key-files:
  created: [src/proactive/timing-model.ts, src/proactive/timing-model.test.ts]
  modified: []

key-decisions:
  - "Standalone isInQuietHours (not imported from BackgroundGardener) for testability"
  - "Strategy priority chain: urgent_now > next_morning > active_hours > next_active > fallback"
  - "High urgency bypasses minimum gap enforcement but still respects quiet hours"

patterns-established:
  - "Strategy priority chain: evaluate delivery strategies in fixed order, first match wins"
  - "computeHoursUntil helper for wrap-around midnight arithmetic"

issues-created: []

# Metrics
duration: 3 min
completed: 2026-02-10
---

# Phase 32 Plan 02: Timing Model Summary

**Pure-function timing model with 4-strategy priority chain (urgent_now/next_morning/active_hours/next_active), quiet hours wrap-around, 2h minimum gap enforcement, and 24h max deferral cap**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-10T19:20:29Z
- **Completed:** 2026-02-10T19:23:44Z
- **Tasks:** TDD cycle (RED + GREEN, no REFACTOR needed)
- **Files modified:** 2

## Accomplishments
- `isInQuietHours` pure function with wrap-around detection (start > end handles midnight crossing)
- `computeDeliveryTime` with 4-strategy priority chain replacing fixed 30-minute delay
- Minimum gap enforcement (2h between proactive messages, bypassed by high urgency)
- Maximum deferral cap (24h) prevents indefinite postponement
- Default active hours [9-21] when behavioral data unavailable
- All 14 tests covering edge cases (wrap-around, gap enforcement, deferral cap, urgency bypass)

## Task Commits

Each TDD phase was committed atomically:

1. **RED: Failing tests for timing model** - `2c29a8a` (test)
2. **GREEN: Implement timing model** - `24d250f` (feat)

No REFACTOR needed — implementation was clean on first pass.

## Files Created/Modified
- `src/proactive/timing-model.ts` - Pure functions: isInQuietHours, computeDeliveryTime with TimingContext/DeliveryTiming types
- `src/proactive/timing-model.test.ts` - 14 test cases covering all strategies, edge cases, and enforcement rules

## Decisions Made
- Standalone `isInQuietHours` reimplemented as pure function rather than importing from BackgroundGardener — better testability and no cross-module coupling
- Strategy priority chain evaluated in fixed order (urgent_now > next_morning > active_hours > next_active) — matches Microsoft CHI 2025 finding on session-boundary delivery
- High urgency bypasses minimum gap but NOT quiet hours — users should not be disturbed during sleep even for urgent proactive messages

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness
- Timing model ready for integration in 32-04 wiring plan
- `computeDeliveryTime` can replace fixed delay in gap scanner pipeline
- Types exported for use by scheduler.ts and inner-thoughts pipeline
- Ready for 32-03 (feedback loop & per-channel formatting)

---
*Phase: 32-inner-thoughts-timing*
*Completed: 2026-02-10*
