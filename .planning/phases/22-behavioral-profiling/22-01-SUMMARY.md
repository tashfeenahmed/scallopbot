---
phase: 22-behavioral-profiling
plan: 01
subsystem: memory
tags: [behavioral-signals, ema, cosine-similarity, trend-detection, pure-functions, vitest]

# Dependency graph
requires:
  - phase: 21-memory-fusion-engine
    provides: Pure function pattern (fusion.ts, activation.ts)
  - phase: 18-retrieval-reranking
    provides: cosineSimilarity from embeddings.ts
provides:
  - computeMessageFrequency — EMA-smoothed daily message rate with trend
  - computeSessionEngagement — EMA-smoothed session length/duration with trend
  - computeTopicSwitchRate — embedding cosine similarity topic boundary detection
  - computeResponseLengthEvolution — EMA-smoothed message length with trend
  - updateEMA and detectTrend helper functions
  - MessageFrequencySignal, SessionEngagementSignal, TopicSwitchSignal, ResponseLengthSignal, BehavioralSignals interfaces
affects: [behavioral-profiling-wiring, profile-manager, background-gardener]

# Tech tracking
tech-stack:
  added: []
  patterns: [ema-irregular-time-series, half-split-trend-detection, cold-start-null-return]

key-files:
  created: [src/memory/behavioral-signals.ts, src/memory/behavioral-signals.test.ts]
  modified: []

key-decisions:
  - "Import cosineSimilarity from embeddings.js rather than reimplementing"
  - "Cold start returns null (not zero/empty) for type-safe caller handling"
  - "EMA halfLife 7 days for frequency/length, session-count-based for engagement"
  - "Topic switch threshold 0.3 cosine similarity (from research)"
  - "Trend threshold 15% delta between halves"

patterns-established:
  - "EMA for irregular time series: weight = 1 - exp(-dt/halfLife)"
  - "Cold start protection: null return below minimum sample size"
  - "Half-split trend detection for behavioral signal evolution"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 22 Plan 01: Behavioral Signal Extractors Summary

**TDD pure-function signal extractors: EMA-smoothed message frequency, session engagement, embedding-based topic switching, and response length evolution with trend detection**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10T02:25:13Z
- **Completed:** 2026-02-10T02:33:33Z
- **Tasks:** 2 (RED + GREEN, no REFACTOR needed)
- **Files created:** 2

## Accomplishments
- 4 pure signal extractor functions with cold start protection and EMA temporal smoothing
- updateEMA helper for irregular time series (weight = 1 - exp(-dt/halfLife))
- detectTrend helper using half-split comparison (>15% delta)
- Topic switch detection via cosine similarity drops below 0.3 threshold
- 42 comprehensive tests covering cold start, trends, edge cases

## Task Commits

Each TDD phase was committed atomically:

1. **RED: Failing tests** - `c2a96a5` (test)
2. **GREEN: Implementation** - `88d3bfe` (feat)

REFACTOR skipped — implementation was clean from GREEN phase.

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created
- `src/memory/behavioral-signals.ts` - 4 signal extractors + 2 helpers, 305 lines
- `src/memory/behavioral-signals.test.ts` - 42 tests across all functions, 563 lines

## Decisions Made
- Imported cosineSimilarity from embeddings.js — already exported and tested, no duplication needed
- Cold start returns null (not zero) so callers can distinguish "no data" from "computed zero"
- EMA halfLife 7 days for message frequency and response length; session-count-based smoothing for engagement
- Topic switch cosine similarity threshold 0.3 per research recommendation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness
- All signal interfaces and pure functions ready for wiring into ProfileManager
- Next plan (22-02) can wire these into inferBehavioralPatterns() and BackgroundGardener deep tick
- No blockers

---
*Phase: 22-behavioral-profiling*
*Completed: 2026-02-10*
