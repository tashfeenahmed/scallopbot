---
phase: 32-inner-thoughts-timing
plan: 01
subsystem: proactive
tags: [inner-thoughts, llm, gap-scanner, proactive, affect]

requires:
  - phase: 31-gap-scanner
    provides: GapSignal type and scanning pipeline
  - phase: 25-affect-detection
    provides: SmoothedAffect type for affect suppression
provides:
  - Inner thoughts evaluation module (shouldRunInnerThoughts, evaluateInnerThoughts)
  - InnerThoughtsInput/InnerThoughtsResult types
affects: [32-02-timing-model, 32-04-wire-pipeline]

tech-stack:
  added: []
  patterns: [prompt-builder-parser-orchestrator, fail-safe-to-skip, pre-filter-gating]

key-files:
  created: [src/memory/inner-thoughts.ts, src/memory/inner-thoughts.test.ts]
  modified: []

key-decisions:
  - "6-hour proactive cooldown to prevent message fatigue"
  - "Distress suppression: never proact when user is distressed"
  - "Conservative dial with no signals → skip (bias toward silence)"

patterns-established:
  - "Pre-filter + LLM evaluation pattern for proactive decisions"

issues-created: []

duration: 5min
completed: 2026-02-10
---

# Phase 32 Plan 01: Inner Thoughts Module Summary

**Built the inner thoughts evaluation module with 6-condition pre-filter and LLM-based proactive follow-up assessment, following the established prompt-builder-parser-orchestrator pattern.**

## Performance
- **Duration:** 5min
- **Started:** 2026-02-10T19:13:00Z
- **Completed:** 2026-02-10T19:18:00Z
- **Tasks:** TDD (RED/GREEN) — no REFACTOR needed
- **Files modified:** 2

## Accomplishments
- Created `shouldRunInnerThoughts` pre-filter with 6 conditions: cooldown (6h), distress suppression, session length minimum (3 messages), gap signal detection, dial gating, and conservative default
- Created `buildInnerThoughtsPrompt` prompt builder with session summary, gap signals, and affect context
- Created `parseInnerThoughtsResponse` JSON parser with fail-safe to skip on invalid input, decision validation, and urgency defaulting
- Created `evaluateInnerThoughts` orchestrator with pre-filter → LLM → parse pipeline and LLM error fail-safe
- All 18 test cases passing across 4 function groups

## Task Commits
- RED: `010932e` — test(32-01): add failing tests for inner thoughts evaluation
- GREEN: `6768912` — feat(32-01): implement inner thoughts evaluation module

## Files Created/Modified
- `src/memory/inner-thoughts.ts` — Inner thoughts evaluation module (4 exported functions, 2 exported types)
- `src/memory/inner-thoughts.test.ts` — 18 test cases covering pre-filter, prompt builder, parser, and orchestrator

## Decisions Made
- Used `throw new Error('Not implemented')` for shouldRunInnerThoughts stub to ensure all 18 tests fail in RED phase (boolean stub would accidentally pass 2 tests)
- Followed gap-diagnosis.ts pattern exactly: same JSON extraction regex, same extractResponseText helper, same fail-safe structure
- Used Set-based validation for decision and urgency values for O(1) lookup
- Pre-filter reason in evaluateInnerThoughts is generic ("Pre-filter rejected") rather than condition-specific; specific reasons can be added if needed for debugging

## Deviations from Plan
None — implementation matches plan specification exactly.

## Issues Encountered
None

## Next Phase Readiness
- Inner thoughts module ready for timing model (32-02)
- evaluateInnerThoughts ready to be wired into pipeline (32-04)

---
*Phase: 32-inner-thoughts-timing*
*Completed: 2026-02-10*
