---
phase: 29-enhanced-forgetting
plan: 01
subsystem: memory
tags: [utility-score, forgetting, decay, pure-function, vitest, tdd]

# Dependency graph
requires:
  - phase: 24-heartbeat-tier-enhancements
    provides: retrieval audit with access_count tracking
provides:
  - computeUtilityScore pure function
  - findLowUtilityMemories DB query function
  - LowUtilityMemory and FindLowUtilityOptions interfaces
affects: [29-02-wiring, enhanced-forgetting-pruning]

# Tech tracking
tech-stack:
  added: []
  patterns: [utility-score-as-separate-concern-from-prominence]

key-files:
  created: [src/memory/utility-score.ts, src/memory/utility-score.test.ts]
  modified: []

key-decisions:
  - "Natural log (Math.log) per information-theoretic convention"
  - "Utility score is separate from prominence — prominence drives decay, utility drives deletion"
  - "Always exclude static_profile from forgetting candidates"

patterns-established:
  - "Utility score pattern: prominence × ln(1 + accessCount) for deletion decisions"

issues-created: []

# Metrics
duration: 2min
completed: 2026-02-10
---

# Phase 29 Plan 01: Utility Score Computation Summary

**Pure-function utility score `prominence × ln(1 + accessCount)` with DB query for low-utility memory candidates, 20 tests TDD**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-10T14:58:12Z
- **Completed:** 2026-02-10T15:00:17Z
- **Tasks:** 1 feature (TDD: RED → GREEN)
- **Files modified:** 2

## Accomplishments
- `computeUtilityScore()` pure function implementing Hu et al. formula
- `findLowUtilityMemories()` DB query with configurable threshold, age gate, type exclusion, and result limiting
- 20 comprehensive test cases covering edge cases, sorting, filtering, and content truncation
- All 478 memory tests pass (458 existing + 20 new)

## Task Commits

TDD cycle commits:

1. **RED: Failing tests** - `e3ff17a` (test)
2. **GREEN: Implementation** - `df5ca8d` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/memory/utility-score.ts` - Pure functions: computeUtilityScore, findLowUtilityMemories
- `src/memory/utility-score.test.ts` - 20 tests covering all edge cases

## Decisions Made
- Used natural log (Math.log) per standard information-theoretic usage
- Utility score is SEPARATE from prominence — does not modify decay.ts
- Always exclude static_profile memories from forgetting candidates
- Content truncated to 80 chars in results for logging purposes

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## Next Phase Readiness
- Ready for 29-02-PLAN.md (wire utility scoring into forgetting pipeline)
- computeUtilityScore and findLowUtilityMemories exported and tested

---
*Phase: 29-enhanced-forgetting*
*Completed: 2026-02-10*
