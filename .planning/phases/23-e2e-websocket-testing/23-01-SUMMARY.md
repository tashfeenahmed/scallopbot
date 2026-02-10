---
phase: 23-e2e-websocket-testing
plan: 01
subsystem: testing
tags: [e2e, websocket, vitest, integration-tests, mock-providers, api-channel]

# Dependency graph
requires:
  - phase: 18-retrieval-reranking
    provides: memory search pipeline with re-ranking
  - phase: 22-behavioral-profiling
    provides: behavioral signals wired through full pipeline
provides:
  - E2E test harness (createE2EGateway, createWsClient, cleanupE2E)
  - Mock LLM and embedding providers for E2E tests
  - Baseline WebSocket conversation tests proving pipeline correctness
affects: [23-02, 23-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [direct-wiring E2E bootstrap bypassing Gateway class, separate mock providers for agent vs fact-extractor, hash-based deterministic pseudo-embeddings]

key-files:
  created: [src/e2e/helpers.ts, src/e2e/e2e.test.ts]
  modified: []

key-decisions:
  - "Direct wiring over Gateway class: Gateway.initializeProviders() is tightly coupled to real provider constructors — bypass it and wire ApiChannel+Agent+SessionManager+ScallopMemoryStore directly with mock providers"
  - "Separate mock providers for agent and fact-extractor: LLMFactExtractor needs structured JSON responses while Agent needs natural language with [DONE] — using one mock with cycling responses would create ordering fragility"
  - "Pre-seeded memory for retrieval test: Test 4 seeds a fact directly into ScallopMemoryStore rather than relying on async fact extraction from Test 3 — deterministic and isolates retrieval pipeline"

patterns-established:
  - "E2E direct-wiring: construct real components with mock providers instead of trying to inject mocks into Gateway"
  - "Hash-based pseudo-embeddings: deterministic 384-dim vectors from character codes for semantic search without Ollama"

issues-created: []

# Metrics
duration: 6min
completed: 2026-02-10
---

# Phase 23 Plan 01: E2E Test Harness & Baseline Conversation Tests Summary

**Direct-wired E2E harness with mock LLM/embedding providers, WebSocket client wrapper, and 4 baseline conversation tests proving full pipeline correctness**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-10T02:54:12Z
- **Completed:** 2026-02-10T03:00:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- E2E test infrastructure with direct-wired real components (ApiChannel, Agent, SessionManager, ScallopMemoryStore) and mock providers
- Mock LLM provider with call tracking and cycling responses, mock embedding provider with deterministic hash-based 384-dim vectors
- Promise-based WebSocket client wrapper with send/waitForResponse/collectUntilResponse/collectAll
- 4 baseline E2E tests passing: ping/pong, chat response, memory storage, memory retrieval

## Task Commits

Each task was committed atomically:

1. **Task 1: Create E2E test helpers and gateway bootstrap** - `a6f8673` (feat)
2. **Task 2: Add baseline E2E conversation tests** - `e7954ba` (feat)

## Files Created/Modified
- `src/e2e/helpers.ts` - E2E test infrastructure: mock providers, gateway bootstrap, WS client, cleanup
- `src/e2e/e2e.test.ts` - 4 baseline E2E tests: ping/pong, chat response, memory storage, memory retrieval

## Decisions Made
- Bypassed Gateway class for E2E bootstrap — Gateway.initializeProviders() is tightly coupled to real provider constructors. Direct wiring of ApiChannel + Agent + real components with mock providers gives full control.
- Separate mock LLM providers for Agent (natural language + [DONE]) and LLMFactExtractor (structured JSON facts) to avoid response ordering fragility.
- Test 4 pre-seeds a memory directly rather than relying on async fact extraction from prior test — isolates the retrieval pipeline.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Separate fact extractor mock provider**
- **Found during:** Task 1 (gateway bootstrap design)
- **Issue:** Single mock provider with cycling responses would create ordering fragility between Agent and LLMFactExtractor
- **Fix:** Added `factExtractorResponses` option to createE2EGateway that creates a separate mock LLM for the fact extractor
- **Files modified:** src/e2e/helpers.ts
- **Verification:** Tests 3 and 4 pass reliably with separate providers
- **Committed in:** a6f8673 (Task 1 commit)

**2. [Rule 1 - Bug] Deterministic memory retrieval test**
- **Found during:** Task 2 (memory retrieval test design)
- **Issue:** Relying on async fact extractor from Test 3 introduces timing fragility
- **Fix:** Test 4 pre-seeds a fact directly into ScallopMemoryStore, then verifies the Agent's system prompt includes it
- **Files modified:** src/e2e/e2e.test.ts
- **Verification:** Test 4 passes deterministically
- **Committed in:** e7954ba (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug), 0 deferred
**Impact on plan:** Both changes improve test reliability. No scope creep.

## Issues Encountered
None

## Next Phase Readiness
- E2E harness ready for feature-specific tests in Plan 02 (re-ranking, LLM relations, spreading activation)
- Test infrastructure proven: gateway boots and shuts down cleanly in ~3s
- Helpers fully reusable: createE2EGateway, createWsClient, cleanupE2E

---
*Phase: 23-e2e-websocket-testing*
*Completed: 2026-02-10*
