---
phase: 25-affect-detection
plan: 02
subsystem: memory
tags: [affect-smoothing, ema, dual-ema, goal-signal, valence, arousal]

# Dependency graph
requires:
  - phase: 25-01
    provides: classifyAffect(), mapToEmotion(), RawAffect, EmotionLabel
  - phase: 22-01
    provides: updateEMA() from behavioral-signals.ts
provides:
  - createInitialAffectState() -> AffectEMAState
  - updateAffectEMA(state, raw, nowMs) -> AffectEMAState
  - deriveGoalSignal(state) -> GoalSignal
  - getSmoothedAffect(state) -> SmoothedAffect
affects: [phase-26-context-injection, phase-31-gap-scanner, phase-32-suppression]

# Tech tracking
tech-stack:
  added: []
  patterns: [dual-EMA fast/slow smoothing, goal signal from EMA divergence]

key-files:
  created: [src/memory/affect-smoothing.ts, src/memory/affect-smoothing.test.ts]
  modified: [src/memory/index.ts]

key-decisions:
  - "Reused updateEMA() from behavioral-signals.ts — no hand-rolled EMA"
  - "Fast half-life = 2h (7_200_000ms), Slow half-life = 3d (259_200_000ms)"
  - "MIN_CONFIDENCE = 0.1 — below this, EMA is not updated (prevents neutral collapse)"
  - "Initial state (lastUpdateMs === 0) sets all channels to raw values directly"
  - "Goal signal priority: distressed > improving > engaged > disengaged > stable"
  - "Divergence threshold = 0.15 for distressed/improving detection"
  - "getSmoothedAffect uses fast EMA values for emotion mapping (more responsive)"
  - "Pick<RawAffect, 'valence' | 'arousal' | 'confidence'> for updateAffectEMA input type"

patterns-established:
  - "Dual-EMA smoothing layer as pure functions consuming updateEMA from behavioral-signals"
  - "Goal signal derivation from fast/slow EMA divergence"

issues-created: []

# Metrics
duration: 4min
completed: 2026-02-10
---

# Phase 25 Plan 02: Affect EMA Smoothing Summary

**Built the affect EMA smoothing layer: dual-EMA (fast 2h + slow 3d) for valence and arousal, plus goal signal derivation from EMA divergence. Reuses existing updateEMA() from behavioral-signals.ts. All functions pure, stateless, synchronous.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-10T12:34:24Z
- **Completed:** 2026-02-10T12:38:00Z
- **Tasks:** 3 (RED, GREEN, REFACTOR)
- **Files created/modified:** 3 (2 created, 1 modified)
- **Tests:** 17 passing

## TDD Cycle

### RED Phase
- Created `src/memory/affect-smoothing.test.ts` with 17 tests across 7 describe blocks
- Tests covered: initial state creation, EMA update with positive affect, convergence with multiple positive messages, fast/slow divergence on mood shift, confidence gating (2 cases), goal signal derivation for all 5 states + priority test, getSmoothedAffect shape + emotion + goalSignal, time gap convergence behavior
- Tests failed as expected (module not found)
- Commit: `7038f73`

### GREEN Phase
- Created `src/memory/affect-smoothing.ts`: createInitialAffectState(), updateAffectEMA(), deriveGoalSignal(), getSmoothedAffect() — all pure functions
- Imports updateEMA from behavioral-signals.ts, mapToEmotion + types from affect.ts
- Constants: FAST_HALF_LIFE_MS = 7_200_000 (2h), SLOW_HALF_LIFE_MS = 259_200_000 (3d), MIN_CONFIDENCE = 0.1
- All 17 tests passing, full suite 1203 tests passing
- Commit: `05499b8`

### REFACTOR Phase
- Added affect-smoothing exports to `src/memory/index.ts` barrel following established pattern
- Exports: createInitialAffectState, updateAffectEMA, deriveGoalSignal, getSmoothedAffect, AffectEMAState, GoalSignal, SmoothedAffect
- All 17 tests still passing
- Commit: `03f3f46`

## Task Commits

Each TDD phase committed atomically:

1. **RED: Failing test suite** — `7038f73` (test)
2. **GREEN: Affect EMA smoothing implementation** — `05499b8` (feat)
3. **REFACTOR: Barrel exports** — `03f3f46` (refactor)

## Files Created/Modified
- `src/memory/affect-smoothing.ts` — Created: AffectEMAState interface, GoalSignal type, SmoothedAffect interface, createInitialAffectState(), updateAffectEMA(), deriveGoalSignal(), getSmoothedAffect(). 153 lines, all pure functions.
- `src/memory/affect-smoothing.test.ts` — Created: 17 tests across 7 describe blocks covering all behavior from the plan.
- `src/memory/index.ts` — Modified: added affect-smoothing module exports (4 functions, 3 types).

## Decisions Made
- Used `Pick<RawAffect, 'valence' | 'arousal' | 'confidence'>` for the raw input type to updateAffectEMA, keeping it loosely coupled to the full RawAffect interface
- Goal signal priority order matches the plan: distressed checked first, then improving, then engaged, then disengaged, then stable
- Divergence threshold 0.15 (from RESEARCH.md) used for both distressed and improving detection
- Fast EMA values used in getSmoothedAffect for emotion mapping (provides more responsive emotion labels)

## Deviations from Plan

None. Implementation matches the plan exactly.

## Issues Encountered

None. All tests pass, TypeScript compiles cleanly, no pre-existing test regressions. Full suite: 1203 tests passing.

## Next Step
Phase 26: Context injection — wire smoothed affect and goal signal into the system prompt observation block.

---
*Phase: 25-affect-detection*
*Completed: 2026-02-10*
