# SmartBot v4: Bio-Inspired Cognitive Architecture

## What This Is

A proactive personal AI agent running locally with CLI access, using a pure skills-based architecture, research-backed memory intelligence, and bio-inspired cognitive features. All capabilities are defined as markdown skill files. Memory system features LLM re-ranking, relation classification, spreading activation retrieval, memory fusion, and behavioral profiling. Cognitive layer adds dream-based memory consolidation (NREM + REM), affect detection, self-reflection, proactive gap scanning, and inner thoughts with timing-aware delivery. Includes web UI, loop-until-done execution, and multi-channel trigger support (Telegram, Web, Cron).

## Core Value

**Skills-only execution**: Every capability the agent has comes from a skill file that advertises itself to the agent. No hardcoded tools—the agent reads skill descriptions and decides which to invoke based on user intent.

## Requirements

### Validated

- ✓ Multi-provider LLM support (Anthropic, OpenAI, Groq, Moonshot/Kimi) — existing
- ✓ Telegram messaging channel — existing
- ✓ Persistent semantic memory system — existing
- ✓ Session management with JSONL storage — existing
- ✓ Cost tracking and budget enforcement — existing
- ✓ Skills-only architecture — v1.0
  - ✓ SKILL.md format with YAML frontmatter (name, description, triggers)
  - ✓ Scripts folder with execution scripts
  - ✓ Agent discovers skills by scanning skill directories
  - ✓ Agent selects skills based on description and trigger patterns
- ✓ Core skills implemented — v1.0
  - ✓ `bash` skill — Execute shell commands (60s timeout, 30KB limit)
  - ✓ `web_search` skill — Search the web (Brave API)
  - ✓ `telegram_send` skill — Send messages via Telegram
  - ✓ `memory_search` skill — Search conversation memory
  - ✓ `browser` skill — Web browsing and scraping
- ✓ Skills-only agent loop — v1.0
  - ✓ Load skill descriptions into system prompt
  - ✓ Agent outputs skill name + arguments
  - ✓ Execute skill's script with arguments
  - ✓ Return result to agent
- ✓ Kimi K2.5 thinking mode integration — v2.0
- ✓ Web UI for local testing — v2.0
- ✓ Loop-until-done execution with [DONE] marker — v2.0
- ✓ TriggerSource abstraction for multi-channel dispatch — v2.0
- ✓ Proactive execution guidelines — v2.0
- ✓ Human-like messaging style — v2.0
- ✓ Consolidated system prompt (60 lines) — v2.0
- ✓ LLM-based search re-ranking — v3.0
- ✓ LLM-guided memory relations — v3.0
- ✓ Spreading activation retrieval — v3.0
- ✓ Memory fusion engine — v3.0
- ✓ Behavioral profiling — v3.0
- ✓ E2E WebSocket test suite — v3.0
- ✓ 3-tier heartbeat system (light/deep/sleep) — v4.0
  - ✓ Health monitoring and retrieval auditing
  - ✓ Trust score computation via behavioral signals
  - ✓ Goal deadline checks
  - ✓ Tier 3 sleep infrastructure with wall-clock gating
- ✓ Affect detection and context injection — v4.0
  - ✓ AFINN-165 + VADER heuristic classifier
  - ✓ Dual-EMA mood smoothing (fast 2h / slow 3d)
  - ✓ Observation-only affect guard (per Mozikov et al.)
- ✓ Dream cycle — v4.0
  - ✓ NREM cross-category fusion consolidation
  - ✓ REM stochastic exploration with LLM-judge validation
  - ✓ Dream orchestrator coordinating NREM + REM phases
- ✓ Utility-based forgetting — v4.0
  - ✓ Utility score = prominence * log(1 + accessCount)
  - ✓ Soft-archive then hard-prune pipeline
  - ✓ Orphan relation pruning
- ✓ Self-reflection — v4.0
  - ✓ Composite insights extraction (Renze & Guven taxonomy)
  - ✓ SOUL re-distillation with sentence-boundary truncation
  - ✓ SOUL.md file I/O in sleepTick
- ✓ Gap scanner — v4.0
  - ✓ 3-stage PROBE pipeline (search → diagnose → act)
  - ✓ Proactiveness dial gating (conservative/moderate/eager)
  - ✓ Combined budget + hardCap enforcement
- ✓ Inner thoughts & timing — v4.0
  - ✓ Post-session proactive evaluation with cooldown + distress suppression
  - ✓ 4-strategy delivery timing (urgent_now/next_morning/active_hours/next_active)
  - ✓ Per-channel formatting (Telegram icon+footer, WebSocket structured JSON)
  - ✓ Trust-calibrated feedback loop with engagement tracking
- ✓ Comprehensive E2E cognitive test suite — v4.0
  - ✓ 21 E2E tests validating full cognitive pipeline
  - ✓ 1,501 total tests across 82 files

### Active

- [ ] `read` skill — Read file contents
- [ ] `write` skill — Write/create files
- [ ] `edit` skill — Edit existing files

### Out of Scope

- Agent swarms / multi-agent orchestration — complexity not needed for personal use
- Voice synthesis skills — keep existing TTS implementation for now
- Custom training / fine-tuning — use off-the-shelf models

## Context

**Current State (v4.0 shipped):**
- ~418k lines of TypeScript (~35.5k net additions in v4.0)
- Skills-only architecture: bash, web_search, browser, memory_search, telegram_send
- Memory intelligence: LLM re-ranking, relation classification, spreading activation, fusion, behavioral profiling
- Cognitive features: dreams (NREM+REM), affect detection, self-reflection, gap scanning, inner thoughts
- 1,501 tests passing across 82 test files
- Web UI available at localhost for testing alongside Telegram
- Loop-until-done execution with [DONE] marker detection
- TriggerSource abstraction for Telegram, Web, and Cron triggers
- 3-tier heartbeat: light tick (5min), deep tick (30min), sleep tick (nightly)

**Architecture:**
- Each skill folder contains: `SKILL.md` (description + instructions) + `scripts/` (execution scripts)
- Agent reads skill descriptions at startup, includes them in system prompt
- When user request matches a skill's triggers/description, agent invokes that skill
- Skill execution runs the appropriate script from `scripts/` folder
- SkillExecutor handles spawning, output capture, timeouts, and graceful shutdown
- Memory pipeline: BM25+semantic search → LLM re-ranking → spreading activation → result composition
- Background gardener: light tick (health/affect) → deep tick (decay/fusion/forgetting/inner thoughts) → sleep tick (dreams/reflection/gap scanning)
- Cognitive pipeline: affect → dreams (NREM→REM) → reflection → gap scanning → inner thoughts → timing → delivery

## Constraints

- **TypeScript/Node.js**: Keep the existing runtime
- **Markdown Skills**: All skill definitions in `.md` files with YAML frontmatter

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Skills-only (no tools) | Simpler architecture, one abstraction for all capabilities | ✓ Good - v1.0 |
| Scripts in skill folders | Skills need to execute actions; scripts/ folder keeps code near definition | ✓ Good - v1.0 |
| Triggers + description in frontmatter | Agent needs to know WHEN to use a skill and WHAT it does | ✓ Good - v1.0 |
| SKILL_ARGS as JSON env var | Prevents shell injection attacks | ✓ Good - v1.0 |
| 60s bash timeout, 30KB output limit | Prevents runaway commands and memory issues | ✓ Good - v1.0 |
| Kimi K2.5 as thinking provider | Already integrated; best open reasoning model for complex tasks | ✓ Good - v2.0 |
| [DONE] marker for completion | Explicit signal vs heuristic detection | ✓ Good - v2.0 |
| TriggerSource abstraction | Unified interface for Telegram/Web/Cron triggers | ✓ Good - v2.0 |
| System prompt 60 lines | Focused, achievement-oriented personal assistant | ✓ Good - v2.0 |
| Re-ranker score blending 0.4/0.6 | LLM dominates for semantic understanding | ✓ Good - v3.0 |
| Stateless pure functions | Re-ranking, activation, fusion all pure — testable, composable | ✓ Good - v3.0 |
| Opt-in provider pattern | rerankProvider/classifierProvider/fusionProvider all optional — backward compatible | ✓ Good - v3.0 |
| Reuse fast-tier provider | Same cheap LLM for reranking, classification, fusion | ✓ Good - v3.0 |
| EMA halfLife 7 days | Smooths behavioral signals, responsive to recent patterns | ✓ Good - v3.0 |
| Direct-wiring E2E pattern | Bypass Gateway class for testable component composition | ✓ Good - v3.0 |
| 3-tier heartbeat (light/deep/sleep) | Separates real-time health checks from heavy cognitive processing | ✓ Good - v4.0 |
| AFINN-165 + dual-EMA affect | Fast keyword heuristic, no API dependency, smooth mood tracking | ✓ Good - v4.0 |
| Observation-only affect guard | Prevents LLM from acting on emotions, per Mozikov et al. | ✓ Good - v4.0 |
| Dream orchestrator pattern | Sequential NREM→REM with per-phase error isolation | ✓ Good - v4.0 |
| Utility-based forgetting | Better than prominence-only: tracks actual retrieval usage | ✓ Good - v4.0 |
| SOUL re-distillation | Evolving personality snapshot from composite reflections | ✓ Good - v4.0 |
| 3-stage PROBE pipeline | Separates signal detection, diagnosis, and action gating cleanly | ✓ Good - v4.0 |
| Proactiveness dial | User-configurable conservative/moderate/eager thresholds | ✓ Good - v4.0 |
| 4-strategy delivery timing | Respects quiet hours while enabling urgent bypass | ✓ Good - v4.0 |
| Per-channel formatting | Telegram and WebSocket get appropriate formatting | ✓ Good - v4.0 |
| Trust feedback loop | Engagement tracking calibrates future proactive behavior | ✓ Good - v4.0 |

---
*Last updated: 2026-02-10 after v4.0 milestone*
