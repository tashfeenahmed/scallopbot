---
phase: 31-gap-scanner
plan: 02
subsystem: memory
tags: [gap-diagnosis, llm, proactive, tdd, pure-functions, fail-safe]

# Dependency graph
requires:
  - phase: 31-gap-scanner/01
    provides: GapSignal type and Stage 1 heuristic scanner
  - phase: 25-affect-detection
    provides: SmoothedAffect type for user mood context
provides:
  - DiagnosedGap and UserContext types
  - buildGapDiagnosisPrompt pure prompt builder
  - parseGapDiagnosis pure JSON response parser
  - diagnoseGaps async LLM orchestrator
affects: [31-gap-scanner/03, 31-gap-scanner/04, 32-inner-thoughts]

# Tech tracking
tech-stack:
  added: []
  patterns: [prompt-builder-plus-parser pattern, fail-safe-to-not-actionable invariant, JSON extraction regex for LLM responses]

key-files:
  created: [src/memory/gap-diagnosis.ts, src/memory/gap-diagnosis.test.ts]
  modified: []

key-decisions:
  - "Fail-safe invariant: all error paths (invalid JSON, LLM error, empty response) produce not-actionable gaps with confidence 0"
  - "JSON extraction via regex /{[\\s\\S]*}/ tolerates surrounding text from LLM"
  - "extractResponseText internal helper handles both ContentBlock[] and string responses (same pattern as reflection.ts)"

patterns-established:
  - "Prompt builder + parser + orchestrator: three-function pattern for LLM-backed modules"
  - "Fail-safe-to-not-actionable: error paths never produce false positives"

issues-created: []

# Metrics
duration: 4min
completed: 2026-02-10
---

# Phase 31 Plan 02: LLM Gap Diagnosis Summary

**Stage 2 LLM triage module with prompt builder, fail-safe JSON parser, and async orchestrator for diagnosing gap signals**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-10T16:36:29Z
- **Completed:** 2026-02-10T16:40:56Z
- **Tasks:** 2 (RED + GREEN; REFACTOR not needed)
- **Files modified:** 2

## Accomplishments
- Pure `buildGapDiagnosisPrompt` function producing CompletionRequest with proactiveness dial, user mood, and JSON-only instruction
- Pure `parseGapDiagnosis` parser with fail-safe invariant: invalid JSON, missing fields, out-of-range indices all handled gracefully
- Async `diagnoseGaps` orchestrator following reflection.ts pattern (prompt → LLM call → parse)
- 24 tests covering all functions including error paths and multi-block ContentBlock handling

## Task Commits

Each TDD phase was committed atomically:

1. **RED: Failing tests** - `e47bee8` (test)
2. **GREEN: Implementation** - `0e905e4` (feat)
3. **REFACTOR:** Not needed — code was already clean

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified
- `src/memory/gap-diagnosis.ts` - DiagnosedGap/UserContext types, buildGapDiagnosisPrompt, parseGapDiagnosis, diagnoseGaps
- `src/memory/gap-diagnosis.test.ts` - 24 tests covering prompt builder (11), parser (8), orchestrator (5)

## Decisions Made
- Fail-safe invariant: all error paths produce not-actionable gaps (never false positive on error)
- JSON extraction regex `/{[\s\S]*}/` tolerates surrounding text from LLM output
- extractResponseText handles both ContentBlock[] and string (same pattern as reflection.ts)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness
- DiagnosedGap[] output ready for Stage 3 (proactiveness-gated actions in 31-03)
- UserContext type available for downstream consumers
- Fail-safe invariant ensures no false positives propagate to action stage

---
*Phase: 31-gap-scanner*
*Completed: 2026-02-10*
