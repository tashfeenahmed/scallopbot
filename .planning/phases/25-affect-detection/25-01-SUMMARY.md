---
phase: 25-affect-detection
plan: 01
subsystem: memory
tags: [affect-detection, sentiment, valence, arousal, circumplex, classifier]

# Dependency graph
requires:
  - phase: 22-01
    provides: Stateless pure function pattern for signal computation
  - phase: 24-04
    provides: Behavioral patterns infrastructure (EMA, trends)
provides:
  - classifyAffect(text) -> {valence, arousal, emotion, confidence}
  - mapToEmotion(valence, arousal) -> EmotionLabel
  - Curated affect lexicon (167 arousal words, 38 negation tokens, 42 boosters, 31 emoji)
affects: [phase-25-02-ema-smoothing, phase-26-context-injection, phase-31-gap-scanner, phase-32-suppression]

# Tech tracking
tech-stack:
  added: [afinn-165]
  patterns: [VADER-style negation/booster heuristics, Russell circumplex quadrant mapping]

key-files:
  created: [src/memory/affect.ts, src/memory/affect-lexicon.ts, src/memory/affect.test.ts]
  modified: [src/memory/index.ts]

key-decisions:
  - "Used AFINN-165 for valence (3,382 words, MIT licensed) instead of hand-rolling valence dictionary"
  - "Arousal is a separate curated dimension (167 words), NOT derived from valence magnitude"
  - "VADER N_SCALAR = -0.74 for negation dampening, check 3 preceding tokens"
  - "Boosters adjust score directionally (amplify positive, amplify negative) not just magnitude"
  - "Confidence = matchCount / totalTokens, capped at 1.0"
  - "Emoji extracted as separate tokens before word tokenization"
  - "Contractions stripped of apostrophes for negation matching (don't -> dont)"

patterns-established:
  - "Affect classifier as pure stateless function — same pattern as behavioral-signals.ts"
  - "Separate lexicon module (affect-lexicon.ts) for data resources"
  - "Two-pass tokenization: emoji extraction then word tokenization"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 25 Plan 01: Affect Classifier Summary

**Built the core affect classifier: a pure function that classifies user message text into valence/arousal dimensions with emotion label mapping via Russell's circumplex model, using AFINN-165 for valence, curated arousal word list, and VADER-style negation/booster heuristics.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T12:26:30Z
- **Completed:** 2026-02-10T12:34:00Z
- **Tasks:** 3 (RED, GREEN, REFACTOR)
- **Files created/modified:** 4 (3 created, 1 modified)
- **Tests:** 35 passing

## TDD Cycle

### RED Phase
- Created `src/memory/affect.test.ts` with 35 tests across 7 describe blocks
- Tests covered: basic positive/negative/neutral classification, negation handling (5 cases), booster/intensifier handling (3 cases), mapToEmotion circumplex quadrants (9 cases), emotion quadrant integration (4 cases), emoji handling (3 cases), edge cases (5 cases)
- Tests failed as expected (module not found)
- Commit: `317d8ab`

### GREEN Phase
- Installed `afinn-165` npm dependency
- Created `src/memory/affect-lexicon.ts`: 167 arousal words, 38 negation tokens, 42 boosters, 31 emoji with valence+arousal scores, N_SCALAR constant
- Created `src/memory/affect.ts`: tokenize(), scoreTokens(), hasNegation(), mapToEmotion(), classifyAffect() — all pure functions
- All 35 tests passing
- Commit: `bc3ee5d`

### REFACTOR Phase
- Added affect module exports to `src/memory/index.ts` barrel following established pattern
- Extended arousal map with common word inflections (frustrating, terrible, horrible, awful, dreadful) for better chat coverage
- All 35 tests still passing, TypeScript compiles cleanly
- Commit: `cf28369`

## Task Commits

Each TDD phase committed atomically:

1. **RED: Failing test suite** - `317d8ab` (test)
2. **GREEN: Affect classifier implementation** - `bc3ee5d` (feat)
3. **REFACTOR: Barrel exports and arousal map extension** - `cf28369` (refactor)

## Files Created/Modified
- `src/memory/affect-lexicon.ts` — Created: curated arousal map (167 words), VADER-derived negation set (38 tokens), booster/intensifier dict (42 entries), emoji valence+arousal map (31 emoji), N_SCALAR = -0.74
- `src/memory/affect.ts` — Created: classifyAffect(), mapToEmotion(), tokenize(), RawAffect interface, EmotionLabel type. Pure stateless functions, no async, no side effects
- `src/memory/affect.test.ts` — Created: 35 tests across 7 describe blocks covering all behavior cases from the plan
- `src/memory/index.ts` — Modified: added affect module exports (classifyAffect, mapToEmotion, RawAffect, EmotionLabel)

## Decisions Made
- AFINN-165 normalizes -5..+5 to -1..+1 by dividing by 5
- Boosters apply directionally: positive booster on positive word amplifies positivity; positive booster on negative word amplifies negativity
- Negation check uses 3-token window (VADER standard)
- Emoji are tokenized separately from words and scored via dedicated map
- Confidence is 0 when no sentiment/arousal words match (prevents EMA contamination in Plan 02)
- `tokenize` is exported for potential reuse but `scoreTokens` remains internal

## Deviations from Plan

Minor: Added 5 common word inflections (frustrating, terrible, horrible, awful, dreadful) to the arousal map during GREEN phase to fix the Q4 emotion integration test. The original arousal map only had base forms (e.g., "frustrated" but not "frustrating"), causing "This is terrible and frustrating" to map to Q3 (sad) instead of Q4 due to zero arousal matches.

## Issues Encountered

None. All tests pass, TypeScript compiles cleanly, no pre-existing test regressions.

## Next Step
Phase 25 Plan 02: Dual-EMA mood smoothing integration with existing behavioral-signals infrastructure.

---
*Phase: 25-affect-detection*
*Completed: 2026-02-10*
