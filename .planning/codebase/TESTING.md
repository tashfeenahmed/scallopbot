# Testing Patterns

**Analysis Date:** 2026-02-04

## Test Framework

**Runner:**
- Vitest 2.0.x
- Config: `vitest.config.ts` in project root

**Assertion Library:**
- Vitest built-in expect
- Matchers: toBe, toEqual, toThrow, toMatchObject

**Run Commands:**
```bash
npm test                              # Run all tests
npm test -- --watch                   # Watch mode
npm test -- path/to/file.test.ts     # Single file
npm run test:coverage                 # Coverage report
```

## Test File Organization

**Location:**
- `*.test.ts` alongside source files (co-located)
- No separate `tests/` directory

**Naming:**
- `module-name.test.ts` for all tests
- Example: `src/config/config.test.ts`, `src/memory/embeddings.test.ts`

**Structure:**
```
src/
  config/
    config.ts
    config.test.ts
  memory/
    memory.ts
    embeddings.ts
    embeddings.test.ts
  tools/
    search.ts
    search.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ModuleName', () => {
  describe('functionName', () => {
    beforeEach(() => {
      // reset state
    });

    it('should handle valid input', () => {
      // arrange
      const input = createTestInput();

      // act
      const result = functionName(input);

      // assert
      expect(result).toEqual(expectedOutput);
    });

    it('should throw on invalid input', () => {
      expect(() => functionName(null)).toThrow('Invalid input');
    });
  });
});
```

**Patterns:**
- Use beforeEach for per-test setup
- Use afterEach to restore mocks: `vi.restoreAllMocks()`
- Arrange/act/assert structure
- One assertion focus per test

## Mocking

**Framework:**
- Vitest built-in mocking (`vi`)
- Module mocking via `vi.mock()` at top of test file

**Patterns:**
```typescript
import { vi } from 'vitest';

// Mock module
vi.mock('./external', () => ({
  externalFunction: vi.fn()
}));

// Mock in test
const mockFn = vi.mocked(externalFunction);
mockFn.mockReturnValue('mocked result');
```

**What to Mock:**
- External APIs (LLM providers, Brave Search)
- File system operations (fs)
- Child process execution
- Environment variables

**What NOT to Mock:**
- Internal pure functions
- Simple utilities
- TypeScript types

## Fixtures and Factories

**Test Data:**
```typescript
// Factory functions in test file
const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as unknown as Logger;

const createMockContext = (): ToolContext => ({
  workspace: '/test',
  sessionId: 'test-session',
  logger: createMockLogger(),
});
```

**Location:**
- Factory functions: define in test file near usage
- Mock providers: create inline with `vi.fn()`

## Coverage

**Requirements:**
- No enforced coverage target
- Coverage tracked for awareness
- Focus on critical paths

**Configuration:**
- V8 provider via Vitest
- Reports: text, json, html
- Excludes: node_modules, dist, *.test.ts

**View Coverage:**
```bash
npm run test:coverage
open coverage/index.html
```

## Test Types

**Unit Tests:**
- Test single function in isolation
- Mock all external dependencies
- Fast: each test <100ms
- Location: Co-located with source

**Integration Tests:**
- Test multiple modules together
- Mock only external boundaries
- Example: `src/agent/agent.test.ts`

**E2E Tests:**
- Not currently implemented
- CLI integration tested manually

## Common Patterns

**Async Testing:**
```typescript
it('should handle async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBe('expected');
});
```

**Error Testing:**
```typescript
it('should throw on invalid input', () => {
  expect(() => parse(null)).toThrow('Cannot parse null');
});

// Async error
it('should reject on file not found', async () => {
  await expect(readConfig('invalid.txt')).rejects.toThrow('ENOENT');
});
```

**Mock Provider Pattern:**
```typescript
function createMockProvider(responses: CompletionResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    isAvailable: () => true,
    complete: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex];
      callIndex++;
      return response;
    }),
  };
}
```

**Snapshot Testing:**
- Not used in this codebase
- Prefer explicit assertions

## Test Coverage Gaps

**Untested Critical Code:**
- `src/dashboard/dashboard.ts` - systemd integration
- `src/tools/bash.ts` - command execution
- `src/channels/api.ts` - HTTP API
- `src/memory/db.ts` - database operations

**Statistics:**
- 44 test files
- 111 source files
- ~40% file coverage by count

---

*Testing analysis: 2026-02-04*
*Update when test patterns change*
