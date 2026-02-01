# LeanBot Development Milestones

> **Principle**: At the end of every milestone, everything works end-to-end. No half-built features.

## Overview

| Milestone | Name | Focus | Status |
|-----------|------|-------|--------|
| 1 | **MVP** | End-to-end working bot | ✅ Complete |
| 2 | **Smart Routing** | Cost efficiency | ✅ Complete |
| 3 | **Full Features** | Feature parity + extras | ✅ Complete |
| 4 | **Production Ready** | Polish & reliability | ✅ Complete |

---

## Milestone 1: MVP ✅

Working personal AI assistant via Telegram that executes tasks on VPS with session persistence.

- [x] **Project Setup**: TypeScript, pino logging, zod validation, Commander CLI, Vitest tests
- [x] **LLM Provider**: Anthropic with retry logic, token tracking, streaming support
- [x] **Core Tools**: Read, Write, Edit, Bash with full error handling
- [x] **Session Manager**: JSONL persistence, message history, token usage tracking
- [x] **Agent Runtime**: 20-iteration loop, tool execution, SOUL.md support
- [x] **Telegram Channel**: grammY bot, /start, /reset, markdown→HTML, message splitting
- [x] **Gateway Server**: Unified init, graceful shutdown (SIGTERM/SIGINT)

**Tests**: 101 passing | **Status**: Shipped

---

## Milestone 2: Smart Routing ✅

Cost efficiency through intelligent model selection and context management.

- [x] **Complexity Analyzer**: Tier detection (trivial/simple/moderate/complex), signals (tokens, code, keywords, tools)
- [x] **Multiple Providers**: OpenAI, Groq, Ollama (local), OpenRouter with health checking and fallback chain
- [x] **Cost Tracking**: Per-request tracking with model pricing, daily/monthly budgets with hard stops, 75% warning
- [x] **Sliding Window Context**: Hot window (5 messages) + warm summary, tool output truncation (30KB), auto-compress at 70%

**Tests**: 217 passing | **Status**: Shipped

---

## Milestone 3: Full Features ✅

Feature parity with alternatives plus LeanBot-specific enhancements.

- [x] **3.1 Additional Channels**: Discord with slash commands and mentions, CLI REPL with syntax highlighting
- [x] **3.2 Skill System**: SKILL.md parser with OpenClaw compatibility, ClawHub integration, lazy loading
- [x] **3.3 Cron Scheduler**: Unified system with built-in actions (ping, status, backup), channel-specific notifications
- [x] **3.4 Gardener Memory**: Hot collector, background gardener (fact extraction, summarization), hybrid search (BM25 + semantic)

**Tests**: 363 passing | **Status**: Shipped

---

## Milestone 4: Production Ready ✅

Polish, reliability, and deployment features.

- [x] **4.1 Caching**: Semantic response cache with TTL, tool output deduplication, write-through invalidation
- [x] **4.2 Session Branching**: Sub-conversations for investigation, summarize & merge/discard
- [x] **4.3 Dashboard & Deployment**: Cost dashboard CLI, systemd integration, crash recovery with resume/restart/abort
- [x] **4.4 Reliability**: Provider fallback chain with health tracking, budget guard with warnings, task queue, proactive notifications

**Tests**: 487 passing | **Status**: Shipped
