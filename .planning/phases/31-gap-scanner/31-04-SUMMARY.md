---
phase: 31-gap-scanner
plan: 04
subsystem: memory
tags: [gap-scanner, sleepTick, integration, pipeline-wiring, scheduled-items]

# Dependency graph
requires:
  - phase: 31-gap-scanner/01
    provides: scanForGaps, GapSignal, GapScanInput (Stage 1 heuristics)
  - phase: 31-gap-scanner/02
    provides: diagnoseGaps, DiagnosedGap, UserContext (Stage 2 LLM triage)
  - phase: 31-gap-scanner/03
    provides: createGapActions, GapAction, DIAL_THRESHOLDS (Stage 3 gated actions)
  - phase: 30-self-reflection/02
    provides: Reflection integration pattern in sleepTick
  - phase: 24-heartbeat-tier-enhancements
    provides: proactivenessDial in behavioral patterns, dynamic GoalService import pattern
provides:
  - Gap scanner pipeline wired into BackgroundGardener.sleepTick
  - Full gap-scanner module exports from memory/index.ts
  - Integration test suite for gap scanner in sleepTick (5 tests)
affects: [32-inner-thoughts]

# Tech tracking
tech-stack:
  added: []
  patterns: [3-stage pipeline wiring, null-safe behavioral patterns stub, per-user error isolation with nested try/catch]

key-files:
  created: [src/memory/gardener-gap-scanner.test.ts]
  modified: [src/memory/memory.ts, src/memory/index.ts]

key-decisions:
  - "Null-safe behavioral patterns: provide minimal stub when getBehavioralPatterns returns null so stale-goal and unresolved-thread scanners still run on cold start"
  - "Added missing sessionId, recurring fields to addScheduledItem call to satisfy TypeScript strict types"
  - "Removed unused type imports (GapSignal, UserContext) from memory.ts to keep imports clean"

patterns-established:
  - "Gap scanner phase placement: runs after self-reflection, before 'Sleep tick complete' log"
  - "Independent user query: gap scanner queries users from memories table independently rather than sharing variable with dream cycle"

issues-created: []

# Metrics
duration: 12min
completed: 2026-02-10
---

# Phase 31 Plan 04: Wire Gap Scanner into sleepTick Summary

**3-stage gap scanner pipeline (signal heuristics, LLM diagnosis, proactiveness-gated actions) wired into BackgroundGardener.sleepTick with per-user error isolation and 5 integration tests**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-10T17:30:00Z
- **Completed:** 2026-02-10T17:42:00Z
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments
- Wired complete 3-stage gap scanner pipeline into sleepTick: scan signals, LLM diagnosis, gated action creation, scheduled item insertion
- Added null-safe behavioral patterns handling for cold start scenarios
- Exported all gap scanner modules (gap-scanner, gap-diagnosis, gap-actions) from memory/index.ts
- Created 5 integration tests verifying: scheduled item creation, no-provider skip, no-signals skip, error isolation, and proactiveness dial gating

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire gap scanner pipeline into sleepTick** - `c148c18` (feat)
2. **Task 2: Add integration tests for gap scanner in sleepTick** - `ca9295a` (test)

## Files Created/Modified
- `src/memory/memory.ts` - Added gap scanner imports and 3-stage pipeline phase in sleepTick after self-reflection
- `src/memory/index.ts` - Added exports for gap-scanner, gap-diagnosis, and gap-actions modules
- `src/memory/gardener-gap-scanner.test.ts` - 5 integration tests for gap scanner pipeline in sleepTick

## Decisions Made
- **Null-safe behavioral patterns:** When `getBehavioralPatterns` returns null (cold start, no behavioral data yet), provide a minimal stub with all-null signal fields so the stale-goal and unresolved-thread scanners still execute. The behavioral anomaly scanner's cold-start guard (`if (!signals.messageFrequency) return []`) handles this gracefully.
- **Missing ScheduledItem fields:** The plan's `addScheduledItem` call was missing `sessionId` and `recurring` fields required by the TypeScript type. Added `sessionId: null` and `recurring: null` to satisfy the type system.
- **Unused type imports removed:** The plan specified importing `GapSignal`, `GapScanInput`, and `UserContext` types, but these were unused in the implementation (values are inferred). Removed to keep imports clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added missing sessionId and recurring fields to addScheduledItem call**
- **Found during:** Task 1 (Wire gap scanner pipeline)
- **Issue:** TypeScript compilation failed because `addScheduledItem` requires `sessionId` and `recurring` fields that were not in the plan's code
- **Fix:** Added `sessionId: null` and `recurring: null` to the addScheduledItem call
- **Files modified:** src/memory/memory.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** c148c18 (Task 1 commit)

**2. [Rule 1 - Auto-fix bug] Added null-safe behavioral patterns handling**
- **Found during:** Task 1 (Wire gap scanner pipeline)
- **Issue:** `db.getBehavioralPatterns()` returns `BehavioralPatterns | null`, but `GapScanInput.behavioralSignals` requires non-null. Passing null would crash `scanBehavioralAnomalies` on property access.
- **Fix:** Added minimal stub object when null, allowing stale-goal and unresolved-thread scanners to still run
- **Files modified:** src/memory/memory.ts
- **Verification:** All tests pass, TypeScript compiles
- **Committed in:** c148c18 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking type error, 1 null-safety bug), 0 deferred
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None

## Next Phase Readiness
- Phase 31 (Gap Scanner) is complete: all 4 plans executed (signal heuristics, LLM diagnosis, gated actions, pipeline wiring)
- Gap scanner runs nightly during sleepTick after dream cycle and self-reflection
- Ready for Phase 32 (Inner Thoughts & Timing)

---
*Phase: 31-gap-scanner*
*Completed: 2026-02-10*
