# LeanBot

**The token-efficient AI agent that doesn't burn your wallet.**

LeanBot is a next-generation personal AI assistant architecture designed from the ground up for **minimal token consumption**, **intelligent cost management**, and **superior context handling**. Built as a response to the token-burning inefficiencies of existing solutions.

---

## Why LeanBot?

| Problem with Current Solutions | LeanBot's Answer |
|-------------------------------|------------------|
| $30-200/day token costs | Smart routing cuts costs 70-85% |
| Full history sent every request | Sliding window + semantic compression |
| No cost visibility until bill arrives | Real-time token/cost dashboard |
| Same expensive model for all tasks | Tiered model routing by complexity |
| Bloated session transcripts | Structured atomic memory |
| Sandboxed/restricted by default | Full user-level VPS access |
| Complex Docker setup required | Single binary + systemd |
| Tool outputs accumulate forever | Aggressive output truncation + caching |

---

## Core Philosophy

```
         LEAN                    ECONOMICAL                 SMART
    ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
    │ 4 Core Tools│          │ Cost-First  │          │ Context-    │
    │ Minimal Deps│          │ Architecture│          │ Aware       │
    │ Small Binary│          │ Token Budget│          │ Decisions   │
    └─────────────┘          └─────────────┘          └─────────────┘
```

1. **Lean**: Minimal core (Read, Write, Edit, Bash). Everything else is a skill.
2. **Economical**: Every architectural decision optimizes for token efficiency.
3. **Smart**: The system makes intelligent decisions about what context to keep, what model to use, and when to cache.

---

## Design Decisions

### Single User
LeanBot is a **personal** assistant for one user. No multi-tenancy, no shared sessions, no team features. Your VPS, your agent, your data.

### Channel Handling
Same as OpenClaw: channels run **simultaneously**, routing per-chat. Messages from Telegram and Discord are handled in parallel - no priority queue, no blocking.

### Full Access, No Confirmation Gates
LeanBot has **unrestricted access** to your VPS. No "are you sure?" prompts, no approval workflows, no restricted commands. It executes what you ask, immediately.

Why? Confirmation gates kill the "autonomous agent" value prop. If you wanted to approve everything, you'd just do it yourself.

### Degraded Mode (When Budget/API Exhausted)
When API keys hit rate limits or budget runs out:

```
┌─────────────────────────────────────────────────────────────────┐
│                     DEGRADATION LADDER                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Primary model rate-limited                                  │
│     → Fall back to next provider in chain                       │
│                                                                 │
│  2. All cloud providers exhausted                               │
│     → Fall back to local model (Ollama) if configured           │
│                                                                 │
│  3. Daily budget hit                                            │
│     → Notify user, queue non-urgent tasks                       │
│     → Continue urgent tasks with cheapest available model       │
│                                                                 │
│  4. Hard budget limit hit                                       │
│     → Notify user, pause all tasks                              │
│     → Resume on budget reset or manual override                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Response Style
**Configurable by user during onboarding.** Options:

| Style | Description |
|-------|-------------|
| `terse` | Minimal output. Just results, no explanation. |
| `balanced` | Brief context + results. Default. |
| `verbose` | Full explanation of what was done and why. |

```bash
leanbot config set response.style balanced
```

### Memory Retention
Same as OpenClaw: **indefinite**. `MEMORY.md` persists forever unless manually cleared.

- Daily logs: `memory/YYYY-MM-DD.md` (kept indefinitely)
- Long-term: `MEMORY.md` (never auto-deleted)
- Sensitive data: User responsibility to manage

```bash
# Manual cleanup if needed
leanbot memory clear --before 2025-01-01
leanbot memory forget "password for X"
```

### Proactive Notifications
LeanBot messages you proactively for:

| Event | Notification |
|-------|--------------|
| Cron job completed | Yes (unless `silent: true`) |
| Cron job failed | Always |
| Task completed | Yes |
| Error occurred | Always |
| Budget warning (75%) | Yes |
| Budget exhausted | Always |

Default channel: the one you used most recently. Override with:
```yaml
notifications:
  default_channel: telegram
  urgent_channel: telegram  # For errors, budget alerts
```

### Recovery from Failure
**Ask user on restart.** If LeanBot crashes mid-task:

```
┌─────────────────────────────────────────────────────────────────┐
│  LeanBot was interrupted during a task.                         │
│                                                                 │
│  Task: "Deploy new version to production"                       │
│  Progress: 3/5 steps completed                                  │
│  Last action: "docker build completed"                          │
│                                                                 │
│  What would you like to do?                                     │
│  [1] Resume from where I left off                               │
│  [2] Start over                                                 │
│  [3] Abort and show me what was done                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Bundled Skills

LeanBot ships with OpenClaw-compatible core tools plus the top community skills.

### Core Tools (Always Available)

| Tool | Description |
|------|-------------|
| `read` | Read files |
| `write` | Write files |
| `edit` | Edit files |
| `bash` | Execute shell commands |
| `browser` | Playwright-based browser automation |
| `memory_search` | Search long-term memory |
| `memory_get` | Retrieve specific memories |

### Bundled Skills (Top Categories from ClawHub)

Based on ClawHub's most popular categories (700+ community skills):

| Category | Bundled Skills |
|----------|----------------|
| **Search & Research** | `brave-search`, `tavily`, `perplexity` |
| **DevOps & Cloud** | `vercel`, `cloudflare`, `kubernetes`, `docker` |
| **Productivity** | `linear`, `todoist`, `notion`, `obsidian` |
| **Communication** | `discord`, `slack`, `telegram-tools` |
| **Coding** | `github`, `gitlab`, `coding-agent` |
| **AI & LLMs** | `openai-docs`, `anthropic-docs` |
| **Media** | `spotify`, `youtube-tools` |
| **Smart Home** | `home-assistant` |

### Install More from ClawHub

```bash
# Search
leanbot skill search "kubernetes"

# Install
leanbot skill install clawhub:kubernetes
leanbot skill install clawhub:home-assistant
leanbot skill install github:user/custom-skill

# List installed
leanbot skill list
```

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              LEANBOT CORE                                   │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        SMART ROUTER                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │ Complexity  │  │   Model     │  │   Cost      │  │  Fallback   │  │  │
│  │  │  Analyzer   │→ │  Selector   │→ │  Guardian   │→ │   Chain     │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    ↓                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      CONTEXT ENGINE                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │  Sliding    │  │  Semantic   │  │   Tool      │  │  Response   │  │  │
│  │  │  Window     │  │ Compressor  │  │  Truncator  │  │   Cache     │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    ↓                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                       MEMORY SYSTEM                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │   Hot       │  │  Gardener   │  │  Structured │  │   Hybrid    │  │  │
│  │  │  Collector  │→ │  (Async)    │→ │   Facts     │  │   Search    │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    ↓                                        │
│     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│     │  Channels   │  │   Skills    │  │  Providers  │  │   Budget    │     │
│     │  (I/O)      │  │  (Actions)  │  │  (LLMs)     │  │  (Tracker)  │     │
│     └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Innovations

### 1. Tiered Model Routing (70-85% Cost Reduction)

LeanBot analyzes every request and routes to the cheapest capable model:

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPLEXITY ANALYZER                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Input: "What time is it?"                                      │
│  Complexity: TRIVIAL → Route to: Local/Free Model               │
│                                                                 │
│  Input: "Summarize this email"                                  │
│  Complexity: SIMPLE → Route to: Haiku/GPT-4o-mini ($0.25/1M)   │
│                                                                 │
│  Input: "Review this code for bugs"                             │
│  Complexity: MODERATE → Route to: Sonnet/GPT-4o ($3/1M)        │
│                                                                 │
│  Input: "Architect a distributed system for..."                 │
│  Complexity: COMPLEX → Route to: Opus/GPT-4 ($15/1M)           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Complexity Signals:**
- Token count of input
- Presence of code blocks
- Keywords: "analyze", "architect", "design", "compare", "debug"
- Required tools (browser = higher, file read = lower)
- Historical accuracy for similar queries

### 2. Sliding Window Context (Not Full History)

Unlike OpenClaw which sends **entire conversation history** with every request:

```
OpenClaw Approach (Expensive):
├── Message 1 (500 tokens)
├── Message 2 (800 tokens)
├── Message 3 (1200 tokens)
├── ... (accumulates forever)
├── Message 50 (600 tokens)
└── Total: 45,000 tokens PER REQUEST ❌

LeanBot Approach (Efficient):
├── System prompt (500 tokens)
├── Compressed summary of old context (200 tokens)
├── Last 5 relevant messages (2000 tokens)
├── Current message (600 tokens)
└── Total: 3,300 tokens PER REQUEST ✓
```

**Context Strategy:**
- **Hot window**: Last N messages (configurable, default 5)
- **Warm summary**: Semantic compression of older context
- **Cold storage**: Full history on disk, retrieved on-demand via search
- **Tool outputs**: Truncated aggressively, cached for re-retrieval

### 3. Gardener Memory Architecture

Two-phase memory processing inspired by how humans consolidate memories:

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: COLLECTOR (Hot Path - During Conversation)            │
├─────────────────────────────────────────────────────────────────┤
│  • Append raw interactions to daily log                         │
│  • Minimal processing overhead                                  │
│  • Format: memory/YYYY-MM-DD.jsonl                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓ (Async, background)
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: GARDENER (Cold Path - Background Process)             │
├─────────────────────────────────────────────────────────────────┤
│  • Decompose logs into atomic facts                             │
│  • Build bidirectional links between facts                      │
│  • Generate summaries at multiple granularities                 │
│  • Prune redundant/outdated information                         │
│  • Update structured knowledge files                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  STRUCTURED KNOWLEDGE (Queryable)                               │
├─────────────────────────────────────────────────────────────────┤
│  facts/                                                         │
│  ├── entities.json      # People, projects, tools mentioned     │
│  ├── preferences.json   # User preferences & settings           │
│  ├── decisions.json     # Decisions made with rationale         │
│  └── learnings.json     # What worked, what didn't              │
│                                                                 │
│  summaries/                                                     │
│  ├── daily/            # Daily interaction summaries            │
│  ├── weekly/           # Weekly rollups                         │
│  └── topics/           # Topic-based summaries                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Aggressive Tool Output Management

Tool outputs are the #1 cause of token bloat. LeanBot handles this:

```yaml
tool_output_policy:
  # Truncation
  max_output_tokens: 2000        # Hard cap per tool output
  truncation_strategy: "smart"   # Keep head + tail + summary

  # Caching
  cache_outputs: true
  cache_ttl: 3600                # 1 hour
  dedupe_identical: true         # Don't re-run same command

  # Replacement
  replace_old_outputs: true      # Old outputs become "[cached: hash]"
  on_demand_retrieval: true      # LLM can request full output if needed
```

**Before (OpenClaw):**
```
Tool: bash("cat package.json")
Output: [8,500 tokens of JSON, stays in context forever]
```

**After (LeanBot):**
```
Tool: bash("cat package.json")
Output: [500 token summary + hash reference]
Full output: [retrievable via `recall(hash)` if needed]
```

### 5. Real-Time Cost Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│  LEANBOT COST DASHBOARD                          Session #47    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Current Session:                                               │
│  ├── Tokens used: 12,450 (input: 10,200 | output: 2,250)       │
│  ├── Cost: $0.08                                                │
│  ├── Models used: haiku (85%), sonnet (15%)                    │
│  └── Cache hits: 23 (saved ~8,000 tokens)                      │
│                                                                 │
│  Today:                                                         │
│  ├── Total cost: $1.24                                          │
│  ├── Budget remaining: $3.76 / $5.00                           │
│  └── Projected monthly: $37.20                                  │
│                                                                 │
│  Savings vs naive approach: 78% ($4.40 saved today)            │
│                                                                 │
│  [!] Alert: Approaching daily budget (75%)                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6. Session Branching (Not Linear)

Inspired by Pi's tree-structured sessions:

```
Main conversation
│
├── User: "Help me debug this auth issue"
│   │
│   ├── [Branch A: Investigation]
│   │   ├── Read auth.ts
│   │   ├── Read middleware.ts
│   │   ├── Found: token expiry bug
│   │   └── [Summarize & merge back: "Found bug in auth.ts:45"]
│   │
│   └── Continue main with summary (not full branch context)
│
└── User: "Great, now fix it"
    └── [Has summary, not 5000 tokens of investigation]
```

**Benefits:**
- Debug/investigation branches don't pollute main context
- Failed attempts can be discarded entirely
- Summaries preserve knowledge without token cost

### 7. Skill Lazy-Loading

Skills are NOT loaded into context until needed:

```
OpenClaw: Load all 50 skill schemas at startup → 15,000 tokens wasted

LeanBot:
├── Core tools always loaded (Read, Write, Edit, Bash) → 400 tokens
├── Skill index loaded (name + 1-line description) → 200 tokens
├── Full skill loaded ON DEMAND when referenced → variable
└── Skill unloaded after use if context pressure high
```

### 8. Full ClawHub/OpenClaw Skill Compatibility

LeanBot is **100% compatible** with the OpenClaw/ClawHub skill ecosystem. Use any of the 100+ existing skills without modification.

```
┌─────────────────────────────────────────────────────────────────┐
│                    SKILL COMPATIBILITY LAYER                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │  ClawHub    │    │  OpenClaw   │    │  LeanBot    │         │
│  │  Registry   │ ←→ │  SKILL.md   │ ←→ │  Native     │         │
│  │  (Remote)   │    │  Format     │    │  Skills     │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                            ↓                                    │
│                 ┌─────────────────────┐                        │
│                 │  Unified Skill API  │                        │
│                 └─────────────────────┘                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Supported SKILL.md Format

LeanBot parses the standard OpenClaw skill format:

```yaml
# skills/my-skill/SKILL.md
---
name: my-skill
description: What this skill does
homepage: https://example.com
user-invocable: true
disable-model-invocation: false
metadata: {"openclaw":{"emoji":"🔧","requires":{"bins":["jq"],"env":["API_KEY"]},"os":["darwin","linux"]}}
---

## Instructions for the agent

When the user asks to [do something], use this skill to...

## Tools

- `my_tool`: Does X with arguments Y
```

#### Skill Sources (Precedence Order)

```
1. Workspace skills     ~/.leanbot/workspace/skills/    (highest)
2. User skills          ~/.leanbot/skills/
3. ClawHub installed    ~/.leanbot/clawhub/
4. Bundled skills       (built into binary)             (lowest)
```

#### ClawHub Integration

```bash
# Search ClawHub registry
leanbot skill search "browser automation"

# Install from ClawHub
leanbot skill install clawhub:browser-pilot
leanbot skill install clawhub:gmail-assistant
leanbot skill install clawhub:calendar-sync

# Install from GitHub
leanbot skill install github:user/repo

# List installed skills
leanbot skill list

# Update all skills
leanbot skill update
```

#### Gating & Requirements

LeanBot respects OpenClaw's gating system:

```yaml
metadata:
  openclaw:
    requires:
      bins: ["ffmpeg", "jq"]      # Required CLI tools
      anyBins: ["chrome", "chromium"]  # At least one required
      env: ["OPENAI_API_KEY"]     # Required env vars
      config: ["browser.enabled"] # Required config keys
    os: ["darwin", "linux"]       # Platform restrictions
    install:                      # Auto-install instructions
      - type: brew
        package: ffmpeg
      - type: npm
        package: playwright
```

#### LeanBot Skill Enhancements

While maintaining compatibility, LeanBot adds:

| Feature | OpenClaw | LeanBot |
|---------|----------|---------|
| **Lazy loading** | Load all at startup | Load on-demand |
| **Cost hints** | None | `complexity: simple/moderate/complex` |
| **Token budget** | None | `max_tokens: 2000` per invocation |
| **Caching** | None | `cacheable: true` for deterministic skills |
| **Tier override** | None | `preferred_tier: moderate` forces routing |

Extended SKILL.md frontmatter (optional, backwards-compatible):

```yaml
---
name: my-lean-skill
description: A token-efficient skill
# Standard OpenClaw fields...

# LeanBot extensions (ignored by OpenClaw)
leanbot:
  complexity: simple              # Routing hint
  max_tokens: 1500               # Budget per invocation
  cacheable: true                # Cache identical invocations
  preferred_tier: simple         # Force cheap model
  lazy_deps: ["playwright"]      # Load these only when skill runs
---
```

#### Native LeanBot Skills

For maximum efficiency, write skills in LeanBot's native format:

```typescript
// skills/my-skill/index.ts
import { defineSkill } from '@leanbot/sdk';

export default defineSkill({
  name: 'my-skill',
  description: 'Does something efficiently',
  complexity: 'simple',
  cacheable: true,

  tools: [
    {
      name: 'my_tool',
      description: 'Does X',
      parameters: {
        input: { type: 'string', description: 'The input' }
      },
      execute: async ({ input }) => {
        // Implementation
        return { result: `Processed: ${input}` };
      }
    }
  ],

  // Optional: Instructions injected into prompt
  instructions: `
    When the user asks to do X, use my_tool with their input.
    Keep responses brief.
  `
});
```

### 9. Unified Cron (No Separate Heartbeats)

OpenClaw has both **cron jobs** AND **heartbeats**. LeanBot simplifies: **cron does everything**.

```
OpenClaw:
├── Cron system (scheduled tasks)
├── Heartbeat system (keep-alive, cache warming)  ← redundant
└── Two concepts to configure and debug

LeanBot:
└── Cron system (does both)  ← one concept
```

#### Cron Configuration

```yaml
cron:
  # Daily standup summary
  - name: "morning-briefing"
    schedule: "0 8 * * 1-5"           # 8 AM weekdays
    action: "Summarize my calendar and emails for today"
    channel: "telegram"                # Where to send output
    tier: "simple"                     # Use cheap model

  # Cache warming (replaces heartbeats)
  - name: "keepalive"
    schedule: "*/55 * * * *"          # Every 55 min
    action: "ping"                     # Built-in lightweight ping
    silent: true                       # No output to user

  # Weekly report
  - name: "weekly-review"
    schedule: "0 17 * * 5"            # Friday 5 PM
    action: "Review what I accomplished this week from memory"
    tier: "moderate"

  # Proactive monitoring
  - name: "inbox-check"
    schedule: "*/30 * * * *"          # Every 30 min
    action: "Check for urgent emails and notify me if any"
    condition: "only_if_urgent"        # Don't spam
```

#### Why No Heartbeats?

| Use Case | OpenClaw | LeanBot |
|----------|----------|---------|
| Cache warming | Heartbeat config | `cron: keepalive` |
| Health checks | Heartbeat config | `cron: ping` |
| Scheduled tasks | Cron config | `cron: *` |
| Keep-alive | Heartbeat config | `cron: keepalive` |

**One system. Fewer bugs. Less config. Lean.**

---

## Configuration

### SOUL.md (Identity)

```markdown
# soul.md - LeanBot Identity

## Core Values
- Efficiency over verbosity
- Actions over explanations
- Results over process narration

## Behavioral Rules
- Never say "I'd be happy to help" - just help
- Never explain what you're about to do - just do it
- If a task takes 1 tool call, don't use 5
- Prefer local/cached data over re-fetching
- Ask once, remember forever

## Token Discipline
- Responses under 200 tokens unless complexity demands more
- No filler phrases, no excessive politeness
- Code blocks over prose explanations
- Bullet points over paragraphs
```

### config.yaml

```yaml
leanbot:
  # Model Routing
  routing:
    strategy: "complexity-based"
    tiers:
      trivial:
        models: ["ollama/llama3", "groq/llama3"]
        max_tokens: 500
      simple:
        models: ["anthropic/haiku", "openai/gpt-4o-mini"]
        max_tokens: 2000
      moderate:
        models: ["anthropic/sonnet", "openai/gpt-4o"]
        max_tokens: 4000
      complex:
        models: ["anthropic/opus", "openai/gpt-4"]
        max_tokens: 8000

    # Fallback chain if primary fails
    fallback_order: ["anthropic", "openai", "groq", "ollama"]

  # Context Management
  context:
    max_tokens: 32000              # Hard limit
    hot_window_messages: 5         # Recent messages kept verbatim
    warm_summary_tokens: 500       # Compressed older context
    tool_output_max: 2000          # Per-output limit
    auto_compress_threshold: 0.7   # Compress at 70% capacity

  # Budget Controls
  budget:
    daily_limit: 5.00              # USD
    monthly_limit: 100.00
    warning_threshold: 0.75        # Alert at 75%
    hard_stop: true                # Stop at limit vs degrade

  # Memory
  memory:
    gardener_enabled: true
    gardener_interval: "5m"        # Process logs every 5 min
    fact_extraction: true
    summary_granularity: ["daily", "weekly", "topic"]

  # Caching
  cache:
    enabled: true
    response_ttl: 3600
    tool_output_ttl: 1800
    semantic_similarity_threshold: 0.92  # Cache hit threshold

  # Cron (replaces heartbeats - one unified system)
  cron:
    - name: "keepalive"
      schedule: "*/55 * * * *"         # Cache warming, replaces heartbeat
      action: "ping"
      silent: true
    - name: "morning-briefing"
      schedule: "0 8 * * 1-5"
      action: "Summarize my calendar for today"
      channel: "telegram"
      tier: "simple"
```

---

## Project Structure

```
leanbot/
├── src/
│   ├── core/
│   │   ├── agent.ts              # Main agent loop
│   │   ├── tools.ts              # Core 4 tools (Read, Write, Edit, Bash)
│   │   └── session.ts            # Session & branching management
│   │
│   ├── router/
│   │   ├── complexity.ts         # Complexity analyzer
│   │   ├── selector.ts           # Model selector
│   │   ├── fallback.ts           # Fallback chain handler
│   │   └── cost-guardian.ts      # Budget enforcement
│   │
│   ├── context/
│   │   ├── window.ts             # Sliding window manager
│   │   ├── compressor.ts         # Semantic compression
│   │   ├── truncator.ts          # Tool output truncation
│   │   └── cache.ts              # Response & output cache
│   │
│   ├── memory/
│   │   ├── collector.ts          # Hot path logging
│   │   ├── gardener.ts           # Async fact extraction
│   │   ├── facts.ts              # Structured fact storage
│   │   ├── search.ts             # Hybrid vector + BM25 search
│   │   └── summaries.ts          # Multi-granularity summaries
│   │
│   ├── channels/
│   │   ├── cli.ts                # Terminal interface
│   │   ├── api.ts                # REST/WebSocket API
│   │   ├── telegram.ts           # Telegram adapter
│   │   ├── discord.ts            # Discord adapter
│   │   └── whatsapp.ts           # WhatsApp adapter
│   │
│   ├── skills/
│   │   ├── loader.ts             # Lazy skill loader
│   │   ├── registry.ts           # Skill index
│   │   ├── clawhub.ts            # ClawHub registry client
│   │   ├── compat/               # OpenClaw compatibility layer
│   │   │   ├── parser.ts         # SKILL.md parser
│   │   │   ├── gating.ts         # Requirements checker
│   │   │   └── adapter.ts        # OpenClaw → LeanBot adapter
│   │   └── builtin/              # Built-in skills
│   │       ├── browser.ts
│   │       ├── calendar.ts
│   │       └── email.ts
│   │
│   ├── providers/
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── groq.ts
│   │   ├── ollama.ts
│   │   └── openrouter.ts
│   │
│   ├── budget/
│   │   ├── tracker.ts            # Real-time cost tracking
│   │   ├── dashboard.ts          # Cost visualization
│   │   └── alerts.ts             # Budget alerts
│   │
│   ├── cron/
│   │   ├── scheduler.ts          # Cron job scheduler
│   │   ├── runner.ts             # Job execution
│   │   └── builtins.ts           # Built-in actions (ping, etc.)
│   │
│   └── index.ts                  # Entry point
│
├── config/
│   ├── default.yaml              # Default configuration
│   └── soul.md                   # Default identity
│
├── skills/                       # User-installed skills
├── memory/                       # Memory storage
├── tests/
└── docs/
```

---

## LeanBot vs OpenClaw Comparison

| Feature | OpenClaw | LeanBot |
|---------|----------|---------|
| **Token Efficiency** | Poor (full history every request) | Excellent (sliding window + compression) |
| **Cost Visibility** | After the fact | Real-time dashboard |
| **Model Routing** | Manual config | Automatic by complexity |
| **Deployment** | Docker sandbox recommended | Full user-level access (VPS) |
| **Setup Complexity** | Docker + config files | Single binary + systemd |
| **Tool Output Handling** | Accumulates forever | Truncate + cache + retrieve |
| **Memory Architecture** | Append-only JSONL | Gardener (async fact extraction) |
| **Session Model** | Linear | Tree (branching) |
| **Skill Loading** | All at startup | Lazy on-demand |
| **Budget Controls** | External (API dashboard) | Built-in with hard stops |
| **Skill Ecosystem** | ClawHub only | ClawHub + native + enhanced |
| **Skill Cost Hints** | None | Built-in complexity routing |
| **Proactive Automation** | Cron + Heartbeats (two systems) | Cron only (unified) |
| **Estimated Daily Cost** | $30-200 | $3-15 (same usage) |

---

## Roadmap

### Phase 1: Core Engine
- [ ] Sliding window context manager
- [ ] Complexity analyzer
- [ ] Tiered model routing
- [ ] Basic cost tracking
- [ ] Core 4 tools

### Phase 2: Memory & Efficiency
- [ ] Gardener background process
- [ ] Structured fact extraction
- [ ] Hybrid search (vector + BM25)
- [ ] Response caching
- [ ] Tool output truncation & caching

### Phase 3: Channels & Skills
- [ ] CLI interface
- [ ] REST/WebSocket API
- [ ] Telegram adapter
- [ ] Skill lazy-loader
- [ ] OpenClaw SKILL.md parser & compatibility layer
- [ ] ClawHub registry client
- [ ] `leanbot skill install/search/update` commands
- [ ] Native LeanBot skill SDK
- [ ] Skill cost hints & routing integration

### Phase 4: Advanced Features
- [ ] Session branching
- [ ] Multi-agent orchestration
- [ ] Cron scheduler (replaces heartbeats - one concept, not two)
- [ ] Cost prediction & optimization suggestions

---

## Deployment Model: Full Machine Access

LeanBot is designed to run on a **VPS as a full user-level agent** - not sandboxed, not containerized. It has the same access you would have if you SSH'd into the machine.

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR VPS                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                     LEANBOT                              │   │
│   │                 (runs as user)                           │   │
│   └─────────────────────────────────────────────────────────┘   │
│                            │                                    │
│         ┌──────────────────┼──────────────────┐                │
│         ↓                  ↓                  ↓                │
│   ┌───────────┐     ┌───────────┐     ┌───────────┐           │
│   │  Files    │     │  Shell    │     │  Network  │           │
│   │  System   │     │  Commands │     │  Access   │           │
│   └───────────┘     └───────────┘     └───────────┘           │
│         ↓                  ↓                  ↓                │
│   ┌───────────┐     ┌───────────┐     ┌───────────┐           │
│   │  Cron     │     │  Docker   │     │  Services │           │
│   │  Jobs     │     │  (if any) │     │  & Daemons│           │
│   └───────────┘     └───────────┘     └───────────┘           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### What LeanBot Can Do

| Capability | Access Level |
|------------|--------------|
| Read/write files | Full (user-level) |
| Execute shell commands | Full (bash, zsh, etc.) |
| Install packages | Yes (apt, brew, npm, pip, etc.) |
| Manage services | Yes (systemctl, etc.) |
| Network operations | Full (curl, ssh, etc.) |
| Run Docker containers | Yes (if Docker installed) |
| Access databases | Yes (psql, mysql, redis-cli, etc.) |
| Manage cron jobs | Yes |
| Git operations | Full |

### Why Full Access?

LeanBot is your **digital employee**, not a sandboxed chatbot. It needs to:
- Deploy your code
- Manage your servers
- Run your scripts
- Access your databases
- Monitor your services

**Sandboxing defeats the purpose.** If you want a restricted assistant, use a chatbot.

---

## Quick Start

### VPS Deployment (Recommended)

```bash
# SSH into your VPS
ssh user@your-vps.com

# Install LeanBot
curl -fsSL https://leanbot.dev/install.sh | sh

# Initialize
leanbot init

# Configure API keys
leanbot config set anthropic.key sk-ant-xxx
leanbot config set openai.key sk-xxx

# Set daily budget
leanbot config set budget.daily 5.00

# Configure channels (how you'll talk to it)
leanbot channel add telegram --token YOUR_BOT_TOKEN
leanbot channel add discord --token YOUR_BOT_TOKEN

# Run as daemon (always-on)
leanbot daemon start

# Or run with systemd (auto-restart on reboot)
leanbot daemon install
sudo systemctl enable leanbot
sudo systemctl start leanbot
```

### Check Status

```bash
# View daemon status
leanbot daemon status

# View logs
leanbot logs

# View cost dashboard
leanbot budget

# Interactive CLI (for testing)
leanbot chat
```

### Local Development

```bash
# Run locally for development/testing
leanbot start

# Or CLI mode
leanbot chat
```

---

## Why "Lean"?

> "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away." - Antoine de Saint-Exupery

LeanBot applies lean principles to AI agents:
- **Eliminate waste**: Don't send tokens you don't need
- **Just-in-time**: Load skills and context only when needed
- **Continuous improvement**: Gardener constantly optimizes memory
- **Respect for resources**: Your money, your tokens, your control

---

## License

MIT

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**Core principle**: Every PR should reduce token usage or maintain it while adding features. PRs that increase baseline token consumption require strong justification.
