# Phase 6: Telegram & Memory Skills - Research

**Researched:** 2026-02-04
**Domain:** Skill wrappers for existing Telegram and Memory implementations
**Confidence:** HIGH

<research_summary>
## Summary

Researched the existing codebase to determine how to wrap Telegram messaging and Memory search as skills. Both systems are already fully implemented in the codebase:

- **Telegram**: grammY-based TelegramChannel class with `sendMessage()` and `sendFile()` methods. Access is via callbacks passed to ToolRegistry, not direct singleton.
- **Memory**: MemoryStore + HybridSearch with BM25 + semantic search. Uses module-level singleton pattern with `initializeMemoryTools()`.

**Primary recommendation:** Create wrapper skills using the existing callback pattern for Telegram and singleton access for Memory. Follow the browser skill pattern (direct module import for singleton instances).
</research_summary>

<standard_stack>
## Standard Stack

### Core (Already Implemented)
| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| grammy | ^1.x | Telegram Bot API | In use at `src/channels/telegram.ts` |
| better-sqlite3 | ^9.x | Memory persistence | In use for ScallopMemory |

### Existing Implementations to Wrap
| Module | Location | Purpose | Skill Wrapper Pattern |
|--------|----------|---------|----------------------|
| TelegramChannel | `src/channels/telegram.ts` | Bot messaging | Via callback or gateway access |
| MemorySearchTool | `src/tools/memory.ts` | Hybrid search | Direct singleton import |
| MemoryGetTool | `src/tools/memory.ts` | Memory retrieval | Direct singleton import |
| HybridSearch | `src/memory/memory.ts` | BM25 + semantic | Via shared instance |

### No New Dependencies Required
All functionality exists. This phase is pure wrapper creation.
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Pattern 1: Singleton Access (Memory)

Memory tools use module-level singleton pattern:

```typescript
// src/tools/memory.ts - Existing pattern
let sharedMemoryStore: MemoryStore | null = null;
let sharedHybridSearch: HybridSearch | null = null;

export function initializeMemoryTools(store: MemoryStore, search?: HybridSearch): void {
  sharedMemoryStore = store;
  sharedHybridSearch = search || new HybridSearch({ store });
}

function getHybridSearch(): HybridSearch {
  if (!sharedHybridSearch) {
    sharedHybridSearch = new HybridSearch({ store: getMemoryStore() });
  }
  return sharedHybridSearch;
}
```

**Skill can import and use directly:**
```typescript
// memory_search skill
import { getHybridSearch } from '../../../tools/memory.js';

const search = getHybridSearch();
const results = search.search(query, { limit, type });
```

### Pattern 2: Callback Pattern (Telegram)

Telegram uses callback pattern through ToolRegistry:

```typescript
// Gateway passes callbacks to tool registry
this.toolRegistry = await createDefaultToolRegistry({
  messageSendCallback: async (userId: string, message: string) => {
    return this.handleMessageSend(userId, message);
  },
  fileSendCallback: async (userId: string, filePath: string, caption?: string) => {
    return this.handleFileSend(userId, filePath, caption);
  },
});
```

**Challenge:** Skills run as subprocess, can't access callbacks directly.

**Solution Options:**
1. **Create TelegramGateway singleton** - Module-level instance like BrowserSession
2. **IPC/HTTP bridge** - Skill calls local endpoint to trigger message
3. **Convert to SDK skill** - In-process execution with context access

### Pattern 3: SDK Skill (Recommended for Telegram)

SDK skills execute in-process and receive context:

```typescript
// src/skills/sdk.ts pattern
export interface SkillExecutionContext extends SkillContext {
  skillName: string;
  logger: Logger;
  parseArgs(): Record<string, string>;
}

export type SkillHandler = (context: SkillExecutionContext) => Promise<SkillResult>;
```

**For Telegram:** Define as SDK skill with messageSendCallback in context.

### Recommended Project Structure
```
src/skills/bundled/
├── telegram_send/
│   ├── SKILL.md           # Skill definition
│   └── scripts/
│       └── run.ts         # Uses gateway singleton or SDK pattern
├── memory_search/
│   ├── SKILL.md           # Skill definition
│   └── scripts/
│       └── run.ts         # Direct singleton import
```

### Anti-Patterns to Avoid
- **Don't create new memory system** - HybridSearch already has BM25 + semantic
- **Don't bypass callbacks for Telegram** - Use established patterns
- **Don't duplicate tool code** - Import and wrap existing tools
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Telegram messaging | New bot client | TelegramChannel.sendMessage() | Already handles formatting, splitting, errors |
| Semantic search | New embedding/search | HybridSearch class | BM25 + semantic combined, handles scoring |
| Memory filtering | Custom query logic | MemoryStore methods | Type filtering, session filtering built-in |
| Message formatting | HTML escape logic | formatMarkdownToHtml() | Handles edge cases, code blocks |
| Message splitting | Manual chunking | splitMessage() | Respects 4096 limit, preserves formatting |

**Key insight:** Both systems are production-tested. The skill layer should be a thin wrapper that:
1. Parses SKILL_ARGS
2. Calls existing methods
3. Formats output as JSON
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Subprocess Can't Access Gateway Instance
**What goes wrong:** Skill tries to import TelegramChannel but gateway instance isn't available in subprocess
**Why it happens:** Skills run via `spawn()` as isolated processes
**How to avoid:** Either (a) create singleton pattern or (b) use SDK skill pattern
**Warning signs:** "TelegramChannel not initialized" errors

### Pitfall 2: Memory Search Returns Empty
**What goes wrong:** HybridSearch returns nothing despite memories existing
**Why it happens:** Module-level singletons not initialized before skill runs
**How to avoid:** Ensure `initializeMemoryTools()` called during gateway init (already done)
**Warning signs:** "No memories found" when they should exist

### Pitfall 3: Telegram Message Truncation
**What goes wrong:** Long messages fail to send or get cut off
**Why it happens:** Telegram has 4096 char limit
**How to avoid:** Use existing `splitMessage()` function that handles chunking
**Warning signs:** Messages ending abruptly mid-word

### Pitfall 4: Search Type Confusion
**What goes wrong:** Search returns raw conversations instead of extracted facts
**Why it happens:** Default type not set correctly
**How to avoid:** Default to type='fact' (already default in MemorySearchTool)
**Warning signs:** Getting conversation logs instead of user facts
</common_pitfalls>

<code_examples>
## Code Examples

### Memory Search Skill Pattern
```typescript
// Source: Modeled on existing MemorySearchTool implementation
import { getHybridSearch, type SearchResult } from '../../../memory/index.js';

interface SearchArgs {
  query: string;
  type?: 'raw' | 'fact' | 'summary' | 'preference' | 'context' | 'all';
  subject?: string;
  limit?: number;
}

async function execute(args: SearchArgs): Promise<SkillResult> {
  const search = getHybridSearch();

  const type = args.type === 'all' ? undefined : (args.type || 'fact');
  const results = search.search(args.query, {
    limit: Math.min(args.limit || 10, 50),
    type,
    subject: args.subject,
    recencyBoost: true,
    userSubjectBoost: 1.5,
  });

  return {
    success: true,
    output: formatSearchResults(results),
    exitCode: 0,
  };
}
```

### Telegram Send - Gateway Singleton Pattern
```typescript
// Option 1: Create TelegramGateway singleton
// Similar to BrowserSession pattern

let instance: TelegramGateway | null = null;

export class TelegramGateway {
  private channel: TelegramChannel | null = null;

  static getInstance(): TelegramGateway {
    if (!instance) {
      instance = new TelegramGateway();
    }
    return instance;
  }

  setChannel(channel: TelegramChannel): void {
    this.channel = channel;
  }

  async sendMessage(chatId: string, message: string): Promise<boolean> {
    if (!this.channel) {
      throw new Error('Telegram channel not initialized');
    }
    await this.channel.sendMessage(chatId, message);
    return true;
  }
}
```

### Telegram Send - SDK Skill Pattern (Alternative)
```typescript
// Option 2: Define as SDK skill with callback access
import { defineSkill } from '../../../skills/sdk.js';

export const telegramSendSkill = defineSkill({
  name: 'telegram_send',
  description: 'Send message to Telegram user',

  async execute(context) {
    const args = context.parseArgs();
    const userId = args.user_id;
    const message = args.message;

    // SDK skills could have messageSendCallback in context
    if (!context.messageSendCallback) {
      return { success: false, output: '', error: 'Telegram not available', exitCode: 1 };
    }

    const success = await context.messageSendCallback(userId, message);
    return { success, output: success ? 'Message sent' : 'Failed', exitCode: success ? 0 : 1 };
  }
});
```
</code_examples>

<sota_updates>
## State of the Art (2024-2025)

| Aspect | Current Approach | Notes |
|--------|------------------|-------|
| Telegram Library | grammY | Modern, TypeScript-first, already in use |
| Search | BM25 + Semantic | Hybrid approach already implemented |
| Embeddings | Ollama/nomic-embed-text | Local embeddings if Ollama configured |
| Memory Storage | SQLite (ScallopMemory) | Upgraded from JSONL, in use |

**No ecosystem changes needed:**
- grammY is actively maintained and up-to-date
- Memory system is custom-built for this project
- No external services to worry about version drift
</sota_updates>

<open_questions>
## Open Questions

1. **Telegram skill access pattern**
   - What we know: TelegramChannel accessed via callbacks in ToolRegistry
   - What's unclear: Best pattern for skill subprocess to access
   - Recommendation: Create TelegramGateway singleton OR use SDK skill pattern

2. **Memory skill initialization timing**
   - What we know: `initializeMemoryTools()` called in gateway init
   - What's unclear: Whether subprocess inherits initialized state
   - Recommendation: Skill should fallback to creating new instances if not available
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `src/channels/telegram.ts` - TelegramChannel implementation
- `src/tools/memory.ts` - MemorySearchTool, MemoryGetTool implementations
- `src/gateway/gateway.ts` - Initialization and callback patterns
- `src/skills/bundled/browser/` - Reference skill pattern

### Secondary (MEDIUM confidence)
- `src/memory/memory.ts` - HybridSearch internals
- `src/skills/sdk.ts` - SDK skill pattern

### Tertiary (LOW confidence)
- None - all internal codebase analysis
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Existing Telegram and Memory implementations
- Ecosystem: N/A (internal wrappers)
- Patterns: Singleton access, callback patterns, SDK skills
- Pitfalls: Subprocess isolation, initialization timing

**Confidence breakdown:**
- Standard stack: HIGH - Already implemented and in use
- Architecture: HIGH - Clear patterns from browser skill
- Pitfalls: HIGH - Based on existing tool implementations
- Code examples: HIGH - Derived from existing code

**Research date:** 2026-02-04
**Valid until:** N/A (internal architecture, won't drift)
</metadata>

---

*Phase: 06-telegram-memory-skills*
*Research completed: 2026-02-04*
*Ready for planning: yes*
