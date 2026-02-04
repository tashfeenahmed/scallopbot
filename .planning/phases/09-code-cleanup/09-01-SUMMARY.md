---
phase: 09-code-cleanup
plan: 01
subsystem: agent
tags: [skills, tools, refactoring, cleanup]

# Dependency graph
requires:
  - phase: 07-agent-loop-refactor
    provides: Skills-based execution with SkillExecutor, toolRegistry made optional
provides:
  - Skills-only Agent execution (no tool fallback)
  - Fully decoupled Agent from ToolRegistry
affects: [future-tool-deprecation, agent-maintenance]

# Tech tracking
tech-stack:
  added: []
  patterns: [skills-only-execution]

key-files:
  created: []
  modified:
    - src/agent/agent.ts
    - src/agent/agent.test.ts
    - src/gateway/gateway.ts

key-decisions:
  - "Agent executes skills only - no tool fallback path"
  - "Gateway retains internal toolRegistry for reminder/file callbacks only"

patterns-established:
  - "Skills are the ONLY execution path for LLM tool calls"

issues-created: []

# Metrics
duration: 8min
completed: 2026-02-04
---

# Phase 9-01: Remove Tool Fallback Summary

**Agent now executes skills exclusively - tool fallback code removed, toolRegistry decoupled**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-04T00:00:00Z
- **Completed:** 2026-02-04T00:08:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Removed tool fallback execution path from Agent executeTools method (~45 lines of code removed)
- Removed all toolRegistry references from Agent class (interface, property, constructor assignment)
- Gateway no longer passes toolRegistry to Agent, maintains it internally for callbacks

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove tool fallback execution path from Agent** - `8871204` (refactor)
2. **Task 2: Remove toolRegistry from Agent class** - `a503fea` (refactor)
3. **Task 3: Update Gateway to stop passing toolRegistry to Agent** - `ddb5028` (refactor)

**Plan metadata:** `16ef29d` (docs: complete plan)

## Files Created/Modified
- `src/agent/agent.ts` - Removed tool fallback block, toolRegistry property, and related imports
- `src/agent/agent.test.ts` - Removed toolRegistry from test Agent instantiations
- `src/gateway/gateway.ts` - Stopped passing toolRegistry to Agent, added clarifying comment

## Decisions Made
- Agent executeTools now returns "Unknown skill" error immediately if skill not found (no tool fallback)
- Gateway's getToolRegistry() is now documented as internal-only (used for reminders and file send)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## Next Phase Readiness
- Agent is now fully skills-only, ready for further cleanup
- ToolRegistry can be further deprecated in future phases if needed
- Tests updated to not rely on toolRegistry

---
*Phase: 09-code-cleanup*
*Completed: 2026-02-04*
