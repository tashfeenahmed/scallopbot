# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-09 after v3.0 milestone creation)

**Core value:** Skills-only execution: Every capability the agent has comes from a skill file that advertises itself to the agent.
**Current focus:** v3.0 Research-Driven Intelligence

## Current Position

Phase: 19 of 27 (LLM-Guided Memory Relations)
Plan: 1 of 2 in current phase
Status: In progress
Last activity: 2026-02-10 - Completed 19-01-PLAN.md

Progress: ██▓░░░░░░░ 25%

## Shipped Milestones

| Milestone | Phases | Plans | Shipped |
|-----------|--------|-------|---------|
| v1.0 Skills-Only Architecture | 1-7 | 11 | 2026-02-04 |
| v2.0 Agent Polish & Enhanced Loop | 9-17 | 11 | 2026-02-04 |

**Total:** 22 plans completed in 16 phases

## Accumulated Context

### Key Decisions (Summary)

Full decision log in PROJECT.md Key Decisions table.

**v1.0 Decisions:**
- Skills-only architecture (no tools)
- SKILL_ARGS as JSON env var (injection-safe)
- 60s bash timeout, 30KB output limit

**v2.0 Decisions:**
- [DONE] marker for explicit completion
- TriggerSource abstraction for multi-channel
- 60-line consolidated system prompt

**v3.0 Context:**
- Research survey of 60+ papers (late 2025/early 2026) completed
- Key papers: SYNAPSE, FadeMem, A-MEM, TALE, FrugalGPT, EquiRouter, Dynamic Mix Precision, IEEE S&P 2026
- Each phase includes WebSocket-based conversation testing
- Goal: make memory/routing/tool-use feel human-like

**v3.0 Decisions:**
- Re-ranker score blending: original*0.4 + LLM*0.6 (LLM dominates for semantic understanding)
- Stateless pure functions for re-ranking (no class needed)
- Graceful fallback to original scores on any LLM failure
- Opt-in rerankProvider via constructor — existing search behavior unchanged without it
- Inline Groq adapter for standalone skills — keeps skills self-contained
- Optional classifierProvider for RelationGraph — regex fallback when absent
- Error signal detection for classifier failures (all NEW/0.5/failed → regex fallback)
- Single candidate → classify(), 2+ → classifyBatch() for efficiency

### Deferred Issues

- read, write, edit skills (for future milestone)

### Blockers/Concerns

None.

### Roadmap Evolution

- v1.0 shipped: Phases 1-7, 11 plans (2026-02-04)
- v2.0 shipped: Phases 9-17, 11 plans (2026-02-04)
- v3.0 created: Phases 18-27, 10 phases — Research-Driven Intelligence (2026-02-09)
- Archives: .planning/milestones/v1.0-ROADMAP.md, v2.0-ROADMAP.md

## Session Continuity

Last session: 2026-02-10
Stopped at: Completed 19-01-PLAN.md
Resume file: None
