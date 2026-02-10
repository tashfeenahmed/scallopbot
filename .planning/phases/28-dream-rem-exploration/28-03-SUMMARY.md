---
phase: 28-dream-rem-exploration
plan: 03
subsystem: memory
tags: [sleeptick, dream-wiring, extends-relations, rem-integration, nrem-refactor]

# Dependency graph
requires:
  - phase: 28-dream-rem-exploration-01
    provides: remExplore, RemExplorationResult, RemDiscovery types
  - phase: 28-dream-rem-exploration-02
    provides: dream() orchestrator, DreamConfig, DreamResult types
  - phase: 27-dream-nrem-consolidation
    provides: sleepTick with inline NREM, BackgroundGardener, fusionProvider
provides:
  - sleepTick wired to dream() orchestrator (NREM+REM unified cycle)
  - REM discoveries stored as EXTENDS relations
  - dream + rem-exploration exports from memory/index.ts
affects: [29-enhanced-forgetting, 30-self-reflection, 33-e2e-cognitive-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [dream-orchestrator-wiring, extends-relation-storage, shared-provider-reuse]

key-files:
  created:
    - src/memory/gardener-rem.test.ts
  modified:
    - src/memory/memory.ts
    - src/memory/gardener-nrem.test.ts
    - src/memory/index.ts

key-decisions:
  - "Reuse fusionProvider for both NREM and REM — single fast-tier LLM provider, can split later if needed"
  - "EXTENDS relations store discovery confidence but no connection description metadata yet (future use)"
  - "Relaxed NREM test assertion from exact call count to minimum count to accommodate shared provider serving REM calls"

patterns-established:
  - "EXTENDS relation pattern: REM discoveries create additive relations without new memories or supersession"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 28 Plan 3: Wire REM into sleepTick Summary

**sleepTick refactored to call dream() orchestrator for unified NREM→REM cycle with REM discoveries stored as EXTENDS relations**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T14:38:20Z
- **Completed:** 2026-02-10T14:47:12Z
- **Tasks:** 2
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- Replaced inline nremConsolidate call in sleepTick with unified dream() orchestrator
- REM discoveries stored as EXTENDS relations between existing memories (no new memories created, no supersession)
- 4 integration tests verifying REM wiring, NREM independence, zero-discovery handling, and REM failure isolation
- Exported dream + rem-exploration types/functions from index.ts
- All 458 memory module tests pass with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace sleepTick inline NREM with dream() orchestrator + REM storage** - `b481748` (feat)
2. **Task 2: Add REM integration tests and update exports** - `15855e4` (test)

## Files Created/Modified
- `src/memory/memory.ts` - sleepTick refactored to call dream() orchestrator, REM result storage as EXTENDS relations, updated imports
- `src/memory/gardener-rem.test.ts` - 4 integration tests for REM wiring
- `src/memory/gardener-nrem.test.ts` - Test 5 assertion relaxed for shared provider call count
- `src/memory/index.ts` - Added dream.ts and rem-exploration.ts exports

## Decisions Made
- Reused fusionProvider for both NREM and REM (same fast-tier LLM) — avoids adding a separate remProvider to BackgroundGardenerOptions, can be split later if REM needs a different model
- EXTENDS relations store confidence value but not connection description metadata yet — structure supports future use per RESEARCH.md
- Relaxed gardener-nrem.test.ts Test 5 from exact call count (2) to minimum count (≥2) since shared provider now serves both NREM and REM calls

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] NREM test assertion incompatible with shared provider**
- **Found during:** Task 1 (sleepTick refactor)
- **Issue:** Test 5 in gardener-nrem.test.ts asserted `toHaveBeenCalledTimes(2)` for fusionProvider, but dream() now routes both NREM and REM through the same provider, increasing call count to 4
- **Fix:** Changed to `toBeGreaterThanOrEqual(2)` — test purpose is verifying per-cluster error isolation, not exact call counting
- **Files modified:** src/memory/gardener-nrem.test.ts
- **Verification:** All 5 existing NREM tests pass
- **Committed in:** b481748 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug), 0 deferred
**Impact on plan:** Fix necessary for test compatibility with shared provider pattern. No scope creep.

## Issues Encountered
- Pre-existing TypeScript error in `src/memory/dream.test.ts:155` (`TS2304: Cannot find name 'beforeEach'`) — exists on clean main branch before any changes, not introduced by this plan

## Next Phase Readiness
- Phase 28 complete: full NREM→REM dream cycle wired into sleepTick
- dream() orchestrator runs sequentially with per-phase error isolation
- REM adds EXTENDS relations for novel cross-category discoveries
- Ready for Phase 29: Enhanced Forgetting

---
*Phase: 28-dream-rem-exploration*
*Completed: 2026-02-10*
