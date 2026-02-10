---
phase: 19-llm-guided-relations
plan: 01
subsystem: memory
tags: [llm, relation-classifier, relation-graph, vitest, memory-relations]

# Dependency graph
requires:
  - phase: 18-retrieval-reranking
    provides: opt-in LLMProvider injection pattern, graceful fallback pattern
provides:
  - LLM-based relation classification in RelationGraph via RelationshipClassifier
  - Optional classifierProvider constructor parameter for RelationGraph
  - Graceful regex fallback on LLM failure or absent provider
affects: [20-spreading-activation, 21-memory-fusion-engine, scallop-store integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [LLM classifier with regex fallback, batch classification for N candidates, error signal detection]

key-files:
  created: [src/memory/relations.test.ts]
  modified: [src/memory/relations.ts]

key-decisions:
  - "Optional classifierProvider as 4th constructor parameter — existing behavior unchanged without it"
  - "Single candidate uses classify(), 2+ candidates use classifyBatch() for efficiency"
  - "Detect classifier error signal (all NEW/0.5/failed) to trigger regex fallback"
  - "Map ScallopMemoryEntry fields to FactToClassify/ExistingFact: content->content, userId->subject, category->category"
  - "Early exit on high-confidence UPDATE (>=0.85) preserved for both LLM and regex paths"

patterns-established:
  - "LLM classifier integration: optional provider, classifier instance in constructor, batch candidates, detect error signals, regex fallback"

issues-created: []

# Metrics
duration: 5min
completed: 2026-02-10
---

# Phase 19 Plan 01: LLM-Based Relation Classification Summary

**Optional LLM-based relation classification in RelationGraph using RelationshipClassifier with batch support, error signal detection, and graceful regex fallback -- 8 tests passing**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-10
- **Completed:** 2026-02-10
- **Tasks:** TDD cycle (RED + GREEN, no refactor needed)
- **Files modified:** 1 created, 1 modified

## Accomplishments
- RelationGraph accepts optional `classifierProvider` (LLMProvider) in constructor
- When classifier is available, detectRelations() batches similarity-passing candidates into single LLM call
- Uses classify() for 1 candidate, classifyBatch() for 2+ candidates
- Maps ClassificationResult to DetectedRelation, filtering out NEW classifications
- Detects classifier error signal pattern (all results NEW/0.5/failed reason) and falls back to regex
- Catches uncaught errors in outer try-catch for additional safety
- Existing regex behavior completely unchanged when no classifierProvider is given

## Task Commits

TDD plan -- atomic commits per phase:

1. **RED: Failing tests** - `4df3aa3` (test)
2. **GREEN: Implementation** - `e29d28c` (feat)

No refactor commit needed -- implementation was clean on first pass.

## Files Created/Modified
- `src/memory/relations.test.ts` - 348 lines: 8 tests covering no-provider regex fallback, single/multi candidate LLM classification, UPDATES/EXTENDS/NEW mapping, LLM failure fallback, empty candidates
- `src/memory/relations.ts` - Added classifierProvider parameter, RelationshipClassifier integration, classifyWithLLM/classifyWithRegex methods, memoryToFact/memoryToExistingFact helpers

## Decisions Made
- Error signal detection instead of re-throwing: RelationshipClassifier internally catches LLM errors and returns `{ classification: 'NEW', confidence: 0.5, reason: '...failed...' }`. Rather than modifying the classifier, we detect this pattern and fall back to regex.
- classifyBatch gets one copy of newFact per candidate so the LLM compares each pair in a single call (avoids N+1 LLM calls).
- Early exit on high-confidence UPDATE (>=0.85) preserved for both LLM and regex paths.

## Deviations from Plan

- Test adjustment: batch test UPDATES confidence lowered from 0.9 to 0.8 to avoid triggering the early exit at >=0.85 which would prevent the second EXTENDS result from being added.
- Added error signal detection logic: the plan specified "LLM call fails -> falls back to regex" via try-catch, but RelationshipClassifier swallows errors internally. Added `allFailed` detection to properly trigger regex fallback.

## Issues Encountered

None

## Next Phase Readiness
- Phase 19-01 complete -- LLM-based relation classification ready
- 8 unit tests (relations.test.ts) + 32 existing tests (scallop.test.ts) = 40 total passing
- classifierProvider can be wired into ScallopMemoryStore in a follow-up plan (similar to rerankProvider in Phase 18-02)

---
*Phase: 19-llm-guided-relations*
*Completed: 2026-02-10*
