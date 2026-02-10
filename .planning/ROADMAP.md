# Roadmap: SmartBot

## Overview

A proactive personal AI agent with skills-only architecture, enhanced agentic loop, and multiple trigger sources (Telegram, Web UI, Cron).

## Domain Expertise

None

## Milestones

- ✅ [v1.0 Skills-Only Architecture](milestones/v1.0-ROADMAP.md) (Phases 1-7) — SHIPPED 2026-02-04
- ✅ [v2.0 Agent Polish & Enhanced Loop](milestones/v2.0-ROADMAP.md) (Phases 9-17) — SHIPPED 2026-02-04
- ✅ [v3.0 Research-Driven Intelligence](milestones/v3.0-ROADMAP.md) (Phases 18-23) — SHIPPED 2026-02-10
- 🚧 **v4.0 Bio-Inspired Cognitive Architecture** — Phases 24-33 (in progress)

### 🚧 v4.0 Bio-Inspired Cognitive Architecture (In Progress)

**Milestone Goal:** Transform SmartBot from a reactive assistant into a cognitively rich personal intelligence with dreams (offline memory consolidation), emotions (affect-aware interaction), an enhanced heartbeat (persistent cognitive loop), and proactive intelligence (anticipatory gap detection) — all implemented at the application level via LLM API calls, SQLite operations, and Node.js orchestration. Based on the bio-inspired research report surveying 17 papers (Hu et al. 2025, Zhang 2026, Reflexion, MemGPT, CoALA, PROBE, etc.).

#### Phase 24: Heartbeat Tier Enhancements

**Goal**: Extend BackgroundGardener's existing 2-tier system with health monitoring, retrieval auditing, trust scoring, and goal deadline checks — laying the infrastructure all other v4.0 pillars depend on
**Depends on**: v3.0 complete
**Research**: Unlikely (extends existing BackgroundGardener internals, MemGPT/CoALA patterns already mapped)
**Plans**: TBD

Plans:
- [x] 24-01: Health Ping & Retrieval Audit (TDD)
- [x] 24-02: Trust Score Computation (TDD)
- [x] 24-03: Goal Deadline Check (TDD)
- [x] 24-04: Wire Gardener Tick Operations
- [x] 24-05: Tier 3 Sleep Infrastructure

#### Phase 25: Affect Detection

**Goal**: Build the affect classifier module — keyword-based valence/arousal detection, mood EMA signal integration into behavioral-signals.ts, and the `affect.ts` module that outputs `{valence, arousal, emotion, goalSignal}`
**Depends on**: Phase 24 (health infrastructure for affect decay in light tick)
**Research**: Unlikely (keyword heuristic first, per Borotschnig teleology-driven approach — no external API)
**Plans**: 3

Plans:
- [x] 25-01: Affect Classifier (TDD)
- [x] 25-02: Affect EMA Smoothing (TDD)
- [x] 25-03: Wire Affect Integration

#### Phase 26: Affect Context Injection

**Goal**: Wire affect signals into ContextManager's system prompt assembly — add "User Affect Context" observation block, implement the affect guard (emotion in observation only, never instructions per Mozikov et al.), update dynamic profiles with currentMood from classifier
**Depends on**: Phase 25 (affect classifier must exist)
**Research**: Unlikely (extends existing routing/context.ts patterns)
**Plans**: TBD

Plans:
- [x] 26-01: Affect Context Injection

#### Phase 27: Dream NREM Consolidation

**Goal**: Implement the NREM phase of the dream cycle — expand fusion clustering from same-category to cross-category, widen prominence window to [0.05, 0.8), enrich fusion prompts with relation context, run as part of a new nightly Tier 3 (Sleep) tick
**Depends on**: Phase 24 (heartbeat tier infrastructure for Tier 3 scheduling)
**Research**: Unlikely (extends existing fusion.ts — Hu et al. consolidation patterns already designed)
**Plans**: 3

Plans:
- [x] 27-01: Cross-Category Fusion Clustering (TDD)
- [x] 27-02: NREM Consolidation Module (TDD)
- [x] 27-03: Wire NREM into sleepTick

#### Phase 28: Dream REM Exploration

**Goal**: Implement REM stochastic graph exploration — sample random seed memories, spread activation with high noiseSigma (0.5-0.8), LLM-judge novel connections, store confirmed links as EXTENDS relations. Create dream.ts orchestrator coordinating NREM + REM phases
**Depends on**: Phase 27 (NREM consolidation and Tier 3 Sleep tick must exist)
**Research**: Likely (Zhang 2026 computational dreaming model — need to validate stochastic exploration parameters)
**Research topics**: Optimal noiseSigma range for discovery vs noise, seed sampling strategies, connection validation prompt design
**Plans**: TBD

Plans:
- [x] 28-01: REM Exploration Module (TDD)
- [x] 28-02: Dream Orchestrator (TDD)
- [x] 28-03: Wire REM into sleepTick

#### Phase 29: Enhanced Forgetting

**Goal**: Upgrade pruning from simple prominence-threshold to utility-based deletion per Hu et al. — track retrieval history (which memories are actually used in context), compute `utilityScore = prominence × log(1 + accessCount)`, archive low-utility memories, prune orphaned relation edges
**Depends on**: Phase 24 (retrieval audit from heartbeat tracks access patterns)
**Research**: Unlikely (formula specified in report, extends existing decay.ts)
**Plans**: TBD

Plans:
- [x] 29-01: Utility Score Computation (TDD)
- [x] 29-02: Wire Utility-Based Forgetting

#### Phase 30: Self-Reflection

**Goal**: Implement daily self-reflection — retrieve day's session summaries, LLM generates process-focused reflection (per Renze & Guven taxonomy), store as `insight`-category memories with DERIVES relations to source sessions. Runs in Tier 3 Sleep tick after dreams
**Depends on**: Phase 27 (Tier 3 Sleep tick infrastructure)
**Research**: Unlikely (Reflexion + Renze & Guven patterns already mapped to prompt design)
**Plans**: TBD

Plans:
- [x] 30-01: Self-Reflection Module (TDD)
- [x] 30-02: Wire Reflection into sleepTick

#### Phase 31: Gap Scanner

**Goal**: Build the PROBE 3-stage proactive pipeline — Stage 1 (Search): DB queries for unresolved threads, approaching deadlines, stale goals, behavioral anomalies; Stage 2 (Identify): LLM diagnoses specific gaps with user context + affect state; Stage 3 (Act): create scheduled_items gated by proactiveness dial (conservative/moderate/eager)
**Depends on**: Phase 26 (affect signals needed for Stage 2 context), Phase 24 (goal checks)
**Research**: Likely (PROBE benchmark shows 40% success rate — need to design robust search heuristics and timing model)
**Research topics**: Gap signal detection patterns, proactiveness dial calibration, timing model for natural breakpoints (per Microsoft CHI 2025)
**Plans**: TBD

Plans:
- [ ] 31-01: Gap Signal Heuristics (TDD)
- [ ] 31-02: LLM Gap Diagnosis (TDD)
- [ ] 31-03: Proactiveness-Gated Actions (TDD)
- [ ] 31-04: Wire Gap Scanner into sleepTick

#### Phase 32: Inner Thoughts & Timing

**Goal**: Post-session inner monologue — after each user session ends, run lightweight "inner thoughts" LLM evaluation of whether proactive action is warranted (per Liu et al. CHI 2025). Implement timing model: respect quiet hours, prefer session-start moments, per-channel formatting (Telegram short + expand, WebSocket structured JSON). Trust-calibrated feedback loop
**Depends on**: Phase 31 (gap scanner provides the proactive pipeline), Phase 25 (affect for suppression when stressed)
**Research**: Unlikely (inner thoughts pattern well-defined in report, extends existing scheduler delivery)
**Plans**: TBD

Plans:
- [ ] 32-01: TBD

#### Phase 33: E2E Cognitive Testing

**Goal**: Comprehensive E2E test suite validating all v4.0 features — dream cycle execution, affect detection + context injection, heartbeat tier transitions, self-reflection generation, gap scanner pipeline, inner thoughts triggering, trust calibration feedback loop. Direct-wired WebSocket tests following v3.0 E2E patterns
**Depends on**: All previous phases (24-32)
**Research**: Unlikely (follows established v3.0 E2E testing patterns)
**Plans**: TBD

Plans:
- [ ] 33-01: TBD

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1-7 | v1.0 | 11/11 | Complete | 2026-02-04 |
| 9-17 | v2.0 | 11/11 | Complete | 2026-02-04 |
| 18-23 | v3.0 | 13/13 | Complete | 2026-02-10 |
| 24. Heartbeat Tier Enhancements | v4.0 | 5/5 | Complete | 2026-02-10 |
| 25. Affect Detection | v4.0 | 3/3 | Complete | 2026-02-10 |
| 26. Affect Context Injection | v4.0 | 1/1 | Complete | 2026-02-10 |
| 27. Dream NREM Consolidation | v4.0 | 3/3 | Complete | 2026-02-10 |
| 28. Dream REM Exploration | v4.0 | 3/3 | Complete | 2026-02-10 |
| 29. Enhanced Forgetting | v4.0 | 2/2 | Complete | 2026-02-10 |
| 30. Self-Reflection | v4.0 | 2/2 | Complete | 2026-02-10 |
| 31. Gap Scanner | v4.0 | 0/4 | Not started | - |
| 32. Inner Thoughts & Timing | v4.0 | 0/? | Not started | - |
| 33. E2E Cognitive Testing | v4.0 | 0/? | Not started | - |

**Total:** 23 phases + 10 new, 41 plans completed across 3+ milestones
