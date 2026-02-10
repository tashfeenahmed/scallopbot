---
phase: 24-heartbeat-tier-enhancements
plan: 03
subsystem: memory
tags: [goal-tracking, deadline-check, pure-function, deduplication]

requires:
  - phase: 24-heartbeat-tier-enhancements
    provides: health ping and retrieval audit infrastructure
provides:
  - goal deadline checking pure function
  - notification deduplication via word overlap
affects: [heartbeat-integration, gap-scanner, proactive-intelligence]

tech-stack:
  added: []
  patterns: [pure-function-with-word-overlap-dedup]

key-files:
  created: [src/memory/goal-deadline-check.ts, src/memory/goal-deadline-check.test.ts]
  modified: []

key-decisions:
  - "Word overlap dedup reimplemented as pure function (no db.ts dependency)"

patterns-established:
  - "Word overlap deduplication: |intersection| / |smaller set| >= 0.8 threshold"

issues-created: []

duration: 5min
completed: 2026-02-10
---

# Phase 24 Plan 03: Goal Deadline Check Summary

**Implemented pure-function goal deadline checking with urgency mapping, notification generation, and word-overlap deduplication via full RED-GREEN TDD cycle.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-10T11:47:00Z
- **Completed:** 2026-02-10T11:52:00Z
- **Tasks:** 1 (TDD feature)
- **Files created:** 2

## Accomplishments

- Created `checkGoalDeadlines(goals, existingReminders, options?)` pure function returning `GoalDeadlineResult`
- Urgency mapping: overdue (daysRemaining < 0), urgent (daysRemaining <= 2), warning (daysRemaining <= warningWindowDays)
- Notification message generation with two formats: "due in {days} days" and "overdue by {days} days"
- Word overlap deduplication: splits messages into word sets, computes |intersection| / |smaller set|, deduplicates at >= 0.8 threshold
- Configurable warning window (default 7 days) and injectable `now` for deterministic testing
- 19 tests covering empty input, urgency mapping at all boundaries, outside-window filtering, deduplication, multiple goals, and notification message formatting
- All 1132 project tests pass with 0 regressions

## Task Commits

1. **RED: Failing tests** - `5a91e50` (test)
2. **GREEN: Implementation** - `0350a38` (feat)

## Files Created/Modified

- `src/memory/goal-deadline-check.ts` -- Pure function module with checkGoalDeadlines, urgency mapping, notification formatting, and word overlap deduplication
- `src/memory/goal-deadline-check.test.ts` -- 19 tests covering all behavior cases from the plan specification

## Decisions Made

1. **Word overlap as pure function:** Reimplemented word overlap logic (mirroring hasSimilarPendingScheduledItem) as a standalone pure function to avoid importing db.ts and its database dependencies.
2. **Math.floor for daysRemaining:** Uses floor division to compute whole days remaining, ensuring boundary conditions are clean (e.g., exactly 2 days = urgent, exactly 7 days = warning).
3. **Overdue goals always included:** Goals with daysRemaining < 0 are never filtered out regardless of warningWindowDays, ensuring overdue goals are always surfaced.
4. **totalChecked counts all input goals:** Includes goals without dueDates in totalChecked for accurate audit trail of how many goals were examined.

## Deviations from Plan

- No refactor commit needed; implementation was clean from the GREEN phase (2 commits instead of 3).

## Issues Encountered

None.

## Next Phase Readiness

- Goal deadline checking is available for Phase 31 (Gap Scanner) Stage 1 search queries
- Notification deduplication prevents spam when heartbeat runs repeatedly
- The pure function pattern allows easy integration into BackgroundGardener ticks without database coupling
- ApproachingGoal and GoalNotification types are exported for downstream consumers

---
*Phase: 24-heartbeat-tier-enhancements*
*Completed: 2026-02-10*
