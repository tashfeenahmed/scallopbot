# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-09 after v3.0 milestone creation)

**Core value:** Skills-only execution: Every capability the agent has comes from a skill file that advertises itself to the agent.
**Current focus:** v3.0 Research-Driven Intelligence

## Current Position

Phase: 23 of 23 (E2E WebSocket Integration Testing)
Plan: 3 of 3 in current phase
Status: Phase complete
Last activity: 2026-02-10 - Completed 23-03-PLAN.md

Progress: ██████████ 100%

## Shipped Milestones

| Milestone | Phases | Plans | Shipped |
|-----------|--------|-------|---------|
| v1.0 Skills-Only Architecture | 1-7 | 11 | 2026-02-04 |
| v2.0 Agent Polish & Enhanced Loop | 9-17 | 11 | 2026-02-04 |

**Total:** 22 plans completed in 16 phases (v1+v2)

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
- Reuse rerankProvider as relationsProvider — both need fast/cheap LLM tier
- Pure function spreadActivation() with getRelations callback — stateless, testable
- Activation * prominence composition for temporal-spatial relevance blending
- ActivationConfig opt-in via ScallopMemoryStoreOptions constructor — same pattern as rerankProvider
- ScallopSearchResult interface unchanged — activation scores internal to ranking
- Pure function findFusionClusters() with getRelations callback — BFS cluster detection, category-boundary splitting
- Graceful null return from fuseMemoryCluster() on LLM failure — caller decides fallback
- Summary length validation ensures fusion reduces storage
- Opt-in fusionProvider in BackgroundGardener — same fast-tier provider reuse pattern
- maxProminence 0.7 for fusion (decay formula floor ~0.52 makes 0.5 unreachable)
- Import cosineSimilarity from embeddings.js for topic switch detection (reuse, not reimplement)
- Cold start null returns for behavioral signals (type-safe caller handling)
- EMA halfLife 7 days for frequency/length signals; topic switch threshold 0.3 cosine similarity
- Store behavioral signals in response_preferences JSON with _sig_ prefix keys (no schema migration)
- Optional sessions/messageEmbeddings params for backward-compatible signal computation
- Natural-language signal formatting for LLM context (personality insights, not raw numbers)
- Direct wiring for E2E: bypass Gateway class, wire ApiChannel+Agent+ScallopMemoryStore with mock providers
- Separate mock providers for agent (natural language + [DONE]) vs fact-extractor (structured JSON)
- Content-aware mock LLM providers for E2E: inspect prompt content for dynamic scoring (vs cycling responses)
- Fact extractor stores with detectRelations=false — E2E relation tests seed via scallopStore.add() with detectRelations=true
- noiseSigma=0 in ActivationConfig for deterministic spreading activation in tests
- Decay-aware test seeding: use insight category + old documentDate for desired post-decay prominence (fusion tests)
- Direct component testing (BackgroundGardener.deepTick(), ProfileManager.formatProfileContext()) without WebSocket overhead

### Deferred Issues

- read, write, edit skills (for future milestone)

### Blockers/Concerns

None.

### Roadmap Evolution

- v1.0 shipped: Phases 1-7, 11 plans (2026-02-04)
- v2.0 shipped: Phases 9-17, 11 plans (2026-02-04)
- v3.0 created: Phases 18-27, 10 phases — Research-Driven Intelligence (2026-02-09)
- v3.0 trimmed: Removed phases 22-26 (routing, caching, browser safety), renumbered 27→22, added phase 23 (E2E WebSocket testing). Now 6 phases (18-23).
- Archives: .planning/milestones/v1.0-ROADMAP.md, v2.0-ROADMAP.md

## Session Continuity

Last session: 2026-02-10
Stopped at: Completed 23-03-PLAN.md — Phase 23 complete, v3.0 milestone ready for completion
Resume file: None
