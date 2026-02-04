---
phase: 12-loop-until-done
plan: 01
subsystem: agent
tags: [agent-loop, task-completion, system-prompt, loop-until-done]

# Dependency graph
requires:
  - phase: 07-agent-loop-refactor
    provides: Agent loop with maxIterations limit and stopReason handling
  - phase: 11-web-ui
    provides: Web UI for browser-based testing
provides:
  - isTaskComplete() method detecting [DONE] marker
  - Loop-until-done behavior via explicit completion signaling
  - Updated system prompt with TASK COMPLETION instructions
affects: [phase-13-unified-triggers, agent-behavior]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Explicit task completion via [DONE] marker
    - Loop-until-done agent behavior

key-files:
  created: []
  modified:
    - src/agent/agent.ts

key-decisions:
  - "[DONE] marker (case insensitive) signals explicit task completion"
  - "Marker stripped from final response to user"
  - "Backward compatible - single-turn responses still work without [DONE]"

patterns-established:
  - "Agent loops until task complete or maxIterations reached"
  - "[DONE] marker at end of response signals completion"

issues-created: []

# Metrics
duration: 3min
completed: 2026-02-04
---

# Phase 12: Loop Until Done Summary

**Agent continues working in loops until explicitly signaling [DONE], enabling autonomous multi-step task completion**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-04T12:00:00Z
- **Completed:** 2026-02-04T12:15:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Added `isTaskComplete()` method to detect [DONE] marker at end of responses
- Added `stripDoneMarker()` to clean marker from final user-facing response
- Updated agent loop termination to check for explicit task completion
- Added `taskComplete` boolean to iteration logging for debugging
- Updated system prompt with TASK COMPLETION section and examples
- Modified EXECUTION RULES to reinforce loop-until-done behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Add task completion detection to agent loop** - `647de34` (feat)
2. **Task 2: Update system prompt for loop-until-done behavior** - `993ac09` (feat)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified

- `src/agent/agent.ts` - Added completion detection methods, updated loop termination, added TASK COMPLETION prompt section

## Decisions Made

- **[DONE] marker format:** Case-insensitive, allows trailing whitespace, must be at end of response
- **Backward compatibility:** Single-turn responses without [DONE] still work via `end_turn` + no tool use
- **Marker stripping:** [DONE] removed from response before returning to user for clean output

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness

- Agent now continues working until task is explicitly complete
- [DONE] marker provides clear completion signaling
- Ready for Phase 13 (Unified Triggers) with robust loop behavior
- No blockers or concerns

---
*Phase: 12-loop-until-done*
*Completed: 2026-02-04*
