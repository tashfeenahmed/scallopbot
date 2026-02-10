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
- Dynamic Mix Precision (Feb 2026) — per-turn routing
- TALE (ACL 2025) — token budget control
- FrugalGPT (Stanford) — semantic caching
- EquiRouter (Feb 2026) — routing collapse detection
- IEEE S&P 2026 — browser dark pattern defense

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
- [ ] 21-01: Memory fusion engine TDD (findFusionClusters + fuseMemoryCluster pure functions)
- [ ] 21-02: Wire fusion into deep tick + integration tests

#### Phase 22: Per-Turn Model Routing

**Goal**: Route each conversation turn independently based on its complexity instead of committing to a tier for the whole session — greetings use fast tier, complex reasoning escalates
**Depends on**: Phase 21
**Research**: Unlikely (modifying existing router)
**Plans**: TBD

Plans:
- [ ] 22-01: TBD

#### Phase 23: Token Budget Control

**Goal**: Set dynamic max_tokens based on query complexity + remaining daily/monthly budget. Add conciseness hints for simple queries (TALE: 68% token reduction with <5% quality loss)
**Depends on**: Phase 22
**Research**: Unlikely (modifying existing router and agent prompt)
**Plans**: TBD

Plans:
- [ ] 23-01: TBD

#### Phase 24: Semantic Response Cache

**Goal**: Embedding-indexed response cache in SQLite — if a near-identical query was recently answered, return cached response instead of making a new API call (FrugalGPT)
**Depends on**: Phase 23
**Research**: Unlikely (new SQLite table + existing embedding infrastructure)
**Plans**: TBD

Plans:
- [ ] 24-01: TBD

#### Phase 25: Routing Health Monitor

**Goal**: Detect routing collapse (>80% queries going to expensive tier), track tier distribution over time, continuous burn-rate awareness that auto-downshifts when spending too fast
**Depends on**: Phase 24
**Research**: Unlikely (adding metrics to existing router)
**Plans**: TBD

Plans:
- [ ] 25-01: TBD

#### Phase 26: Browser Safety Layer

**Goal**: Dark pattern detection and verification step before destructive browser actions (purchase, signup, permission grants). IEEE S&P 2026 found 41% susceptibility, larger models MORE vulnerable
**Depends on**: Phase 25
**Research**: Likely (dark pattern taxonomy and defense strategies from IEEE S&P 2026 + DECEPTICON papers)
**Research topics**: Dark pattern categories, verification prompt design, action classification (destructive vs safe)
**Plans**: TBD

Plans:
- [ ] 26-01: TBD

#### Phase 27: Behavioral Profiling

**Goal**: Track implicit user signals (message frequency, session duration, topic switching, response length patterns) alongside conversation-extracted facts for richer user profiles
**Depends on**: Phase 26
**Research**: Unlikely (extending existing ProfileManager)
**Plans**: TBD

Plans:
- [ ] 27-01: TBD

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| v1.0 | Skills-Only Architecture | 11/11 | Complete | 2026-02-04 |
| v2.0 | Agent Polish & Enhanced Loop | 11/11 | Complete | 2026-02-04 |
| 18. Retrieval Re-ranking | v3.0 | 2/2 | Complete | 2026-02-10 |
| 19. LLM-Guided Memory Relations | v3.0 | 2/2 | Complete | 2026-02-10 |
| 20. Spreading Activation | v3.0 | 2/2 | Complete | 2026-02-10 |
| 21. Memory Fusion Engine | v3.0 | 0/? | Not started | - |
| 22. Per-Turn Model Routing | v3.0 | 0/? | Not started | - |
| 23. Token Budget Control | v3.0 | 0/? | Not started | - |
| 24. Semantic Response Cache | v3.0 | 0/? | Not started | - |
| 25. Routing Health Monitor | v3.0 | 0/? | Not started | - |
| 26. Browser Safety Layer | v3.0 | 0/? | Not started | - |
| 27. Behavioral Profiling | v3.0 | 0/? | Not started | - |

**Total:** 16 phases + 10 new = 26 phases, 22 plans completed
