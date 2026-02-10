---
phase: 22-behavioral-profiling
plan: 02
subsystem: memory
tags: [behavioral-profiling, profile-manager, background-gardener, context-formatting, integration-tests]

# Dependency graph
requires:
  - phase: 22-01
    provides: pure signal extractor functions (computeMessageFrequency, computeSessionEngagement, computeTopicSwitchRate, computeResponseLengthEvolution)
  - phase: 21
    provides: memory fusion engine, BackgroundGardener deep tick pipeline
provides:
  - End-to-end behavioral signal pipeline (deepTick → inferBehavioralPatterns → compute → storage → formatProfileContext)
  - Extended BehavioralPatterns interface with 4 signal fields
  - Natural-language behavioral insights in LLM context
affects: [23-e2e-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [response_preferences JSON column reuse for signal storage, _sig_ prefix keys for internal signal data, optional parameter injection for backward compatibility]

key-files:
  created: []
  modified: [src/memory/db.ts, src/memory/profiles.ts, src/memory/memory.ts, src/memory/index.ts, src/memory/scallop.test.ts]

key-decisions:
  - "Store signals in response_preferences JSON with _sig_ prefix keys — no schema migration"
  - "Optional sessions and messageEmbeddings params keep inferBehavioralPatterns backward-compatible"
  - "Surface signals as natural-language one-liners, not raw numbers"

patterns-established:
  - "JSON column reuse: extend existing JSON columns with prefixed keys to avoid ALTER TABLE"
  - "Natural-language signal formatting: convert numeric signals to personality insights for LLM consumption"

issues-created: []

# Metrics
duration: 5min
completed: 2026-02-10
---

# Phase 22 Plan 02: Wire Behavioral Signals Summary

**Wired 4 behavioral signal extractors into ProfileManager inference pipeline, stored signals in response_preferences JSON, and surfaced natural-language personality insights in LLM context formatting**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-10T02:37:59Z
- **Completed:** 2026-02-10T02:43:41Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Extended BehavioralPatterns interface with messageFrequency, sessionEngagement, topicSwitch, and responseLength signal fields
- Wired all 4 signal extractors into inferBehavioralPatterns with optional sessions/embeddings params for backward compatibility
- Updated BackgroundGardener.deepTick to pass existing session data and memory embeddings to signal computation
- Added natural-language context formatting (messaging pace, session style, topic exploration, length trends)
- Added 4 integration tests covering full signal population, context formatting, cold start, and backward compatibility
- Re-exported all signal types and functions from index.ts barrel

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend BehavioralPatterns and wire signal extractors** - `a7f58d7` (feat)
2. **Task 2: Context formatting and integration tests** - `1e92810` (feat)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified
- `src/memory/db.ts` - Extended BehavioralPatterns interface, updated read/write to store signals in response_preferences JSON with _sig_ prefix keys
- `src/memory/profiles.ts` - Wired signal extractors into inferBehavioralPatterns, added natural-language formatting in formatProfileContext
- `src/memory/memory.ts` - Updated deepTick to collect and pass session data + existing embeddings
- `src/memory/index.ts` - Barrel re-exports for all signal types and functions
- `src/memory/scallop.test.ts` - 4 integration tests for signal pipeline end-to-end

## Decisions Made
- Store signals in response_preferences JSON with `_sig_` prefix keys — avoids ALTER TABLE entirely while keeping data co-located with behavioral patterns
- Optional `sessions` and `messageEmbeddings` parameters on inferBehavioralPatterns — backward compatible, callers without session/embedding data skip those signals gracefully
- Natural-language formatting only shows non-null, non-trivial signals (e.g., response length trend hidden when "stable")

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## Next Phase Readiness
- Phase 22 (Behavioral Profiling) complete — both signal extractors (22-01) and pipeline wiring (22-02) done
- End-to-end flow operational: deepTick → inferBehavioralPatterns → compute signals → store in response_preferences → formatProfileContext
- Ready for Phase 23 (E2E WebSocket Integration Testing)

---
*Phase: 22-behavioral-profiling*
*Completed: 2026-02-10*
