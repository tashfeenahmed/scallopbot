# Codebase Concerns

**Analysis Date:** 2026-02-04

## Tech Debt

**Large files needing refactoring:**
- Issue: Multiple files exceed 800 lines, making them hard to maintain
- Files:
  - `src/memory/memory.ts` (1513 lines) - Memory system with mixed concerns
  - `src/channels/telegram.ts` (1088 lines) - Telegram handler
  - `src/agent/agent.ts` (888 lines) - Core agent loop
  - `src/memory/db.ts` (808 lines) - Database layer
  - `src/memory/fact-extractor.ts` (797 lines) - Fact extraction
- Impact: Difficult to test, maintain, and reason about
- Fix approach: Extract focused modules, separate concerns

**Console logging instead of structured logger:**
- Issue: Some files use console.log/console.error instead of pino logger
- Files:
  - `src/providers/moonshot.ts` (lines 107, 141, 147, 155, 172, 206)
  - `src/tools/reminder.ts` (line 318)
  - `src/memory/migrate.ts` (lines 243-265)
  - `src/cli.ts` (lines 48, 75)
- Impact: Inconsistent logging, harder production debugging
- Fix approach: Replace with `context.logger` or module-level logger

## Known Bugs

**No critical bugs identified.**

The codebase is generally stable with proper error handling in critical paths.

## Security Considerations

**Hardcoded service name in systemd commands:**
- Risk: Shell injection if serviceName contains special characters
- File: `src/dashboard/dashboard.ts` (lines 262, 266, 269, 284, 287, 290, 293)
- Current mitigation: serviceName is internally controlled
- Recommendation: Sanitize serviceName before shell interpolation

**Missing JSON.parse error handling:**
- Risk: Crash on malformed LLM responses
- Files:
  - `src/memory/relation-classifier.ts` (lines 350, 390, 431)
  - `src/memory/fact-extractor.ts` (lines 740, 783)
  - `src/memory/migrate.ts` (line 132)
- Current mitigation: Some calls wrapped in try/catch, others not
- Recommendation: Wrap all JSON.parse in try/catch with fallback

**Dynamic import for optional dependencies:**
- File: `src/utils/dynamic-import.ts`
- Current mitigation: Whitelist of allowed modules
- Status: Properly secured, but uses Function constructor internally

## Performance Bottlenecks

**Repeated regex pattern execution:**
- Problem: Multiple regex loops on same text in fact extraction
- File: `src/memory/memory.ts` (lines 366-546)
- Measurement: ~10 separate regex loops per message
- Cause: Sequential pattern matching without consolidation
- Improvement: Single pass with combined patterns or object extraction

**Potential N+1 query pattern:**
- Problem: Separate queries for read and update operations
- File: `src/memory/db.ts` (lines 299-300)
- Pattern: `getMemory()` → check → `updateMemory()` = 2 queries
- Improvement: Combine into single UPDATE with conditional logic

**Browser singleton bottleneck:**
- Problem: Single browser instance for all requests
- File: `src/tools/browser/session.ts` (lines 42, 65-69)
- Cause: Singleton pattern serializes browser operations
- Improvement: Connection pool or async queue

## Fragile Areas

**Authentication middleware chain:**
- File: Not applicable - no middleware chain
- Note: Each channel handles auth independently

**Stripe/payment webhooks:**
- Not applicable - no payment integration

## Scaling Limits

**SQLite concurrent access:**
- Current capacity: Single-writer, multiple-reader
- File: `src/memory/db.ts` (line 142)
- Limit: File-based SQLite not ideal for high concurrency
- Symptoms: Lock contention with multiple agents
- Scaling: Consider PostgreSQL for multi-instance deployment

**In-memory caching:**
- Current: Simple Map-based cache (`src/cache/cache.ts`)
- Limit: Per-process, no sharing between instances
- Scaling: Add Redis for distributed caching if needed

## Dependencies at Risk

**None identified as critical risk.**

All major dependencies are actively maintained:
- grammy, discord.js - Active communities
- better-sqlite3 - Well-maintained
- Vitest - Modern, active development

## Missing Critical Features

**Graceful shutdown handlers:**
- Problem: No cleanup hooks for timers/processes
- File: `src/memory/memory.ts` (line 672-674)
- Current workaround: Relies on process termination
- Impact: Timers could leak in long-running processes
- Implementation: Add SIGTERM/SIGINT handlers

## Test Coverage Gaps

**Untested critical paths:**
- `src/dashboard/dashboard.ts` - systemd integration (most dangerous code)
  - Risk: Service management could fail silently
  - Priority: High
  - Difficulty: Requires mocking systemd commands

- `src/tools/bash.ts` - Shell command execution
  - Risk: Command injection, execution failures
  - Priority: High
  - Difficulty: Medium - mock child_process

- `src/channels/api.ts` - HTTP API endpoint
  - Risk: Auth bypass, input validation issues
  - Priority: High
  - Difficulty: Medium - mock HTTP server

- `src/memory/db.ts` - Database operations
  - Risk: Data corruption, query failures
  - Priority: Medium
  - Difficulty: Medium - use test database

**Statistics:**
- 44 test files for 111 source files
- Critical gaps in infrastructure code

---

*Concerns audit: 2026-02-04*
*Update as issues are fixed or new ones discovered*
