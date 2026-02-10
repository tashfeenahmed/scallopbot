# Roadmap: SmartBot

## Overview

A proactive personal AI agent with skills-only architecture, enhanced agentic loop, and multiple trigger sources (Telegram, Web UI, Cron).

## Domain Expertise

None

## Completed Milestones

- ✅ [v1.0 Skills-Only Architecture](milestones/v1.0-ROADMAP.md) (Phases 1-7) — SHIPPED 2026-02-04
- ✅ [v2.0 Agent Polish & Enhanced Loop](milestones/v2.0-ROADMAP.md) (Phases 9-17) — SHIPPED 2026-02-04

## Current Milestone

### 🚧 v3.0 Research-Driven Intelligence (In Progress)

**Milestone Goal:** Implement highest-impact findings from 60+ recent papers (late 2025/early 2026) to make memory, routing, and tool use feel human-like. Each phase validated with WebSocket conversation tests.

**Key papers driving this milestone:**
- SYNAPSE (Jan 2026) — spreading activation retrieval
- FadeMem (Jan 2026) — biologically-inspired memory fusion
- A-MEM (Feb 2025) — LLM-guided memory relations

#### Phase 18: Retrieval Re-ranking

**Goal**: Add LLM-based re-ranking stage after BM25+semantic hybrid search to push recall from ~71% to ~87%
**Depends on**: Previous milestone complete
**Research**: Unlikely (internal patterns — adding a scoring pass on existing search results)
**Plans**: 2

Plans:
- [x] 18-01: LLM re-ranker TDD (rerankResults function with score blending)
- [x] 18-02: Integrate re-ranker into search pipeline

#### Phase 19: LLM-Guided Memory Relations

**Goal**: Replace regex-based detectContradiction/detectEnrichment in relations.ts with LLM-based classification for more accurate relation typing and conflict resolution
**Depends on**: Phase 18
**Research**: Unlikely (extending existing LLM fact extractor pattern)
**Plans**: 2

Plans:
- [x] 19-01: LLM-based classifyRelation with batch support and regex fallback (TDD)
- [x] 19-02: Wire LLM relation classification through gateway and ScallopMemoryStore

#### Phase 20: Spreading Activation

**Goal**: Replace BFS graph traversal in getRelatedMemoriesForContext with cognitive-science-inspired activation propagation (ACT-R) plus stochastic noise for retrieval diversity
**Depends on**: Phase 19
**Research**: Likely (ACT-R activation formulas, SYNAPSE spreading algorithm)
**Research topics**: ACT-R base-level activation formula, lateral inhibition parameters, spreading activation decay rates, stochastic noise calibration
**Plans**: TBD

Plans:
- [x] 20-01: Spreading activation TDD (spreadActivation function with typed edge weights and noise)
- [x] 20-02: Wire spreading activation into search pipeline

#### Phase 21: Memory Fusion Engine

**Goal**: Extend the background gardener to detect and merge clusters of decaying related memories into single stronger summaries (FadeMem: 82% retention at 55% storage)
**Depends on**: Phase 20
**Research**: Unlikely (extending existing decay engine and gardener)
**Plans**: 2

Plans:
- [x] 21-01: Memory fusion engine TDD (findFusionClusters + fuseMemoryCluster pure functions)
- [x] 21-02: Wire fusion into deep tick + integration tests

#### Phase 22: Behavioral Profiling

**Goal**: Track implicit user signals (message frequency, session duration, topic switching, response length patterns) alongside conversation-extracted facts for richer user profiles
**Depends on**: Phase 21
**Research**: Unlikely (extending existing ProfileManager)
**Plans**: TBD

Plans:
- [ ] 22-01: TBD

#### Phase 23: End-to-End WebSocket Integration Testing

**Goal**: Automated end-to-end validation of all v3.0 features (re-ranking, LLM relations, spreading activation, memory fusion, behavioral profiling) via WebSocket conversation tests against a local instance — send messages, verify DB state, confirm memory operations work correctly in production-like flow
**Depends on**: Phase 22
**Research**: Unlikely (writing test harness against existing WebSocket API)
**Plans**: TBD

Plans:
- [ ] 23-01: TBD

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| v1.0 | Skills-Only Architecture | 11/11 | Complete | 2026-02-04 |
| v2.0 | Agent Polish & Enhanced Loop | 11/11 | Complete | 2026-02-04 |
| 18. Retrieval Re-ranking | v3.0 | 2/2 | Complete | 2026-02-10 |
| 19. LLM-Guided Memory Relations | v3.0 | 2/2 | Complete | 2026-02-10 |
| 20. Spreading Activation | v3.0 | 2/2 | Complete | 2026-02-10 |
| 21. Memory Fusion Engine | v3.0 | 2/2 | Complete | 2026-02-10 |
| 22. Behavioral Profiling | v3.0 | 0/? | Not started | - |
| 23. E2E WebSocket Testing | v3.0 | 0/? | Not started | - |

**Total:** 16 phases + 6 new = 22 phases, 30 plans completed
