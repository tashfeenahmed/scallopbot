# Phase 5: Browser Skill - Research

**Researched:** 2026-02-04
**Domain:** Browser automation skill wrapping existing Playwright implementation
**Confidence:** HIGH

<research_summary>
## Summary

This research confirms that Phase 5 does NOT require choosing a browser automation library or designing browser patterns from scratch. The codebase already has a **complete Playwright-based browser tool** at `src/tools/browser/` with:
- Session management (singleton pattern, lazy loading)
- Stealth mode (anti-bot detection evasion)
- Element reference system (snapshot → ref number → interact)
- All standard browser operations (navigate, click, type, fill, screenshot, extract, etc.)

The Phase 5 task is to **wrap this existing implementation as a skill**, following the established patterns from `bash` and `web_search` skills. This is a wrapper/adapter task, not a browser automation implementation task.

**Primary recommendation:** Create a thin skill wrapper that invokes the existing `BrowserSession` class, exposing the same operations via SKILL_ARGS input.
</research_summary>

<standard_stack>
## Standard Stack

Already established in codebase:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| playwright | ^1.50.0 | Browser automation | Already installed, used by existing browser tool |
| chromium (via playwright) | - | Headless browser | Playwright manages browser binaries |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino (Logger) | existing | Logging | Already integrated in session |

### Why Not Puppeteer
The codebase already uses Playwright. No reason to switch:
- Playwright is more modern (Acme Corp-maintained)
- Better API for modern web (auto-waits, better selectors)
- Already installed with stealth configuration

**No new dependencies needed** - this is a wrapper skill.
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Existing Browser Tool Architecture

The existing implementation at `src/tools/browser/` uses:

```
src/tools/browser/
├── browser.ts      # BrowserTool class - operations dispatcher
├── session.ts      # BrowserSession singleton - manages Playwright instance
├── types.ts        # TypeScript interfaces
└── browser.test.ts # Tests
```

**Key patterns:**
1. **Singleton Session** - `BrowserSession.getInstance()` ensures one browser per process
2. **Lazy Loading** - Browser only starts when first operation called
3. **Element Refs** - `snapshot()` assigns ref numbers, later operations use refs
4. **Stealth Mode** - Anti-detection: user agent rotation, webdriver removal, proxy support

### Skill Wrapper Pattern

Following `bash` and `web_search` skill patterns:

```
src/skills/bundled/browser/
├── SKILL.md           # Skill definition with operations documentation
└── scripts/
    └── run.ts         # Script that instantiates BrowserSession and runs operation
```

**run.ts pattern:**
```typescript
// Parse SKILL_ARGS
const args = JSON.parse(process.env.SKILL_ARGS);

// Create session with minimal config (no logger in standalone script)
const session = BrowserSession.getInstance({ headless: true });

// Route to appropriate method based on args.operation
switch (args.operation) {
  case 'navigate': await session.navigate(args.url); break;
  case 'snapshot': const snap = await session.snapshot(); break;
  // etc.
}

// Output JSON result
console.log(JSON.stringify({ success, output, exitCode }));
```

### Anti-Pattern: Re-implementing Browser Logic

**Don't rebuild** the existing BrowserSession. The skill script should:
- Import and use `BrowserSession` directly
- NOT duplicate navigation, clicking, typing logic
- NOT implement its own Playwright management

### Project Structure for Skill

```
src/skills/bundled/browser/
├── SKILL.md
└── scripts/
    └── run.ts    # Thin wrapper around existing BrowserSession
```
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Browser session management | New session manager | `BrowserSession` from `src/tools/browser/session.ts` | Already handles lazy init, singleton, cleanup |
| Stealth/anti-detection | Custom UA rotation, webdriver hiding | Existing stealth config in `BrowserSession` | Already tuned with proxy support |
| Element reference tracking | Custom ref system | `snapshot()` + `resolveTarget()` in existing session | Already works with CSS/text/ref selectors |
| Operations dispatch | Switch statement in skill | Could import existing BrowserTool logic | Operations already implemented |
| Error handling | Custom try/catch | Follow existing tool pattern | Consistent error format |

**Key insight:** This skill is a WRAPPER, not a reimplementation. The browser automation is done; we're just exposing it via skill interface.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Reimplementing Browser Logic
**What goes wrong:** Creating new Playwright code in skill script instead of using existing session
**Why it happens:** Not recognizing that browser tool already exists
**How to avoid:** Import `BrowserSession` from `src/tools/browser/session.ts`
**Warning signs:** Seeing `playwright.chromium.launch()` in skill script

### Pitfall 2: Missing Singleton Import
**What goes wrong:** Skill script can't find existing session class
**Why it happens:** Import path issues or module resolution
**How to avoid:** Use relative imports from skill script to tools: `../../../tools/browser/session.js`
**Warning signs:** Module not found errors

### Pitfall 3: Overcomplicating SKILL.md
**What goes wrong:** Duplicating all operation documentation in SKILL.md
**Why it happens:** Trying to be comprehensive
**How to avoid:** Keep SKILL.md under 500 lines; document common operations, link to full reference
**Warning signs:** SKILL.md becoming 1000+ lines

### Pitfall 4: Forgetting Browser Cleanup
**What goes wrong:** Browser process left running after skill completes
**Why it happens:** Skill script exits before closing browser
**How to avoid:** For one-shot operations, close browser; for stateful session, document that it persists
**Warning signs:** Orphan chromium processes
</common_pitfalls>

<code_examples>
## Code Examples

### Existing BrowserSession Usage (from browser.ts)

```typescript
// Source: src/tools/browser/browser.ts
const session = BrowserSession.getInstance({ logger: context.logger });

// Navigate
await session.navigate(url, { timeout: input.timeout as number });
const state = await session.getState();

// Snapshot - get interactable elements with ref numbers
const snapshot = await session.snapshot();
snapshot.elements.forEach(el => {
  // [ref] <tag> "text" type=...
});

// Click by ref, selector, or text
await session.click(5);  // Click element with ref 5
await session.click('#submit');  // CSS selector
await session.click('text=Login');  // Text selector

// Extract content
const text = await session.extractText();
const html = await session.extractHtml('#main');
```

### Skill Script Pattern (from web_search)

```typescript
// Source: src/skills/bundled/web_search/scripts/run.ts
interface SearchResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

function outputResult(result: SearchResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

// Parse SKILL_ARGS
const skillArgsJson = process.env.SKILL_ARGS;
if (!skillArgsJson) {
  outputResult({ success: false, output: '', error: 'SKILL_ARGS not set', exitCode: 1 });
}

// Execute and output
try {
  // ... do work ...
  outputResult({ success: true, output: result, exitCode: 0 });
} catch (error) {
  outputResult({ success: false, output: '', error: (error as Error).message, exitCode: 1 });
}
```

### Browser Skill run.ts Structure (planned)

```typescript
// Planned: src/skills/bundled/browser/scripts/run.ts
import { BrowserSession } from '../../../tools/browser/session.js';

interface BrowserArgs {
  operation: string;
  url?: string;
  target?: string | number;
  text?: string;
  // ... other params
}

// Parse and validate SKILL_ARGS
const args = parseArgs() as BrowserArgs;

// Get session (will create browser if needed)
const session = BrowserSession.getInstance({ headless: true });

// Route operation
switch (args.operation) {
  case 'navigate':
    await session.navigate(args.url!);
    outputResult({ success: true, output: `Navigated to ${args.url}`, exitCode: 0 });
    break;
  // ... other operations
}
```
</code_examples>

<sota_updates>
## State of the Art (2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Puppeteer | Playwright | 2022+ | Better API, auto-waits, better selector engine |
| Manual stealth patches | Built-in stealth mode | Already in codebase | Anti-bot evasion configured |

**No new patterns needed** - existing implementation is current.

**Playwright considerations for skill:**
- Playwright 1.50+ has full ESM support
- Dynamic import works (already used in session.ts via `safeImport`)
- No concerns with modern Node.js 18+
</sota_updates>

<open_questions>
## Open Questions

### 1. Session Persistence Across Skill Invocations
- **What we know:** BrowserSession is a singleton within a process
- **What's unclear:** When skill script runs as subprocess via SkillExecutor, each invocation may be a new process
- **Recommendation:** Check if SkillExecutor spawns new processes. If yes, browser state won't persist between calls. May need to document this limitation or adjust architecture.

### 2. Headless vs Headed Mode
- **What we know:** Session defaults to headless, but supports `headless: false`
- **What's unclear:** Should skill expose this option? Useful for debugging but potentially confusing
- **Recommendation:** Default headless, possibly add `headless` param for debugging

### 3. Operation Subset
- **What we know:** Existing tool has 15+ operations
- **What's unclear:** Should skill expose ALL operations or a curated subset?
- **Recommendation:** Start with core operations (navigate, snapshot, click, type, fill, extract, screenshot, close). Add more if needed.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `src/tools/browser/browser.ts` - Existing browser tool implementation
- `src/tools/browser/session.ts` - BrowserSession singleton manager
- `src/tools/browser/types.ts` - TypeScript interfaces
- `src/skills/bundled/bash/SKILL.md` - Skill pattern reference
- `src/skills/bundled/web_search/scripts/run.ts` - Script pattern reference

### Secondary (MEDIUM confidence)
- `package.json` - Playwright version (^1.50.0)
- `.planning/PROJECT.md` - Project architecture

### Tertiary (LOW confidence - needs validation)
- None - all findings from existing codebase
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Playwright (already integrated)
- Ecosystem: N/A (wrapper skill)
- Patterns: Skill wrapper around existing tool
- Pitfalls: Avoiding reimplementation

**Confidence breakdown:**
- Standard stack: HIGH - already in codebase
- Architecture: HIGH - follows established skill patterns
- Pitfalls: HIGH - based on codebase analysis
- Code examples: HIGH - from existing code

**Research date:** 2026-02-04
**Valid until:** N/A (internal codebase analysis, not external research)
</metadata>

---

*Phase: 05-browser-skill*
*Research completed: 2026-02-04*
*Ready for planning: yes*
