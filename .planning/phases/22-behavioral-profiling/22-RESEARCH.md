# Phase 22: Behavioral Profiling - Research

**Researched:** 2026-02-10
**Domain:** Implicit user signal extraction and behavioral profiling for personal AI agent
**Confidence:** HIGH

<research_summary>
## Summary

Researched how to extend the existing ProfileManager's behavioral patterns tier with richer implicit signal tracking. The system already has a solid three-tier profile (static/dynamic/behavioral) with incremental inference during deep ticks. Phase 22 adds four new signal types: message frequency tracking, session engagement patterns, topic switching detection, and response length evolution.

Key finding: This is an **extension of existing internal patterns**, not a new ecosystem. The existing `inferBehavioralPatterns()` already does incremental analysis with merge semantics. The new signals follow the same pattern: aggregate from session messages during deep tick, store in `behavioral_patterns` table, surface in LLM context. The main research-worthy insights are: (1) use exponential moving averages for temporal signal smoothing instead of raw counts, (2) detect topic switches via cosine similarity drops between consecutive message embeddings rather than heavy NLP, and (3) track engagement trends (increasing/decreasing/stable) not just raw values.

**Primary recommendation:** Extend the existing `BehavioralPatterns` interface and `inferBehavioralPatterns()` method with four new signal extractors. Use EMA for temporal smoothing. Detect topic switches via embedding similarity. Keep everything pure-function and testable following the v3.0 pattern.
</research_summary>

<standard_stack>
## Standard Stack

### Core (Already in Project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | existing | SQLite persistence | Already used for all memory/profile storage |
| ProfileManager | internal | Three-tier profile management | Existing class being extended |
| BackgroundGardener | internal | Tiered consolidation (light/deep tick) | Where behavioral inference runs |
| ScallopMemoryStore | internal | Memory with embeddings | Provides embeddings for topic similarity |

### Supporting (Already in Project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Embedding provider | existing | Generate embeddings | Topic switch detection via cosine similarity |
| SessionManager | internal | Session/message storage | Source of raw behavioral signals |

### New Dependencies Required
None. All signals can be computed from existing data (session messages, timestamps, embeddings) using pure math. No new libraries needed.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| EMA for smoothing | Simple moving average | EMA gives more weight to recent behavior, better for evolving users |
| Cosine similarity for topic switch | LLM-based topic classification | Cosine is free (embeddings already exist), LLM costs tokens per message |
| Extending behavioral_patterns table | New signals table | Separate table adds complexity; extending existing table is simpler |
| ProfiLLM-style LLM profiling | Pure algorithmic signals | LLM profiling is more nuanced but costs tokens on every message; save for future |

**Installation:**
```bash
# No new packages needed - extending existing system
```
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Recommended Approach: Extend Existing Pattern

The system already has a clear pattern for behavioral inference:
1. `inferBehavioralPatterns(userId, messages)` runs during deep tick
2. Processes new messages incrementally (tracks `lastAnalyzedCount`)
3. Merges with existing patterns
4. Stores via `updateBehavioralPatterns()`

Phase 22 follows this exactly — add new signal extractors to the same flow.

### Pattern 1: Pure Signal Extractor Functions
**What:** Each new signal type is a pure function that takes messages + existing state and returns updated signal values
**When to use:** All four new signal types
**Example:**
```typescript
// Pure function: extract message frequency signal
export function computeMessageFrequency(
  messages: Array<{ timestamp: number }>,
  existing: MessageFrequencySignal | null
): MessageFrequencySignal {
  // Count messages per day over recent window
  // Compute EMA-smoothed daily rate
  // Determine trend (increasing/decreasing/stable)
  return { dailyRate, weeklyRate, trend, updatedAt };
}

// Pure function: detect topic switches
export function computeTopicSwitchRate(
  messages: Array<{ content: string; embedding?: number[] }>,
  existing: TopicSwitchSignal | null
): TopicSwitchSignal {
  // Compare consecutive message embeddings via cosine similarity
  // Count similarity drops below threshold as topic switches
  // Compute switches-per-session ratio
  return { switchRate, avgTopicDepth, updatedAt };
}
```

### Pattern 2: EMA for Temporal Signal Smoothing
**What:** Use exponential moving average instead of raw counts for all temporal signals
**When to use:** Message frequency, session duration, response length — any signal that varies over time
**Why:** Raw averages treat a message from 30 days ago equally to one from today. EMA weights recent behavior more heavily, which is what we want for a personal assistant tracking evolving habits.
**Formula:**
```
EMA_new = α × value_current + (1 - α) × EMA_previous
```
Where α = 0.3 (standard smoothing factor for daily-scale behavioral signals). Higher α = more responsive to recent changes, lower α = smoother/slower adaptation.

For irregular time series (messages don't arrive at regular intervals), use the adjusted formula:
```
weight = 1 - exp(-Δt / halfLife)
EMA_new = weight × value_current + (1 - weight) × EMA_previous
```
Where halfLife controls how quickly old values fade (e.g., 7 days for weekly patterns).

### Pattern 3: Trend Detection via Linear Regression Sign
**What:** Compute a simple trend indicator (increasing/decreasing/stable) from windowed signal values
**When to use:** For surfacing actionable behavioral shifts (e.g., "user is becoming more active", "user is asking shorter questions")
**Example:**
```typescript
function detectTrend(recentValues: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (recentValues.length < 3) return 'stable';
  // Simple: compare first-half average to second-half average
  const mid = Math.floor(recentValues.length / 2);
  const firstHalf = average(recentValues.slice(0, mid));
  const secondHalf = average(recentValues.slice(mid));
  const delta = (secondHalf - firstHalf) / (firstHalf || 1);
  if (delta > 0.15) return 'increasing';
  if (delta < -0.15) return 'decreasing';
  return 'stable';
}
```

### Pattern 4: Embedding-Based Topic Switch Detection
**What:** Use cosine similarity between consecutive user messages to detect topic boundaries
**When to use:** Topic switch frequency signal
**Why:** Embeddings already exist in the memory system. Cosine similarity between consecutive messages is a cheap, effective proxy for topic continuity. A similarity drop below threshold (e.g., 0.3) indicates a topic switch.
**Example:**
```typescript
function detectTopicSwitches(
  messages: Array<{ embedding: number[] }>
): { switchCount: number; avgDepth: number } {
  let switches = 0;
  let currentTopicLength = 1;
  const topicLengths: number[] = [];

  for (let i = 1; i < messages.length; i++) {
    const sim = cosineSimilarity(messages[i - 1].embedding, messages[i].embedding);
    if (sim < 0.3) {
      switches++;
      topicLengths.push(currentTopicLength);
      currentTopicLength = 1;
    } else {
      currentTopicLength++;
    }
  }
  topicLengths.push(currentTopicLength);

  return {
    switchCount: switches,
    avgDepth: topicLengths.reduce((a, b) => a + b, 0) / topicLengths.length,
  };
}
```

### Anti-Patterns to Avoid
- **LLM-per-message profiling:** ProfiLLM-style approaches use LLM calls per message. Too expensive for a personal agent processing every message. Save LLM-based profiling for Phase 23 or future work.
- **Recomputing from all history:** The existing pattern processes only new messages and merges. Don't regress to full-history recomputation.
- **Over-granular storage:** Don't store per-message signal snapshots. Store aggregated signals per user with EMA smoothing.
- **Complex topic models:** Don't use LDA/BERTopic for topic switch detection. Cosine similarity between consecutive embeddings is sufficient and costs nothing.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Embedding generation | Custom embedding code | Existing embedding provider in ScallopMemoryStore | Embeddings already generated for memory storage |
| Cosine similarity | Custom vector math | Existing `cosineSimilarity()` in the codebase | Already implemented and tested |
| EMA computation | Complex stats library | Simple inline formula (~3 lines) | EMA is trivially implementable; no library needed |
| SQLite schema migration | Manual ALTER TABLE | Existing pattern in db.ts `initializeDatabase()` | Follow established migration pattern |
| Profile context formatting | New formatting system | Extend existing `formatProfileContext()` | Already handles static/dynamic/behavioral display |

**Key insight:** This phase is purely extending existing patterns. The ProfileManager, BackgroundGardener, and BehavioralPatterns infrastructure already exist. The work is adding new signal types to the existing pipeline, not building new infrastructure.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Forgetting Incremental Merge Semantics
**What goes wrong:** New signal extractors recompute from full history on every deep tick
**Why it happens:** Easier to code full-recompute than incremental
**How to avoid:** Follow existing `inferBehavioralPatterns()` pattern: track `lastAnalyzedCount`, process only new messages, merge with existing patterns
**Warning signs:** Deep tick takes increasingly longer as history grows

### Pitfall 2: Cold Start Signal Noise
**What goes wrong:** Behavioral signals produce meaningless values with <5 messages
**Why it happens:** Statistical signals need minimum sample size
**How to avoid:** Return null/undefined for signals until minimum message threshold met (e.g., 10 messages for frequency, 5 for topic switching). Don't inject noisy signals into LLM context.
**Warning signs:** New users get "decreasing engagement" labels after 2 messages

### Pitfall 3: Embedding Availability Assumption
**What goes wrong:** Topic switch detection assumes all messages have embeddings
**Why it happens:** Not all messages get embedded (short messages, system messages)
**How to avoid:** Skip messages without embeddings in topic switch calculation. Use content-length heuristic as fallback (very short consecutive messages on different topics).
**Warning signs:** Crashes or NaN in cosine similarity calculations

### Pitfall 4: Over-Reporting in LLM Context
**What goes wrong:** All behavioral signals dumped into every LLM context, bloating prompt
**Why it happens:** Eager to use new data
**How to avoid:** Only surface signals that are actionable. "User typically sends 5 messages per session" is useful context. Raw frequency numbers are not. Format signals as natural-language personality insights.
**Warning signs:** System prompt grows by 200+ tokens per user

### Pitfall 5: Schema Migration Breaking Existing Data
**What goes wrong:** ALTER TABLE on behavioral_patterns loses existing data
**Why it happens:** SQLite ALTER TABLE is limited
**How to avoid:** Use additive schema changes only (new columns with defaults, or store new signals in the existing `response_preferences` JSON column). The existing `response_preferences TEXT` column is a JSON blob — new signals can be added to it without schema migration.
**Warning signs:** Test database works but production loses behavioral history
</common_pitfalls>

<code_examples>
## Code Examples

Verified patterns from the existing codebase:

### Existing Incremental Inference Pattern (profiles.ts:292-378)
```typescript
// Source: src/memory/profiles.ts - the pattern we're extending
inferBehavioralPatterns(userId: string, messages: Array<{ content: string; timestamp: number }>): void {
  if (messages.length === 0) return;

  // Only process messages we haven't seen yet
  const lastCount = this.lastAnalyzedCount.get(userId) ?? 0;
  const newMessages = messages.slice(lastCount);
  this.lastAnalyzedCount.set(userId, messages.length);
  if (newMessages.length === 0) return;

  // Load existing patterns for merging
  const existing = this.getBehavioralPatterns(userId);
  // ... merge logic ...

  this.updateBehavioralPatterns(userId, { /* merged results */ });
}
```

### Existing Deep Tick Behavioral Inference Call (memory.ts:265-286)
```typescript
// Source: src/memory/memory.ts - where behavioral inference is triggered
// During deep tick, after decay/fusion/summarization:
const sessions = db.listSessions();
const allMessages: Array<{ content: string; timestamp: number }> = [];
for (const session of sessions) {
  const messages = db.getSessionMessages(session.id);
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      allMessages.push({ content: msg.content, timestamp: msg.createdAt });
    }
  }
}
if (allMessages.length > 0) {
  profileManager.inferBehavioralPatterns('default', allMessages);
}
```

### EMA Smoothing (for new signals)
```typescript
// Exponential Moving Average with irregular time intervals
function updateEMA(
  currentValue: number,
  previousEMA: number,
  timeDeltaMs: number,
  halfLifeMs: number = 7 * 24 * 60 * 60 * 1000 // 7 days default
): number {
  const weight = 1 - Math.exp(-timeDeltaMs / halfLifeMs);
  return weight * currentValue + (1 - weight) * previousEMA;
}
```

### Cosine Similarity (already exists in codebase)
```typescript
// Source: src/memory/scallop-store.ts - existing utility
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Explicit user profiles (questionnaires) | Implicit profiling from conversation (ProfiLLM, IMPChat) | 2021-2025 | No user burden, continuously updated |
| Static behavioral categories | EMA-smoothed temporal signals with trends | 2024+ | Captures behavior evolution, not just snapshots |
| LDA/topic models for topic segmentation | Embedding cosine similarity | 2023+ | Simpler, cheaper, works with existing embeddings |
| Full-history recomputation | Incremental analysis with merge | Always best practice | O(new) not O(all) per tick |

**New tools/patterns to consider:**
- **ProfiLLM (June 2025):** LLM-based profiling using conversational prompts. Architecture: subdomain assignment → proficiency scoring → weighted averaging with time-decay confidence. Useful pattern for future LLM-powered profiling, but too expensive for per-message use now.
- **IMPChat (CIKM 2021):** Separate language style and preference modeling. Already partially implemented in existing communicationStyle/responsePreferences split.
- **Trend detection:** Simple first-half/second-half comparison is sufficient for behavioral trends. No need for complex time-series analysis.

**Deprecated/outdated:**
- **Static behavioral snapshots:** Tracking "user is concise" without temporal evolution misses behavioral shifts. The current system does this — Phase 22 adds temporal awareness.
- **Full hourly histograms:** Top-3 active hours is sufficient. Full 24-hour histograms are wasted storage for personal agents.
</sota_updates>

<open_questions>
## Open Questions

1. **Embedding availability for topic switch detection**
   - What we know: Memories have embeddings. Session messages may not.
   - What's unclear: Can we get embeddings for session messages cheaply during deep tick? Or only use messages that already have memory entries with embeddings?
   - Recommendation: During planning, investigate whether session messages can be batch-embedded during deep tick, or if we should only use messages that generated memory entries (which already have embeddings).

2. **Signal storage: new columns vs. JSON expansion**
   - What we know: `behavioral_patterns.response_preferences` is already a JSON blob. New signals could go in there or in new columns.
   - What's unclear: Whether new dedicated columns (cleaner) vs. JSON expansion (no migration) is better.
   - Recommendation: Use the JSON `response_preferences` column for new signals initially (rename it to something broader like `signals` in the interface, keep DB column name). This avoids schema migration entirely. Can normalize later if needed.

3. **Multi-user signal separation**
   - What we know: Current system uses `'default'` as userId for behavioral inference.
   - What's unclear: If/when multi-user support is needed, signals need per-user tracking.
   - Recommendation: Keep per-userId signal storage (already the case in `behavioral_patterns` PK). The `'default'` userId is fine for single-user personal agent.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/memory/profiles.ts` — ProfileManager with three-tier profiles
- Existing codebase: `src/memory/memory.ts` — BackgroundGardener with deep tick behavioral inference
- Existing codebase: `src/memory/db.ts` — BehavioralPatterns interface and SQLite schema

### Secondary (MEDIUM confidence)
- [ProfiLLM: LLM-Based Framework for Implicit Profiling](https://arxiv.org/abs/2506.13980) — Architecture patterns for implicit profiling (June 2025). Verified: time-decay weighted averaging pattern applicable.
- [IMPChat: Learning Implicit User Profiles](https://arxiv.org/abs/2108.07935) — Language style + preference separation. Verified: already partially implemented in existing system.
- [Exponential Moving Averages for Irregular Time Series](https://oroboro.com/irregular-ema/) — EMA formula for irregular sampling. Verified: mathematically sound.
- [Sliding Window Aggregation pattern](https://softwarepatternslexicon.com/data-modeling/time-series-data-modeling/sliding-window-aggregation/) — Window-based aggregation for temporal signals. Verified: standard pattern.

### Tertiary (LOW confidence - needs validation)
- Topic switch detection via cosine similarity threshold: 0.3 threshold is a starting point, needs calibration during implementation with real conversation data.
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Extending existing ProfileManager + BehavioralPatterns
- Ecosystem: No new libraries — pure extension of internal systems
- Patterns: EMA temporal smoothing, embedding-based topic detection, incremental merge inference
- Pitfalls: Cold start, schema migration, context bloat, embedding availability

**Confidence breakdown:**
- Standard stack: HIGH — extending existing code with no new dependencies
- Architecture: HIGH — following established incremental inference pattern
- Pitfalls: HIGH — identified from existing codebase constraints and common behavioral analysis issues
- Code examples: HIGH — from existing codebase

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (30 days — internal extension, no ecosystem changes to track)
</metadata>

---

*Phase: 22-behavioral-profiling*
*Research completed: 2026-02-10*
*Ready for planning: yes*
