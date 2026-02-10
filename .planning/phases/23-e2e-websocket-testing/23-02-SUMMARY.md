---
phase: 23-e2e-websocket-testing
plan: 02
subsystem: testing
tags: [e2e, websocket, vitest, memory-intelligence, reranking, llm-relations, spreading-activation]

# Dependency graph
requires:
  - phase: 23-e2e-websocket-testing/01
    provides: E2E test harness (createE2EGateway, createWsClient, cleanupE2E)
  - phase: 18-retrieval-reranking
    provides: rerankResults() with score blending (0.4 original + 0.6 LLM)
  - phase: 19-llm-guided-relations
    provides: LLM-based relation classification in RelationGraph
  - phase: 20-spreading-activation
    provides: spreadActivation() with typed edge weights and ActivationConfig
provides:
  - E2E tests validating re-ranking, LLM relations, and spreading activation through real pipeline
  - Extended E2E helpers with rerankResponses, relationsResponses, activationConfig options
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [content-aware mock LLM provider for reranking, direct memory seeding with relation assertions, deterministic spreading activation via noiseSigma=0]

key-files:
  created: [src/e2e/memory-intelligence.test.ts]
  modified: [src/e2e/helpers.ts]

key-decisions:
  - "Content-aware reranker mock: custom LLM provider that parses candidate text from prompt and assigns high scores to food-related items, low scores to others -- enables testing re-ranking reorder behavior"
  - "Direct memory seeding for LLM relations test: fact extractor stores facts with detectRelations=false, so relation testing uses scallopStore.add() with detectRelations=true and relationsProvider configured"
  - "Deterministic spreading activation: noiseSigma=0 in ActivationConfig eliminates randomness for reliable test assertions"

patterns-established:
  - "Custom mock LLM providers: when cycling responses are insufficient, create function-based providers that inspect request content for dynamic scoring"
  - "Direct DB assertions: use scallopStore.getDatabase().raw() to verify memory_relations table state"

issues-created: []

# Metrics
duration: 12min
completed: 2026-02-10
---

# Phase 23 Plan 02: Memory Intelligence E2E Tests Summary

**E2E tests for re-ranking, LLM-classified relations, and spreading activation -- validating v3.0 memory intelligence features through real pipeline with DB-level assertions**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-10T03:03:19Z
- **Completed:** 2026-02-10T03:15:52Z
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- Re-ranking E2E test: seeds 5 memories, sends food query, verifies reranker was called and food-related memories appear in system prompt
- LLM relations E2E test: seeds related memories with relationsProvider, verifies EXTENDS relation stored in memory_relations table, confirms both memories appear in conversation context
- Spreading activation E2E test: seeds 3 memories with manual EXTENDS relations, verifies related memories retrieved through graph traversal in system prompt
- Extended E2E helpers with rerankResponses, relationsResponses, and activationConfig options on CreateE2EGatewayOptions

## Task Commits

Each task was committed atomically:

1. **Task 1: Re-ranking E2E test** - `7c49d7a` (feat)
2. **Task 2: LLM relations and spreading activation E2E tests** - `478a680` (feat)

## Files Created/Modified
- `src/e2e/memory-intelligence.test.ts` - 3 E2E tests covering re-ranking, LLM relations, and spreading activation
- `src/e2e/helpers.ts` - Added rerankResponses, relationsResponses, activationConfig to CreateE2EGatewayOptions; added ActivationConfig import; updated step numbering

## Decisions Made
- Content-aware reranker mock provider parses candidate content from prompt text to assign food-relevant scores dynamically, enabling real re-ranking behavior testing
- LLM relations test uses direct scallopStore.add() with detectRelations=true rather than WebSocket conversation, because the fact extractor stores facts with detectRelations=false (no memory_relations rows created through fact extraction path)
- Spreading activation test uses noiseSigma=0 for deterministic behavior in assertions

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Architecture Insight] Fact extractor disables detectRelations**
- **Found during:** Task 2 (LLM relations test implementation)
- **Issue:** The plan expected WebSocket messages -> fact extraction -> memory_relations rows. But LLMFactExtractor stores facts with `detectRelations: false` (line 814 of fact-extractor.ts), so no memory_relations rows are created through the conversation flow.
- **Fix:** Changed LLM relations test to seed memories directly via scallopStore.add() with detectRelations=true and relationsProvider configured. Still tests the LLM relation classification pipeline end-to-end, then verifies through a WebSocket conversation that related memories appear together.
- **Files modified:** src/e2e/memory-intelligence.test.ts
- **Verification:** Test passes, memory_relations table has EXTENDS relation with correct confidence
- **Committed in:** 478a680 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (architecture insight), 0 deferred
**Impact on plan:** Test approach adapted to match actual architecture. No scope creep.

## Issues Encountered
None

## Next Phase Readiness
- 3 memory intelligence E2E tests passing (re-ranking, LLM relations, spreading activation)
- 7 total E2E tests passing (4 baseline from 23-01 + 3 new from 23-02)
- E2E helpers extended with memory intelligence configuration options
- All tests complete in ~2.8s total

---
*Phase: 23-e2e-websocket-testing*
*Completed: 2026-02-10*
