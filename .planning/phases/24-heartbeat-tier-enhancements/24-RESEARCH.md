# Phase 24: Heartbeat Tier Enhancements - Research

**Researched:** 2026-02-10
**Domain:** Node.js/TypeScript application-level background processing (extends existing BackgroundGardener)
**Confidence:** HIGH

<research_summary>
## Summary

Researched Phase 24 requirements against the existing BackgroundGardener implementation (`src/memory/memory.ts`) and the bio-inspired research report (`pdf/smartbot-bioinspired-ai-report.typ`). This phase extends the existing 2-tier heartbeat (light tick every 5 min, deep tick every 6 hours) with four new capabilities and adds Tier 3 (Sleep) scheduling infrastructure for later phases.

The existing BackgroundGardener is a 317-line class with clean separation: `lightTick()` (sync, incremental) and `deepTick()` (async, full consolidation). All four new capabilities (health monitoring, retrieval auditing, trust scoring, goal deadline checks) follow the same pattern — they're stateless operations added to the existing tick methods. Tier 3 infrastructure is a new scheduling mechanism (nightly timer based on tick count or wall-clock time).

**Primary recommendation:** Add new operations as standalone pure functions called from `lightTick()` and `deepTick()`, following the v3.0 pattern of stateless functions with opt-in providers. Tier 3 scheduling uses a second tick counter (SLEEP_EVERY) gated by wall-clock quiet hours detection.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | (existing) | SQLite database | Already used for all memory operations |
| pino | (existing) | Structured logging | Already used across codebase |
| node:os | (built-in) | Health monitoring (memory, CPU) | No external dependency needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All Phase 24 features use existing dependencies |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual health checks | node-health-checks library | Overkill — we only need process.memoryUsage() + WAL size |
| Custom trust scoring | No alternatives | Application-specific formula from research report |
| Wall-clock Tier 3 | node-cron (already a dependency) | Could use cron for nightly scheduling, but tick-counter + wall-clock check is simpler and consistent with existing Tier 1/2 pattern |

**Installation:**
```bash
# No new packages needed — all capabilities use existing dependencies
```
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Current BackgroundGardener Structure
```
src/memory/memory.ts (317 lines)
├── BackgroundGardener class
│   ├── lightTick() — sync, every 5 min
│   │   ├── processDecay() [incremental]
│   │   ├── expireOldScheduledItems()
│   │   └── tickCount check → deepTick()
│   ├── deepTick() — async, every 72 ticks (~6 hours)
│   │   ├── processFullDecay()
│   │   ├── Memory fusion (if fusionProvider)
│   │   ├── Session summarization (if sessionSummarizer)
│   │   ├── Deep pruning
│   │   └── Behavioral pattern inference
│   ├── start() / stop() — setInterval lifecycle
│   └── processMemories() — backward-compatible alias
```

### Phase 24 Target Structure
```
src/memory/memory.ts (extended)
├── BackgroundGardener class
│   ├── lightTick() — sync, every 5 min
│   │   ├── processDecay() [existing]
│   │   ├── expireOldScheduledItems() [existing]
│   │   ├── NEW: healthPing() — provider availability, WAL size, memory count
│   │   └── tickCount checks → deepTick() / sleepTick()
│   ├── deepTick() — async, every 72 ticks (~6 hours)
│   │   ├── [all existing operations]
│   │   ├── NEW: retrievalAudit() — flag never-retrieved active memories
│   │   ├── NEW: trustUpdate() — compute trust score from acceptance/return/feedback
│   │   └── NEW: goalDeadlineCheck() — review pending goals, flag approaching deadlines
│   ├── sleepTick() — async, nightly (NEW Tier 3 infrastructure)
│   │   └── Placeholder/hook for Phase 27+ (NREM, REM, reflection)
│   ├── start() / stop() [extended for Tier 3]
│   └── processMemories() [unchanged]
```

### Pattern 1: Stateless Pure Functions for New Operations
**What:** Each new capability as a standalone pure function, called from the gardener
**When to use:** All new Phase 24 operations
**Why:** Follows v3.0 pattern — testable without BackgroundGardener, composable, no class coupling

```typescript
// Source: v3.0 pattern (fusion.ts, behavioral-signals.ts)
// Each operation is a pure function that takes dependencies as arguments

export interface HealthPingResult {
  walSizeBytes: number;
  memoryCount: number;
  processMemoryMB: number;
  providerAvailable: boolean;
  timestamp: number;
}

export function performHealthPing(
  db: ScallopDatabase,
  provider?: LLMProvider,
): HealthPingResult {
  // Pure function — no class state, no side effects beyond DB reads
}
```

### Pattern 2: Retrieval Audit via Access Tracking
**What:** Track which memories are actually retrieved during context assembly, then flag never-used active memories in deep tick
**When to use:** Deep tick (Tier 2)
**Why:** Research report (Hu et al.): retrieval-history-based strategies yield ~10% performance gains

The retrieval tracking requires two parts:
1. **Recording phase:** When memories are used in context assembly, call `db.recordAccess(id)` (already exists in ScallopDatabase)
2. **Audit phase (new):** In deep tick, find active memories (prominence >= 0.5) with accessCount = 0 or lastAccessed > 30 days — these are candidates for accelerated decay

```typescript
export interface RetrievalAuditResult {
  neverRetrieved: number;      // active memories never used in context
  staleRetrieved: number;      // active memories not used in 30+ days
  totalAudited: number;
  candidatesForDecay: string[]; // memory IDs to accelerate decay
}

export function auditRetrievalHistory(
  db: ScallopDatabase,
  options?: { staleThresholdDays?: number },
): RetrievalAuditResult {
  // Query: SELECT id FROM memories
  //   WHERE prominence >= 0.5 AND is_latest = 1
  //   AND (access_count = 0 OR last_accessed < ?)
}
```

### Pattern 3: Trust Score Computation
**What:** Compute user trust score from observable signals, stored in behavioral_patterns
**When to use:** Deep tick (Tier 2)
**Why:** Research report (Du 2025 / Diebel 2025): trust calibrates proactiveness dial

Trust formula from research report:
- Response acceptance rate (does user follow suggestions?)
- Session return rate (does user keep coming back?)
- Explicit feedback signals
- Proactiveness tolerance (does user dismiss proactive messages?)

```typescript
export interface TrustSignals {
  sessionReturnRate: number;    // sessions per week (EMA-smoothed)
  avgSessionDuration: number;   // EMA-smoothed
  proactiveAcceptRate: number;  // % of proactive items user acted on
  proactiveDismissRate: number; // % of proactive items user dismissed
  explicitFeedback: number;     // net positive/negative feedback score
}

export interface TrustScoreResult {
  trustScore: number;           // 0.0-1.0
  proactivenessDial: 'conservative' | 'moderate' | 'eager';
  signals: TrustSignals;
}

export function computeTrustScore(
  sessions: Array<{ messageCount: number; durationMs: number; startTime: number }>,
  scheduledItems: Array<{ status: string; source: string; firedAt?: number }>,
  existingScore?: number,
): TrustScoreResult {
  // Weighted combination of signals → trust score → dial mapping
}
```

### Pattern 4: Tier 3 (Sleep) Scheduling
**What:** A third tier that runs once per night during quiet hours
**When to use:** After all deep ticks for the day have passed (typically 3 AM)
**Why:** Foundation for Phase 27-30 (dreams, reflection)

Two design options:
1. **Tick-counter approach:** SLEEP_EVERY = 288 ticks (24 hours at 5-min intervals), gated by wall-clock check (run only during configured quiet hours, e.g. 2-5 AM)
2. **Separate timer approach:** Independent `setInterval` or `setTimeout` targeting a specific wall-clock time

**Recommendation:** Tick-counter with wall-clock gate. Keeps the architecture consistent — one timer, multiple tier thresholds. The wall-clock gate ensures sleep tick doesn't fire during active hours.

```typescript
private static readonly DEEP_EVERY = 72;   // 6 hours (existing)
private static readonly SLEEP_EVERY = 288;  // 24 hours
private sleepTickCount = 0;

lightTick(): void {
  // ... existing operations ...
  this.tickCount++;
  this.sleepTickCount++;

  if (this.tickCount >= BackgroundGardener.DEEP_EVERY) {
    this.tickCount = 0;
    this.deepTick().catch(/* ... */);
  }

  if (this.sleepTickCount >= BackgroundGardener.SLEEP_EVERY && this.isQuietHours()) {
    this.sleepTickCount = 0;
    this.sleepTick().catch(/* ... */);
  }
}
```

### Anti-Patterns to Avoid
- **Putting new logic inline in deepTick():** Extract to pure functions — deepTick() just orchestrates
- **Blocking lightTick() with async operations:** lightTick is sync; all async work fires .catch() to background
- **Coupling trust score to specific channel:** Trust score should be channel-agnostic (computed from aggregate signals)
- **Hardcoding quiet hours:** Make configurable in BackgroundGardenerOptions (different users have different schedules)
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WAL file size check | Custom file reading | `db.pragma('wal_checkpoint(PASSIVE)')` or `PRAGMA wal_autocheckpoint` | SQLite provides WAL size info natively via pragmas |
| Process memory usage | Custom /proc reading | `process.memoryUsage()` | Node.js built-in, cross-platform |
| EMA smoothing for trust | New EMA implementation | Reuse `computeEMA()` from `behavioral-signals.ts` | Already battle-tested with 7-day half-life |
| Quiet hours detection | Complex timezone math | Reuse `Intl.DateTimeFormat` pattern from `UnifiedScheduler.calculateNextOccurrence()` | Already handles timezone conversion correctly |
| Goal deadline checks | Custom deadline scanning | Reuse `GoalService.getGoalHierarchy()` + `db.getDueScheduledItems()` | Goal system already tracks deadlines and milestones |

**Key insight:** Phase 24 is infrastructure — it extends existing systems, not building new ones. Every new capability connects to something that already exists. The risk is duplicating logic that's already in `behavioral-signals.ts`, `goal-service.ts`, or `db.ts`.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Overloading lightTick with Slow Operations
**What goes wrong:** Health ping includes LLM provider availability check (network call) that blocks lightTick
**Why it happens:** lightTick() is synchronous and runs every 5 minutes — any slow operation delays decay processing
**How to avoid:** Health ping must be sync-only: `process.memoryUsage()`, SQLite `SELECT COUNT(*)`, WAL pragma. Provider availability check should be async and run in deepTick only, or fire-and-forget with `.catch()`
**Warning signs:** lightTick duration increases from <10ms to >100ms

### Pitfall 2: Trust Score Cold Start
**What goes wrong:** Trust score is NaN or 0.0 for new users with no scheduled items or sessions
**Why it happens:** No proactive items fired yet → acceptance rate is 0/0
**How to avoid:** Default trust score of 0.5 (neutral) for users with insufficient data. Set minimum data threshold (e.g., at least 5 sessions, at least 1 proactive item) before computing real trust. Follow behavioral-signals.ts cold-start pattern (return null when data insufficient)
**Warning signs:** Trust score immediately jumps to 0 or 1 on first interaction

### Pitfall 3: Retrieval Audit False Positives
**What goes wrong:** Recently stored memories flagged as "never retrieved" because they were just created and haven't been needed yet
**Why it happens:** No minimum age filter — memory stored 1 hour ago hasn't had time to be retrieved
**How to avoid:** Only audit memories older than 7 days (configurable). A memory needs time to have retrieval opportunities before being flagged
**Warning signs:** New memories immediately get accelerated decay after first deep tick

### Pitfall 4: Sleep Tick Fires During Active Hours
**What goes wrong:** Tier 3 processes (NREM fusion, reflection) run while user is active, consuming LLM budget and competing for resources
**Why it happens:** Tick counter reaches SLEEP_EVERY during daytime because service was restarted
**How to avoid:** Wall-clock gate: only allow sleep tick during configured quiet hours (default 2-5 AM). If threshold reached outside quiet hours, defer to next quiet window
**Warning signs:** Deep consolidation operations and user responses competing for same LLM provider

### Pitfall 5: Goal Deadline Check Creates Spam
**What goes wrong:** Every deep tick creates a new proactive notification for the same approaching deadline
**Why it happens:** No deduplication check — `hasSimilarPendingScheduledItem()` exists but isn't called
**How to avoid:** Before creating a deadline reminder, check `db.hasSimilarPendingScheduledItem(userId, message)` with appropriate time window. Follow existing duplicate detection pattern from UnifiedScheduler
**Warning signs:** User receives 4x daily reminders about the same deadline
</common_pitfalls>

<code_examples>
## Code Examples

Verified patterns from existing codebase:

### Existing Deep Tick Step Pattern (follow this for new operations)
```typescript
// Source: memory.ts deepTick() — each step is try-catch wrapped, non-blocking
// 4. Behavioral pattern inference
try {
  const profileManager = this.scallopStore.getProfileManager();
  const recentSessions = db.listSessions(5);
  // ... collect data ...
  profileManager.inferBehavioralPatterns('default', allMessages, {
    sessions: sessions.length > 0 ? sessions : undefined,
    messageEmbeddings: messageEmbeddings.length > 0 ? messageEmbeddings : undefined,
  });
  this.logger.debug({ messageCount: allMessages.length }, 'Behavioral patterns updated');
} catch (err) {
  this.logger.warn({ error: (err as Error).message }, 'Behavioral inference failed');
}
```

### Existing EMA Computation (reuse for trust smoothing)
```typescript
// Source: behavioral-signals.ts — EMA for irregular time series
// weight = 1 - exp(-timeDelta / halfLife)
// EMA = weight * currentValue + (1 - weight) * previousEMA
export function computeEMA(
  values: Array<{ value: number; timestamp: number }>,
  halfLifeMs: number,
): number | null {
  if (values.length === 0) return null;
  let ema = values[0].value;
  for (let i = 1; i < values.length; i++) {
    const dt = values[i].timestamp - values[i - 1].timestamp;
    const weight = 1 - Math.exp(-dt / halfLifeMs);
    ema = weight * values[i].value + (1 - weight) * ema;
  }
  return ema;
}
```

### Existing Cold-Start Pattern (follow for trust scoring)
```typescript
// Source: behavioral-signals.ts — return null when insufficient data
export function computeMessageFrequency(
  messages: Array<{ timestamp: number }>,
  halfLifeMs: number = SEVEN_DAYS_MS,
): MessageFrequencySignal | null {
  if (messages.length < MIN_MESSAGES_FOR_FREQUENCY) return null;
  // ... compute signal ...
}
```

### Existing SQLite Access Tracking (use for retrieval audit)
```typescript
// Source: db.ts — already tracks access count and last access time
recordAccess(id: string): void {
  this.db.prepare(`
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed = ?
    WHERE id = ?
  `).run(Date.now(), id);
}
```

### Existing Goal Service Interface (reuse for deadline checks)
```typescript
// Source: goal-service.ts
interface GoalTree {
  goal: GoalMemory;
  milestones: Array<{ milestone: GoalMemory; tasks: GoalMemory[] }>;
  totalProgress: number;
}

// getGoalHierarchy(goalId): GoalTree | null
// listGoals(userId, status?): GoalMemory[]
```

### Existing Duplicate Detection (reuse for deadline notifications)
```typescript
// Source: db.ts — word overlap similarity check
hasSimilarPendingScheduledItem(
  userId: string,
  message: string,
  withinMs?: number,
): boolean {
  // Word overlap: ≥80% smaller set OR ≥40% either side = duplicate
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 2-tier heartbeat (pulse + breath) | 3-tier (pulse + breath + sleep) per MemGPT/CoALA | Research report 2026-02 | Enables nightly cognitive processing |
| Simple prominence-based forgetting | Utility-based: prominence × log(1 + accessCount) per Hu et al. | Research report 2026-02 | More intelligent memory lifecycle |
| No trust tracking | Trust score from acceptance/return/feedback per Du/Diebel 2025 | Research report 2026-02 | Calibrates proactiveness |
| No retrieval auditing | Access-history based audit per Hu et al. 2025 | Research report 2026-02 | Identifies wasted active memory slots |

**New patterns to consider:**
- **MemGPT paging analogy:** Pre-load anticipated memories before user sessions (Tier 3 context pre-load — Phase 27+)
- **CoALA autonomous loop:** Decision loop runs between messages, not just in response (Tier 3 + gap scanner — Phase 31+)
- **Reflexion self-reflection:** Daily process-focused review stored as insight memories (Phase 30)

**Deprecated/outdated:**
- None for this phase — all patterns are new additions, not replacements
</sota_updates>

<open_questions>
## Open Questions

1. **Quiet hours configuration: per-user or global?**
   - What we know: UnifiedScheduler already has `getTimezone()` per user. Research report suggests quiet hours per user.
   - What's unclear: Whether to store quiet hours in user profile (behavioral_patterns table) or global config
   - Recommendation: Start with global config in BackgroundGardenerOptions (simplest). Per-user quiet hours can be added when multi-user support is needed.

2. **Trust score storage location**
   - What we know: Behavioral signals use `_sig_` prefix in `response_preferences` JSON (no schema migration). Research report mentions `behavioral_patterns` table.
   - What's unclear: Whether trust score should follow `_sig_` pattern or get its own column
   - Recommendation: Follow `_sig_` pattern (`_sig_trust`) for consistency. Trust is a behavioral signal.

3. **Retrieval audit action: accelerate decay or just log?**
   - What we know: Research report says "flag never-retrieved active memories → candidates for accelerated decay"
   - What's unclear: Should Phase 24 actually apply accelerated decay, or just audit and log for Phase 29 (Enhanced Forgetting)?
   - Recommendation: Phase 24 should audit and log only. Phase 29 implements the utility-based forgetting formula that consumes audit results. This keeps phases cleanly separated.

4. **Health ping persistence: store results or just log?**
   - What we know: Health pings are low-frequency (every 5 min). No existing health history table.
   - What's unclear: Whether to store health metrics for trend analysis or just log them
   - Recommendation: Log only for now. Store in-memory ring buffer (last N pings) for diagnostics. Add persistent storage when trend analysis is needed.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `pdf/smartbot-bioinspired-ai-report.typ` — Full research report with heartbeat design specification (lines 484-614)
- `src/memory/memory.ts` — Current BackgroundGardener implementation (317 lines)
- `src/memory/behavioral-signals.ts` — EMA computation patterns, cold-start handling
- `src/memory/decay.ts` — DecayEngine with prominence formula and type-specific rates
- `src/memory/fusion.ts` — Fusion cluster detection and LLM-based merging
- `src/memory/db.ts` — ScallopDatabase with recordAccess(), hasSimilarPendingScheduledItem()
- `src/proactive/scheduler.ts` — UnifiedScheduler with timezone handling, recurring items
- `src/goals/goal-service.ts` — GoalService with hierarchy and deadline tracking

### Secondary (MEDIUM confidence)
- Research report references: MemGPT (Packer 2023), CoALA (Sumers 2024), Hu et al. (2025) — patterns mapped in report
- Research report references: Du (2025), Diebel (2025) — trust scoring design

### Tertiary (LOW confidence - needs validation)
- None — all Phase 24 patterns come from existing codebase + research report (both fully accessible)
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Node.js/TypeScript application-level background processing
- Ecosystem: No new libraries (extends existing better-sqlite3, pino, node built-ins)
- Patterns: Tiered scheduling, pure function operations, EMA smoothing, cold-start handling
- Pitfalls: Sync/async boundary in ticks, cold start, deduplication, timing

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, extends existing code
- Architecture: HIGH — follows established v3.0 patterns (stateless functions, opt-in providers)
- Pitfalls: HIGH — derived from known codebase constraints and research report warnings
- Code examples: HIGH — all from existing codebase files

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (30 days — stable internal architecture, no external dependencies to change)
</metadata>

---

*Phase: 24-heartbeat-tier-enhancements*
*Research completed: 2026-02-10*
*Ready for planning: yes*
