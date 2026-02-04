# Architecture

**Analysis Date:** 2026-02-04

## Pattern Overview

**Overall:** Modular Layered Architecture with Provider Abstraction

**Key Characteristics:**
- Multi-provider LLM support (7 providers)
- Multi-channel communication (6+ platforms)
- Agentic tool execution loop
- Persistent semantic memory system
- Cost-aware intelligent routing

## Layers

**Channel Layer** (`src/channels/`):
- Purpose: Communication interface adapters
- Contains: Platform-specific message handling
- Depends on: Gateway for message routing
- Used by: External messaging platforms

**Gateway Layer** (`src/gateway/`):
- Purpose: Central orchestrator
- Contains: Session management, subsystem initialization
- Depends on: All other layers
- Used by: Channel layer

**Routing Layer** (`src/routing/`):
- Purpose: Intelligent LLM provider selection
- Contains: Complexity analysis, cost tracking, context management
- Depends on: Provider layer
- Used by: Agent layer

**Agent Layer** (`src/agent/`):
- Purpose: Agentic processing with tool use
- Contains: Agent loop, session state, recovery
- Depends on: Tools, Providers, Memory
- Used by: Gateway

**Tool Layer** (`src/tools/`):
- Purpose: Executable capabilities for agent
- Contains: File ops, bash, browser, search, memory
- Depends on: Utilities, external services
- Used by: Agent during tool execution

**Memory Layer** (`src/memory/`):
- Purpose: Persistent semantic memory
- Contains: SQLite store, embeddings, fact extraction
- Depends on: Database, LLM for extraction
- Used by: Agent for context retrieval

**Provider Layer** (`src/providers/`):
- Purpose: LLM backend abstraction
- Contains: Unified interface, 7 implementations
- Depends on: External LLM APIs
- Used by: Agent, Routing

## Data Flow

**Message Processing:**

1. User sends message (Telegram/Discord/CLI)
2. Channel parses and forwards to Gateway
3. Gateway creates/resumes session
4. Router analyzes complexity, selects provider
5. Agent sends to LLM with tool definitions
6. [Tool Loop] Execute tools, return results
7. CostTracker records usage
8. Memory stores context and extracts facts
9. Channel sends response to user

**State Management:**
- Sessions: JSONL files with thread-safe locking (`src/agent/session.ts`)
- Memory: SQLite database with WAL mode (`src/memory/db.ts`)
- Config: Zod-validated environment variables

## Key Abstractions

**LLMProvider** (`src/providers/types.ts`):
- Purpose: Unified interface for all LLM backends
- Examples: `AnthropicProvider`, `OpenAIProvider`, `GroqProvider`, `OllamaProvider`
- Pattern: Strategy pattern for swappable providers

**Tool** (`src/tools/types.ts`):
- Purpose: Executable capability for agent
- Examples: `BashTool`, `ReadTool`, `BrowserTool`, `MemorySearchTool`
- Pattern: Command pattern with unified execute interface

**Channel** (`src/channels/types.ts`):
- Purpose: Platform communication adapter
- Examples: `TelegramChannel`, `DiscordChannel`, `CLIChannel`
- Pattern: Adapter pattern for messaging platforms

**MemoryStore** (`src/memory/memory.ts`):
- Purpose: Semantic memory with search
- Examples: `HotCollector`, `HybridSearch`, `BackgroundGardener`
- Pattern: Repository pattern with hybrid retrieval

## Entry Points

**CLI Entry** (`src/cli.ts`):
- Location: `src/cli.ts`
- Triggers: `npm start`, `npm run dev`
- Commands: `start` (gateway server), `chat` (interactive REPL)

**Library Entry** (`src/index.ts`):
- Location: `src/index.ts`
- Triggers: Import as library
- Responsibilities: Export public API

## Error Handling

**Strategy:** Throw errors, catch at boundaries with structured logging

**Patterns:**
- Services throw descriptive errors
- Agent catches and logs with context
- Graceful degradation via `RecoveryManager`
- Provider fallback on failure

## Cross-Cutting Concerns

**Logging:**
- Pino logger with structured JSON output (`src/utils/logger.ts`)
- Log levels: trace, debug, info, warn, error, fatal

**Validation:**
- Zod schemas at config boundary
- Tool input validation per tool
- Session state validation

**Cost Tracking:**
- Per-request token counting
- Daily/monthly budget enforcement
- Provider-specific pricing

---

*Architecture analysis: 2026-02-04*
*Update when major patterns change*
