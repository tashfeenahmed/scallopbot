# SmartBot v2: Skills-Only Architecture

## What This Is

A personal AI agent that runs locally with CLI access, using a pure skills-based architecture. Instead of hardcoded tools, all capabilities (bash, file ops, web search, telegram messaging, etc.) are defined as markdown skill files that the agent discovers and uses contextually. This enables a simple, extensible system where adding new capabilities means dropping a new skill folder.

## Core Value

**Skills-only execution**: Every capability the agent has comes from a skill file that advertises itself to the agent. No hardcoded tools—the agent reads skill descriptions and decides which to invoke based on user intent.

## Requirements

### Validated

- ✓ Multi-provider LLM support (Anthropic, OpenAI, Groq, Moonshot/Kimi) — existing
- ✓ Telegram messaging channel — existing
- ✓ Persistent semantic memory system — existing
- ✓ Session management with JSONL storage — existing
- ✓ Cost tracking and budget enforcement — existing

### Active

- [ ] Skills-only architecture: Replace all tools with skill files
  - [ ] SKILL.md format with YAML frontmatter (name, description, triggers)
  - [ ] Scripts folder (`scripts/`) in each skill for execution
  - [ ] Agent discovers skills by scanning skill directories
  - [ ] Agent selects skills based on description and trigger patterns

- [ ] Core skills to implement:
  - [ ] `bash` skill — Execute shell commands
  - [ ] `read` skill — Read file contents
  - [ ] `write` skill — Write/create files
  - [ ] `edit` skill — Edit existing files
  - [ ] `web_search` skill — Search the web (Brave API)
  - [ ] `telegram_send` skill — Send messages via Telegram
  - [ ] `memory_search` skill — Search conversation memory
  - [ ] `browser` skill — Web browsing and scraping

- [x] Kimi K2.5 thinking mode integration:
  - [x] Enable thinking mode via `enableThinking` flag
  - [x] Handle `reasoning_content` in responses
  - [x] Temperature constraints (1.0 for thinking, 0.6 for instant)
  - [x] Test end-to-end with complex reasoning tasks

- [ ] Simplified agent loop:
  - [ ] Load skill descriptions into system prompt
  - [ ] Agent outputs skill name + arguments
  - [ ] Execute skill's script with arguments
  - [ ] Return result to agent

### Out of Scope

- Agent swarms / multi-agent orchestration — complexity not needed for personal use, can add in future milestone
- Voice synthesis skills — keep existing TTS implementation for now
- UI/dashboard — CLI-first approach
- Custom training / fine-tuning — use off-the-shelf models

## Context

**Current State:**
The codebase has a working tool system (`src/tools/`) with 16 tool files and a skill system (`src/skills/`) that's partially implemented. Tools are TypeScript classes with hardcoded definitions. Skills are markdown files with YAML frontmatter that get loaded but currently defer to tools for execution.

**Target Architecture:**
- Remove the tool layer entirely
- Skills become the single abstraction for agent capabilities
- Each skill folder contains: `SKILL.md` (description + instructions) + `scripts/` (execution scripts)
- Agent reads skill descriptions at startup, includes them in system prompt
- When user request matches a skill's triggers/description, agent invokes that skill
- Skill execution runs the appropriate script from `scripts/` folder

**Research Findings (Skills Architecture Best Practices):**
- [Agent Skills Standard](https://medium.com/@richardhightower/agent-skills-the-universal-standard-transforming-how-ai-agents-work-fc7397406e2e): Open standard with SKILL.md + scripts structure
- [Claude Skills Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/): Progressive disclosure pattern—show descriptions first, load full instructions when needed
- Keep SKILL.md under 500 lines; use separate reference files for large content

**Research Findings (Kimi K2.5 Thinking Mode):**
- [Moonshot Platform Docs](https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model): Thinking mode returns `reasoning_content` field
- Temperature MUST be 1.0 for thinking mode, 0.6 for instant mode
- Response includes `<think>...</think>` delimiters in reasoning
- Supports 256K context, interleaved thinking with tool calls

## Constraints

- **TypeScript/Node.js**: Keep the existing runtime
- **Markdown Skills**: All skill definitions in `.md` files with YAML frontmatter

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Skills-only (no tools) | Simpler architecture, one abstraction for all capabilities | — Pending |
| Scripts in skill folders | Skills need to execute actions; scripts/ folder keeps code near definition | — Pending |
| Triggers + description in frontmatter | Agent needs to know WHEN to use a skill and WHAT it does | — Pending |
| Kimi K2.5 as thinking provider | Already integrated; best open reasoning model for complex tasks | Done - v2.0 |
| Kimi thinking mode | Better reasoning for complex tasks with temperature/param constraints | Done - v2.0 |

---
*Last updated: 2026-02-04 after Phase 17 completion*
