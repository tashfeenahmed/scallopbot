# SmartBot v3: Research-Driven Intelligence

## What This Is

A proactive personal AI agent running locally with CLI access, using a pure skills-based architecture and research-backed memory intelligence. All capabilities are defined as markdown skill files. Memory system features LLM re-ranking, relation classification, spreading activation retrieval, memory fusion, and behavioral profiling — informed by 60+ recent papers (SYNAPSE, FadeMem, A-MEM). Includes web UI, loop-until-done execution, and multi-channel trigger support (Telegram, Web, Cron).

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
  - ✓ Enable thinking mode via `enableThinking` flag
  - ✓ Handle `reasoning_content` in responses
  - ✓ Temperature constraints (1.0 for thinking, 0.6 for instant)
- ✓ Web UI for local testing — v2.0
- ✓ Loop-until-done execution with [DONE] marker — v2.0
- ✓ TriggerSource abstraction for multi-channel dispatch — v2.0
- ✓ Proactive execution guidelines — v2.0
- ✓ Human-like messaging style — v2.0
- ✓ Consolidated system prompt (60 lines) — v2.0
- ✓ LLM-based search re-ranking — v3.0
  - ✓ Score blending (40% original + 60% LLM) for improved recall
  - ✓ Graceful fallback to original scores on LLM failure
  - ✓ Opt-in rerankProvider via constructor
- ✓ LLM-guided memory relations — v3.0
  - ✓ Batch classification replacing regex-based relation detection
  - ✓ Error signal detection with regex fallback
  - ✓ Optional classifierProvider with backward compatibility
- ✓ Spreading activation retrieval — v3.0
  - ✓ ACT-R/SYNAPSE algorithm with typed edge weights
  - ✓ Fan-out normalization and Gaussian noise for diversity
  - ✓ Activation * prominence composition for temporal-spatial blending
- ✓ Memory fusion engine — v3.0
  - ✓ BFS cluster detection with category-boundary splitting
  - ✓ LLM-guided content merging in BackgroundGardener deep tick
  - ✓ maxProminence 0.7 cap, summary length validation
- ✓ Behavioral profiling — v3.0
  - ✓ EMA-smoothed signals (frequency, engagement, topic switching, response length)
  - ✓ Cold start handling (null for < 10 messages)
  - ✓ Natural-language formatting for LLM context
- ✓ E2E WebSocket test suite — v3.0
  - ✓ 11 tests covering all v3.0 features
  - ✓ Direct-wired test harness with mock providers

### Active

- [ ] `read` skill — Read file contents
- [ ] `write` skill — Write/create files
- [ ] `edit` skill — Edit existing files

### Out of Scope

- Agent swarms / multi-agent orchestration — complexity not needed for personal use
- Voice synthesis skills — keep existing TTS implementation for now
- Custom training / fine-tuning — use off-the-shelf models

## Context

**Current State (v3.0 shipped):**
- ~68,777 lines of TypeScript (~59k v2.0 + ~9.7k v3.0 net additions)
- Skills-only architecture: bash, web_search, browser, memory_search, telegram_send
- Memory intelligence: LLM re-ranking, relation classification, spreading activation, fusion, behavioral profiling
- 1,080 tests passing (1,069 unit + 11 E2E) across 51 test files
- Web UI available at localhost for testing alongside Telegram
- Loop-until-done execution with [DONE] marker detection
- TriggerSource abstraction for Telegram, Web, and Cron triggers

**Architecture:**
- Each skill folder contains: `SKILL.md` (description + instructions) + `scripts/` (execution scripts)
- Agent reads skill descriptions at startup, includes them in system prompt
- When user request matches a skill's triggers/description, agent invokes that skill
- Skill execution runs the appropriate script from `scripts/` folder
- SkillExecutor handles spawning, output capture, timeouts, and graceful shutdown
- Memory pipeline: BM25+semantic search → LLM re-ranking → spreading activation → result composition
- Background gardener: decay processing → fusion clustering → behavioral signal inference

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
| _sig_ prefix in response_preferences | No schema migration needed for behavioral signals | ✓ Good - v3.0 |
| Direct-wiring E2E pattern | Bypass Gateway class for testable component composition | ✓ Good - v3.0 |

---
*Last updated: 2026-02-10 after v3.0 milestone*
