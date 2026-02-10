---
phase: 23-e2e-websocket-testing
plan: 03
subsystem: testing
tags: [e2e, vitest, memory-fusion, behavioral-profiling, multi-turn-conversation, full-pipeline]

# Dependency graph
requires:
  - phase: 23-e2e-websocket-testing/01
    provides: E2E test harness (createE2EGateway, createWsClient, cleanupE2E)
  - phase: 23-e2e-websocket-testing/02
    provides: Memory intelligence E2E patterns (re-ranking, LLM relations, spreading activation)
  - phase: 21-memory-fusion-engine
    provides: findFusionClusters, fuseMemoryCluster, BackgroundGardener fusion integration
  - phase: 22-behavioral-profiling
    provides: behavioral signals (messageFrequency, sessionEngagement, topicSwitch, responseLength)
provides:
  - E2E tests for memory fusion via deep tick
  - E2E tests for behavioral signal computation and profile context formatting
  - Full multi-turn conversation E2E test exercising complete v3.0 pipeline
  - Phase 23 complete -- v3.0 milestone ready for completion
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [direct-db-seeding with old documentDate for decay-aware fusion testing, direct BackgroundGardener.deepTick() invocation, ProfileManager.formatProfileContext() assertions]

key-files:
  created: [src/e2e/memory-lifecycle.test.ts, src/e2e/full-flow.test.ts]
  modified: []

key-decisions:
  - "Use insight category for fusion test: preference category has 0.995 decay rate (138-day half-life), making 60-day-old memories still prominence ~0.82 (above 0.7 fusion threshold). Insight category (0.97) gives prominence ~0.65 at 60 days."
  - "Seed memories via db.addMemory() for fusion test: scallopStore.add() always sets documentDate=Date.now(), but fusion requires old memories. Direct DB insert with backdated documentDate lets the decay engine calculate realistic low prominence."
  - "No explicit timestamp manipulation for behavioral signals: addSessionMessage() timestamps are sufficient since all messages are created at test time, giving enough data for cold-start threshold (>10 messages) without needing old timestamps."

patterns-established:
  - "Decay-aware test seeding: when testing features that depend on prominence thresholds (fusion), choose category and age to produce desired post-decay prominence rather than manually setting prominence (which gets overwritten by processFullDecay)"
  - "Direct component testing without WebSocket: BackgroundGardener.deepTick() and ProfileManager.formatProfileContext() can be tested directly without WebSocket overhead, accessing ScallopMemoryStore and ScallopDatabase for setup and assertions"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 23 Plan 03: Memory Fusion, Behavioral Profiling & Full Flow E2E Tests Summary

**E2E tests for memory fusion via deep tick, behavioral signal computation, profile context formatting, and a comprehensive 4-turn multi-turn conversation exercising the complete v3.0 pipeline**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T10:35:00Z
- **Completed:** 2026-02-10T10:43:00Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- Memory fusion E2E test: seeds 3 related insight-category memories with 60-day-old documentDate, connects with EXTENDS relations, triggers deepTick(), verifies derived memory created, originals superseded, DERIVES relations exist, prominence <= 0.7
- Behavioral signals E2E test: seeds 16 messages across 3 sessions with session summaries, triggers deepTick(), verifies messageFrequency, sessionEngagement, responseLength signals computed, communicationStyle set
- Profile context formatting E2E test: verifies formatProfileContext() returns natural language behavioral insights ("Messaging pace", "Session style", "Style:") without raw _sig_ keys or JSON field names
- Full multi-turn conversation E2E test: 4-turn conversation (establish facts -> add related facts -> trigger memory retrieval -> test session continuity), verifies fact extraction, memory storage, session creation, memory retrieval in system prompt, session message count

## Task Commits

Each task was committed atomically:

1. **Task 1: Memory fusion and behavioral profiling E2E tests** - `075f45b` (feat)
2. **Task 2: Full multi-turn conversation E2E test** - `33aa1bf` (feat)

## Files Created/Modified
- `src/e2e/memory-lifecycle.test.ts` - 3 E2E tests: fusion via deep tick, behavioral signals, profile context formatting
- `src/e2e/full-flow.test.ts` - 1 E2E test: 4-turn multi-turn conversation with full pipeline validation

## Decisions Made
- Used 'insight' category (decayRate 0.97) instead of 'preference' (0.995) for fusion test because preference memories barely decay even after 60 days (prominence ~0.82), while insight memories reach ~0.65 (below 0.7 fusion threshold)
- Seeded memories via db.addMemory() with backdated documentDate rather than scallopStore.add() followed by manual prominence update, since processFullDecay recalculates all prominences from document_date
- Behavioral signals test uses addSessionMessage() without timestamp manipulation since the cold-start threshold is based on message count (>=10), not time spread

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Decay engine overwrites manually set prominence**
- **Found during:** Task 1 (fusion test implementation)
- **Issue:** Plan specified seeding memories with prominence < 0.7 directly, but deepTick() calls processFullDecay() first, which recalculates prominence from document_date. Freshly created memories get prominence ~0.90 (ageDays=0), overriding manual values.
- **Fix:** Changed approach to seed memories via db.addMemory() with documentDate set to 60 days ago, using 'insight' category (decayRate 0.97) so the decay engine naturally calculates prominence ~0.65 (< 0.7).
- **Files modified:** src/e2e/memory-lifecycle.test.ts
- **Verification:** Fusion test passes -- derived memory created, originals superseded
- **Committed in:** 075f45b (Task 1 commit)

**2. [Rule 1 - Bug] db.raw() cannot execute UPDATE statements**
- **Found during:** Task 1 (behavioral signals test implementation)
- **Issue:** Plan implied using db.raw() to update session_messages.created_at timestamps, but raw() uses .all() which only works for SELECT. UPDATE statements throw "This statement does not return data."
- **Fix:** Removed timestamp manipulation entirely; behavioral signal computation depends on message count (>=10 cold-start) not time spread, so default timestamps from addSessionMessage() are sufficient.
- **Files modified:** src/e2e/memory-lifecycle.test.ts
- **Verification:** Behavioral signals test passes -- all signals computed
- **Committed in:** 075f45b (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (both bugs), 0 deferred
**Impact on plan:** Both fixes address test infrastructure limitations. No scope creep.

## Issues Encountered
None

## Verification

- [x] `npx vitest run src/e2e/` passes ALL 11 tests across 4 E2E files
- [x] No new TypeScript compilation errors (only pre-existing esModuleInterop/downlevelIteration warnings)
- [x] All test databases cleaned up (afterAll handlers)
- [x] Tests complete within 5.1s total (well under 120s limit)
- [x] No leftover processes or port conflicts

## Next Phase Readiness
- 11 total E2E tests passing (4 baseline + 3 memory intelligence + 3 memory lifecycle + 1 full flow)
- Phase 23 complete -- v3.0 milestone ready for completion
- All v3.0 features validated end-to-end: re-ranking, LLM relations, spreading activation, memory fusion, behavioral profiling, multi-turn conversations

---
*Phase: 23-e2e-websocket-testing*
*Completed: 2026-02-10*
