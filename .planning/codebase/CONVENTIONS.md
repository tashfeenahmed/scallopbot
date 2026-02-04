# Coding Conventions

**Analysis Date:** 2026-02-04

## Naming Patterns

**Files:**
- kebab-case for all files: `fact-extractor.ts`, `scallop-store.ts`, `message-send.ts`
- `.test.ts` alongside source files
- `index.ts` for barrel exports

**Functions:**
- camelCase for all functions: `loadConfig()`, `createDefaultToolRegistry()`
- Async functions: no special prefix
- Handlers: `handle{Event}` pattern

**Variables:**
- camelCase for variables: `sessionId`, `maxIterations`
- UPPER_SNAKE_CASE for constants: `DEFAULT_TIMEOUT`, `MAX_OUTPUT_SIZE`
- Private fields: no underscore prefix (TypeScript private)

**Types:**
- PascalCase for interfaces: `Tool`, `ToolContext`, `LLMProvider`
- No `I` prefix: `User` not `IUser`
- PascalCase for type aliases: `ContentBlock`, `CompletionResponse`

## Code Style

**Formatting:**
- 2-space indentation
- Double quotes for strings
- Semicolons required
- ~100 character line length

**Linting:**
- ESLint 9 with TypeScript ESLint (`eslint.config.js`)
- Unused vars with underscore allowed (`_param`)
- Explicit `any` allowed (for SDK flexibility)
- Run: `npm run lint`

## Import Organization

**Order:**
1. External packages (`import { z } from 'zod'`)
2. Internal modules (`import { Tool } from './types.js'`)
3. Type imports (`import type { Logger } from 'pino'`)

**Grouping:**
- Blank line between groups
- ESM with `.js` extensions for all relative imports

**Path Aliases:**
- No path aliases configured
- Use relative imports throughout

## Error Handling

**Patterns:**
- Throw errors at service level
- Catch at boundaries (agent, gateway)
- Use structured logging with context

**Error Types:**
- Descriptive Error messages: `throw new Error('Session not found: ${id}')`
- Include debugging context in errors
- Log before throwing when appropriate

## Logging

**Framework:**
- Pino logger (`src/utils/logger.ts`)
- Levels: trace, debug, info, warn, error, fatal

**Patterns:**
- Structured logging: `logger.info({ userId, action }, 'User action')`
- Log at service boundaries
- Use child loggers for context

**Guideline:**
- Use logger, not console.log (some legacy console usage exists)

## Comments

**When to Comment:**
- Explain why, not what
- Document complex algorithms
- JSDoc for exported functions

**JSDoc/TSDoc:**
- Required for public API functions
- Use `@param`, `@returns`, `@throws` tags
- Optional for internal functions

**Example from codebase:**
```typescript
/**
 * Brave Search API Tool
 *
 * Provides web search capability using the Brave Search API.
 * Much more reliable than browser-based searches (no CAPTCHAs).
 */
```

## Function Design

**Size:**
- Keep under 50 lines when possible
- Some large functions exist (agent loop, memory) - candidates for refactoring

**Parameters:**
- Max 3 parameters preferred
- Use options object for more: `function create(options: CreateOptions)`
- Destructure in parameter list

**Return Values:**
- Explicit return statements
- Return early for guard clauses
- Use Promise<T> for async

## Module Design

**Exports:**
- Named exports preferred
- Export from `index.ts` barrel files
- Keep internal helpers private

**Barrel Files:**
- `index.ts` re-exports public API
- Example: `src/providers/index.ts` exports all providers

**ESM Compatibility:**
- All imports use `.js` extension
- `"type": "module"` in package.json
- Dynamic imports for optional deps

---

*Convention analysis: 2026-02-04*
*Update when patterns change*
