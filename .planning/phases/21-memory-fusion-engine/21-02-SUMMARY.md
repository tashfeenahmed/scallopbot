---
phase: 21-memory-fusion-engine
plan: 02
subsystem: memory
tags: [fusion, gardener, deep-tick, integration-tests, gateway, wiring]

# Dependency graph
requires:
  - phase: 21-memory-fusion-engine/01
    provides: findFusionClusters, fuseMemoryCluster pure functions
  - phase: 20-spreading-activation
    provides: getRelations callback pattern
  - phase: 18-retrieval-reranking
    provides: rerankProvider fast-tier LLM pattern
provides:
  - Fusion step wired into BackgroundGardener.deepTick()
  - Gateway passes rerankProvider as fusionProvider
  - FusionConfig/FusionResult re-exported from memory/index.ts
  - Integration tests proving end-to-end fusion pipeline
affects: [memory-maintenance, storage-optimization, background-gardener]

# Tech tracking
tech-stack:
  added: []
  patterns: [opt-in-provider-injection, document-date-backdating-for-tests, decay-threshold-alignment]

key-files:
  modified: [src/memory/memory.ts, src/gateway/gateway.ts, src/memory/index.ts, src/memory/scallop.test.ts]
  created: []

key-decisions:
  - "Fusion step placed after full decay scan and before session summaries in deepTick"
  - "Opt-in fusionProvider via BackgroundGardenerOptions — no behavior change without it"
  - "Gateway reuses fast-tier rerankProvider as fusionProvider — same provider reuse pattern"
  - "maxProminence raised from 0.5 to 0.7 to align with decay formula floor (~0.52)"
  - "Tests use db.addMemory() with old documentDate for realistic decay-driven prominence"

patterns-established:
  - "Document-date backdating for integration tests involving decay-dependent logic"
  - "Decay formula awareness: non-age components guarantee min prominence ~0.52"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-10
---

# Phase 21 Plan 02: Wire Fusion into Deep Tick Summary

**Fusion engine wired into BackgroundGardener deep tick with gateway integration and full integration tests**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-10
- **Completed:** 2026-02-10
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- BackgroundGardener.deepTick() now runs memory fusion after full decay scan, before session summaries
- Per-user dormant memory discovery, BFS cluster detection, LLM-guided fusion, and derived memory storage
- DERIVES relations from fused to sources, source memories marked as superseded
- Gateway passes fast-tier rerankProvider as fusionProvider (same reuse pattern as relationsProvider)
- FusionConfig/FusionResult re-exported from memory/index.ts barrel
- 3 integration tests: happy path fusion, exclusion of active/derived memories, graceful LLM failure

## Task Commits

Each task was committed atomically:

1. **Wire fusion into deep tick and gateway** - `1b949ed` (feat)
2. **Integration tests for fusion pipeline** - `8d35723` (test)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Modified
- `src/memory/memory.ts` - Added fusionProvider option, fusion step in deepTick
- `src/gateway/gateway.ts` - Pass rerankProvider as fusionProvider to BackgroundGardener
- `src/memory/index.ts` - Re-export fusion types and functions
- `src/memory/scallop.test.ts` - 3 integration tests for fusion pipeline

## Decisions Made
- maxProminence threshold raised from 0.5 to 0.7 — the decay formula's non-age components (accessFrequency + recencyOfAccess) guarantee a minimum prominence floor of ~0.52, making the original 0.5 threshold unreachable
- Tests use db.addMemory() directly with old documentDate rather than store.add() + backdating, ensuring decay naturally computes correct prominence values

## Deviations from Plan

1. **maxProminence threshold fix (auto-fix bug):** The plan specified `prominence < 0.5` for the dormant filter and `maxProminence: 0.5` for findFusionClusters. However, the decay formula's non-age components (accessFrequency=0.25 + recencyOfAccess=0.25) create a floor of ~0.52 for all memories regardless of age, making the 0.5 threshold unreachable. Raised both to 0.7, which correctly captures memories that have significantly decayed from their initial ~0.90 prominence.

2. **Test approach (auto-fix blocker):** The plan specified using `db.updateProminences()` to set prominence to 0.3 and then calling deepTick. However, deepTick runs `processFullDecay()` first which recalculates all prominences based on documentDate, overwriting the manually set values. Tests now use `db.addMemory()` directly with old documentDate (150 days ago) so that the decay formula naturally computes prominence ~0.67, which passes the 0.7 threshold filter.

## Issues Encountered

None beyond the deviations noted above.

## Phase Readiness
- Phase 21 (Memory Fusion Engine) is now complete (2/2 plans done)
- Ready for Phase 22: Per-Turn Model Routing
- No blockers

---
*Phase: 21-memory-fusion-engine*
*Completed: 2026-02-10*
