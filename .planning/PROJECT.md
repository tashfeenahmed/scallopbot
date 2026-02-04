# SmartBot v2: Skills-Only Architecture

## What This Is

A proactive personal AI agent running locally with CLI access, using a pure skills-based architecture. All capabilities are defined as markdown skill files with YAML frontmatter that the agent discovers and invokes contextually. Includes web UI for testing, loop-until-done execution, and multi-channel trigger support (Telegram, Web, Cron).

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

### Active

- [ ] `read` skill — Read file contents
- [ ] `write` skill — Write/create files
- [ ] `edit` skill — Edit existing files

### Out of Scope

- Agent swarms / multi-agent orchestration — complexity not needed for personal use
- Voice synthesis skills — keep existing TTS implementation for now
- Custom training / fine-tuning — use off-the-shelf models

## Context

**Current State (v2.0 shipped):**
- 59,108 lines of TypeScript
- Skills-only architecture: bash, web_search, browser, memory_search, telegram_send
- Tool system removed entirely
- Web UI available at localhost for testing alongside Telegram
- Loop-until-done execution with [DONE] marker detection
- TriggerSource abstraction for Telegram, Web, and Cron triggers
- Consolidated 60-line system prompt with personal assistant framing

**Architecture:**
- Each skill folder contains: `SKILL.md` (description + instructions) + `scripts/` (execution scripts)
- Agent reads skill descriptions at startup, includes them in system prompt
- When user request matches a skill's triggers/description, agent invokes that skill
- Skill execution runs the appropriate script from `scripts/` folder
- SkillExecutor handles spawning, output capture, timeouts, and graceful shutdown

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

---
*Last updated: 2026-02-04 after v2.0 milestone*
