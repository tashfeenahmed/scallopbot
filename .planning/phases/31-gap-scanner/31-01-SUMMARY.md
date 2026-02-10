---
phase: 31-gap-scanner
plan: 01
subsystem: memory
tags: [gap-scanner, heuristics, proactive, pure-functions]

requires:
  - phase: 24-heartbeat-tier-enhancements
    provides: goal deadline check pattern, behavioral signals
provides:
  - Gap signal heuristics (scanStaleGoals, scanBehavioralAnomalies, scanUnresolvedThreads)
  - GapSignal/GapScanInput type definitions
  - scanForGaps orchestrator
affects: [31-02-llm-gap-diagnosis, 31-04-wire-gap-scanner]

tech-stack:
  added: [none - pure functions using existing types]
  patterns: [injectable now for deterministic testing, pure heuristic scanners]

key-files:
  created: [src/memory/gap-scanner.ts, src/memory/gap-scanner.test.ts]
  modified: []

key-decisions:
  - "Only scan active goals (skip backlog/completed) for staleness detection"
  - "Overdue goal produces high severity and preempts weaker stale/check-in signals for same goal"
  - "Check-in missed signal uses ratio > 3.0 (not >=) for buffer against borderline cases"
  - "Follow-up window for unresolved threads is exclusive (< 48h, not <=) to avoid boundary false negatives"
  - "Cold start guard: skip all behavioral anomaly checks when messageFrequency is null"
  - "responseLength.trend === 'decreasing' treated as sufficient for declining response signal (per spec note)"

patterns-established:
  - "GapSignal interface as standard output for gap detection pipeline"
  - "Sub-scanner + orchestrator pattern: individual pure functions composed by scanForGaps"
  - "Injectable now parameter with Date.now() default for deterministic testing"

issues-created: []

duration: 6min
completed: 2026-02-10
---

# Phase 31 Plan 01: Gap Signal Heuristics Summary

**Pure heuristic scanners that detect stale goals, behavioral anomalies, and unresolved threads without LLM calls.**

## Performance
- **Duration:** 6 min
- **Started:** 2026-02-10T16:24:00Z
- **Completed:** 2026-02-10T16:30:00Z
- **Tasks:** 1 (TDD feature)
- **Files modified:** 2

## Accomplishments
- Implemented 3 sub-scanners (scanStaleGoals, scanBehavioralAnomalies, scanUnresolvedThreads) and 1 orchestrator (scanForGaps)
- 37 tests covering all documented behaviors including edge cases, cold start, boundary conditions
- Full TDD cycle: RED (18 failing) -> GREEN (37 passing) -> REFACTOR (import consolidation, loop cleanup)
- Defined GapSignal and GapScanInput interfaces as standard types for the gap detection pipeline
- Zero LLM dependencies -- all heuristics are pure computation

## Task Commits
1. **RED: Failing tests** - `04caa5b` (test)
2. **GREEN: Implementation** - `e86c936` (feat)
3. **REFACTOR: Cleanup** - `d18de75` (refactor)

## Files Created/Modified
- `src/memory/gap-scanner.ts` - Gap signal heuristic functions with GapSignal/GapScanInput types, 3 sub-scanners, 1 orchestrator
- `src/memory/gap-scanner.test.ts` - 37 tests covering stale goals (12), behavioral anomalies (9), unresolved threads (8), orchestrator (4), plus helpers

## Decisions Made
- Only active goals are scanned (backlog/completed skipped) to avoid noise
- Overdue detection takes priority over stale/check-in signals for the same goal (continue after push)
- Follow-up window uses strict less-than (< 48h) to prevent boundary false negatives
- Cold start is safe: null messageFrequency returns empty anomalies array

## Deviations from Plan
- None. Implementation matches specification exactly.

## Issues Encountered
- Initial follow-up window boundary check used <= causing a false negative in the mixed-resolution test case. Fixed by switching to strict < comparison.

## Next Phase Readiness
- Gap signal heuristics ready for Stage 2 LLM triage in 31-02
- GapSignal[] output can be directly consumed by LLM diagnosis functions

---
*Phase: 31-gap-scanner*
*Completed: 2026-02-10*
