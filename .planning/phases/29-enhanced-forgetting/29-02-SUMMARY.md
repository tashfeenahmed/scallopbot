---
phase: 29-enhanced-forgetting
plan: 02
subsystem: memory
tags: [utility-score, forgetting, archival, orphan-pruning, deepTick, vitest]

# Dependency graph
requires:
  - phase: 29-enhanced-forgetting-01
    provides: computeUtilityScore, findLowUtilityMemories
  - phase: 24-heartbeat-tier-enhancements
    provides: retrieval audit with candidatesForDecay, pruneArchivedMemories
provides:
  - archiveLowUtilityMemories function (soft-archive low-utility memories)
  - pruneOrphanedRelations function (clean dangling relation edges)
  - Integrated enhanced forgetting pipeline in deepTick (audit → archive → prune → orphan)
affects: [30-self-reflection, 33-e2e-testing]

# Tech tracking
tech-stack:
  added: []
  patterns: [integrated-forgetting-pipeline, soft-archive-before-hard-delete]

key-files:
  created: [src/memory/enhanced-forgetting.test.ts]
  modified: [src/memory/utility-score.ts, src/memory/memory.ts, src/memory/index.ts]

key-decisions:
  - "Use db.deleteRelation() instead of raw SQL for orphan pruning (db.raw uses stmt.all which fails on write statements)"
  - "File-backed DB + secondary FK-OFF connection for orphan relation test setup"
  - "Per-step error isolation in deepTick pipeline (3a-3d each try/catch independently)"
  - "Single consolidated log message for all forgetting metrics"

patterns-established:
  - "Soft-archive pattern: set is_latest=0, memory_type='superseded' before hard prune"
  - "Orphan pruning: query orphans first, delete individually via API"

issues-created: []

# Metrics
duration: 10min
completed: 2026-02-10
---

# Phase 29 Plan 02: Wire Utility Forgetting + Orphan Pruning Summary

**Utility-based archival pipeline in deepTick: audit → soft-archive low-utility → hard-prune dead → orphan relation cleanup, with 6 integration tests**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-10T15:01:44Z
- **Completed:** 2026-02-10T15:11:32Z
- **Tasks:** 2
- **Files modified:** 4 (+ 1 created)

## Accomplishments
- `archiveLowUtilityMemories()` soft-archives memories below utility threshold (is_latest=0, memory_type='superseded')
- `pruneOrphanedRelations()` cleans up relation edges where source/target memories no longer exist
- deepTick step 3 replaced with integrated enhanced forgetting pipeline (3a: audit, 3b: archive, 3c: hard prune, 3d: orphan cleanup)
- Old standalone retrieval audit step removed (integrated into step 3a)
- 6 integration tests with real SQLite (file-backed DB for orphan scenarios)
- All 488 memory tests pass (482 existing + 6 new)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire utility-based forgetting into deepTick** - `2783fb4` (feat)
2. **Bugfix: Use deleteRelation instead of raw SQL** - `d369168` (fix)
3. **Task 2: Integration tests for enhanced forgetting** - `d497df3` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/memory/utility-score.ts` - Added ArchiveOptions, ArchiveResult types, archiveLowUtilityMemories, pruneOrphanedRelations
- `src/memory/memory.ts` - Rewired deepTick steps 3+5 into integrated enhanced forgetting pipeline (3a-3d)
- `src/memory/index.ts` - Exported new functions and types from utility-score module
- `src/memory/enhanced-forgetting.test.ts` - (new) 6 integration tests for the enhanced forgetting pipeline

## Decisions Made
- Used `db.deleteRelation()` instead of raw SQL DELETE for orphan pruning — `db.raw()` uses `stmt.all()` which throws on write statements in better-sqlite3
- Integration tests use file-backed DB with secondary better-sqlite3 connection (FK OFF) to create orphaned relations, since in-memory DBs have FK cascade enabled by default
- Each sub-step in deepTick pipeline (3a-3d) independently error-isolated with try/catch, following established pattern
- Single consolidated "Enhanced forgetting complete" log message with all metrics

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] db.raw() fails on DELETE statements**
- **Found during:** Task 1 (pruneOrphanedRelations implementation)
- **Issue:** `db.raw()` uses `prepare().all()` which throws "This statement does not return data" on DELETE in better-sqlite3
- **Fix:** Changed to query orphan IDs first, then delete individually via `db.deleteRelation()`
- **Files modified:** src/memory/utility-score.ts
- **Verification:** TypeScript compiles, orphan pruning tests pass
- **Committed in:** d369168

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Fix necessary for correct operation. No scope creep.

## Issues Encountered
- 2 pre-existing test failures in scallop.test.ts (Memory fusion scenario) — confirmed unrelated to this change

## Next Phase Readiness
- Phase 29 (Enhanced Forgetting) complete
- Ready for Phase 30: Self-Reflection
- deepTick now has full utility-based forgetting pipeline

---
*Phase: 29-enhanced-forgetting*
*Completed: 2026-02-10*
