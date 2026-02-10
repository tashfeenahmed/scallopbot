---
phase: 31-gap-scanner
plan: 03
subsystem: memory
tags: [gap-actions, proactive, tdd, pure-functions, dedup, budget-cap]

# Dependency graph
requires:
  - phase: 31-gap-scanner/02
    provides: DiagnosedGap type and Stage 2 LLM triage
  - phase: 31-gap-scanner/01
    provides: GapSignal type for signal references
  - phase: 24-heartbeat-tier-enhancements
    provides: proactivenessDial pattern from trust-score.ts
provides:
  - GapAction interface and DIAL_THRESHOLDS constant
  - createGapActions pure function (Stage 3 proactiveness-gated filtering)
  - Local wordOverlap dedup utility
affects: [31-gap-scanner/04, 32-inner-thoughts]

# Tech tracking
tech-stack:
  added: []
  patterns: [proactiveness-dial gating, severity-rank comparison, word-overlap dedup, budget-cap + hard-cap enforcement]

key-files:
  created: [src/memory/gap-actions.ts, src/memory/gap-actions.test.ts]
  modified: []

key-decisions:
  - "Reimplemented wordOverlap locally to avoid coupling with goal-deadline-check.ts — same algorithm, 10-line utility"
  - "Used length > 2 word filter for dedup tokenization (stricter than goal-deadline-check.ts filter(Boolean))"
  - "effectiveCap = min(maxDailyNotifications, MAX_ACTIONS_PER_TICK) for combined budget + hard cap enforcement"
  - "userId set to signal.sourceId — caller maps to actual user ID at integration time"

patterns-established:
  - "DIAL_THRESHOLDS constant pattern: per-dial config objects with minSeverity, minConfidence, maxDailyNotifications, allowedTypes"
  - "Severity rank comparison: numeric mapping {low:0, medium:1, high:2} for threshold filtering"

issues-created: []

# Metrics
duration: 4min
completed: 2026-02-10
---

# Phase 31 Plan 03: Proactiveness-Gated Gap Actions Summary

**Pure createGapActions function with DIAL_THRESHOLDS gating, severity/confidence/type filtering, word-overlap dedup, and budget + hard cap enforcement**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-10T16:43:03Z
- **Completed:** 2026-02-10T16:47:24Z
- **Tasks:** 3 (RED + GREEN + REFACTOR)
- **Files modified:** 2

## Accomplishments
- Implemented createGapActions pure function with 7-stage filtering pipeline (actionable → confidence → type → severity → dedup → budget → hard cap)
- DIAL_THRESHOLDS constant with conservative/moderate/eager configs matching research spec exactly
- Local wordOverlap dedup utility (same algorithm as goal-deadline-check.ts, avoids cross-module coupling)
- 23 tests covering all filter stages, dedup, budget caps, output shape, and edge cases
- Full TDD cycle: RED (23 failing) → GREEN (23 passing) → REFACTOR (removed unused import)

## Task Commits

Each TDD phase was committed atomically:

1. **RED: Failing tests** - `c4860d3` (test)
2. **GREEN: Implementation** - `267d927` (feat)
3. **REFACTOR: Remove unused import** - `885a50f` (refactor)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified
- `src/memory/gap-actions.ts` - GapAction/DialConfig types, DIAL_THRESHOLDS, createGapActions, local wordOverlap/isDuplicate/severityRank helpers, MAX_ACTIONS_PER_TICK constant
- `src/memory/gap-actions.test.ts` - 23 tests: DIAL_THRESHOLDS (3), filtering (6), dedup (2), budget+cap (3), output shape (3), edge cases (5), plus helpers

## Decisions Made
- Reimplemented wordOverlap locally rather than importing from goal-deadline-check.ts — avoids cross-module coupling for a 10-line utility
- Used `length > 2` word filter for dedup tokenization (stricter filtering of noise words)
- Combined budget + hard cap via `effectiveCap = min(maxDailyNotifications, MAX_ACTIONS_PER_TICK)` — single check at loop top
- userId mapped from signal.sourceId — actual user ID mapping deferred to integration layer (31-04)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused GapSignal import**
- **Found during:** REFACTOR phase
- **Issue:** Plan specified importing GapSignal from gap-scanner.ts, but createGapActions only uses DiagnosedGap (which already contains signal: GapSignal)
- **Fix:** Removed unused import in refactor phase
- **Files modified:** src/memory/gap-actions.ts
- **Verification:** tsc --noEmit passes, all tests pass
- **Committed in:** 885a50f

---

**Total deviations:** 1 auto-fixed (unused import removal)
**Impact on plan:** Trivial cleanup, no scope change.

## Issues Encountered

None

## Next Phase Readiness
- GapAction[] output ready for Stage 4 wiring into sleepTick in 31-04
- createGapActions is pure — caller provides existingItems and handles db.addScheduledItem insertion
- DIAL_THRESHOLDS exported for use by integration layer

---
*Phase: 31-gap-scanner*
*Completed: 2026-02-10*
