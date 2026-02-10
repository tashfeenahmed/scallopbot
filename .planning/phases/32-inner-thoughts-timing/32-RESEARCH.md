# Phase 32: Inner Thoughts & Timing - Research

**Researched:** 2026-02-10
**Domain:** Post-session inner monologue, proactive timing model, per-channel formatting, trust-calibrated feedback
**Confidence:** HIGH

<research_summary>
## Summary

Researched the inner thoughts architecture pattern (Liu et al. CHI 2025), proactive AI timing models (Microsoft CHI 2025), the MIRROR cognitive architecture, and trust calibration feedback loops — mapped against the existing SmartBot codebase to identify gaps and implementation strategy.

Key finding: Phase 32 is primarily an **orchestration + wiring** phase, not a new-capability phase. The gap scanner (Phase 31) already produces scheduled items; the trust score already computes proactiveness dials. What's missing is: (1) a lightweight post-session inner monologue that decides whether to augment gap scanner output with session-specific proactive follow-ups, (2) a timing model that gates delivery by quiet hours and prefers session-start moments, (3) per-channel formatting (Telegram short + expand, WebSocket structured JSON), and (4) wiring the feedback loop so dismissed/engaged proactive items update the trust score.

The Liu et al. inner thoughts pattern uses 7 scoring heuristics (relevance, information gap, expected impact, urgency, coherence, originality, balance) — but for a personal assistant with existing gap scanner output, a simplified 3-factor check (urgency × relevance × user-receptiveness) is sufficient. The MIRROR architecture's key insight (temporal decoupling: Talker responds immediately, Thinker processes asynchronously) maps directly to SmartBot's existing pattern: agent responds in real-time, background gardener processes asynchronously.

**Primary recommendation:** Build inner thoughts as a pure function `evaluateInnerThoughts()` that runs post-session (triggered by session inactivity timeout), taking recent session context + gap scanner signals + affect state → returns `InnerThoughtsResult` with decision (proact/wait/skip) + message + timing preference. Wire timing model into UnifiedScheduler delivery (quiet hours gate + session-start preference). Add `proactive` message type to WsResponse for structured WebSocket delivery. Track user engagement/dismissal on proactive messages to close the trust feedback loop.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Existing `scheduled_items` + `UnifiedScheduler` | N/A | Delivery pipeline | Already handles claiming, LLM message gen, channel routing |
| Existing `trust-score.ts` | N/A | Proactiveness gating | Already computes conservative/moderate/eager from user behavior |
| Existing `affect.ts` + `affect-smoothing.ts` | N/A | Stress suppression | Already provides valence, arousal, emotion, goalSignal |
| Existing `behavioral-signals.ts` | N/A | Session patterns | Already tracks frequency, engagement, active hours |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing `session-summary.ts` | N/A | Session boundary detection | When summarizer runs = session has ended |
| Existing `gap-scanner.ts` | N/A | Gap signals for inner thoughts input | Inner thoughts augments (not replaces) gap scanner |
| Existing `TriggerSource` interface | N/A | Channel-agnostic delivery | Route proactive messages to correct channel |
| Existing `parseUserIdPrefix()` | N/A | Channel detection | Determine Telegram vs WebSocket for formatting |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Session inactivity timeout | Explicit session end event | No explicit end event exists; inactivity timeout (e.g., 30 min no messages) is pragmatic and matches Liu et al.'s approach |
| Post-session inner thoughts | Real-time inner thoughts (Liu et al. full model) | Full model runs continuously during conversations; too expensive for personal assistant. Post-session is sufficient for proactive follow-ups |
| Simplified 3-factor scoring | Full 7-heuristic G-Eval scoring (Liu et al.) | 7 heuristics designed for multi-agent simulation; 3 factors sufficient for personal assistant with existing gap scanner |

**Installation:**
```bash
# No new dependencies — all built on existing codebase
```
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Recommended Project Structure
```
src/
├── memory/
│   ├── inner-thoughts.ts           # Pure function: evaluateInnerThoughts()
│   ├── inner-thoughts.test.ts      # Unit tests
│   └── memory.ts                   # Wire into deepTick or post-session hook
├── proactive/
│   ├── timing-model.ts             # Pure function: computeDeliveryTime()
│   ├── timing-model.test.ts        # Unit tests
│   └── scheduler.ts                # Add quiet hours gate + timing model
├── channels/
│   ├── proactive-format.ts         # Pure function: formatProactiveMessage()
│   ├── proactive-format.test.ts    # Unit tests
│   ├── api.ts                      # Add 'proactive' WsResponse type
│   └── telegram.ts                 # Add short + expand pattern
```

### Pattern 1: Post-Session Inner Monologue (adapted from Liu et al. 2025)
**What:** After a session becomes inactive, run a lightweight LLM evaluation of whether proactive follow-up is warranted
**When to use:** After session inactivity (30 min no messages) or at next deepTick boundary
**Key insight from Liu et al.:** Inner thoughts should run as a **parallel asynchronous process**, not blocking the response. SmartBot's BackgroundGardener already provides this exact pattern.

**Architecture:**
```typescript
// Inner thoughts evaluates whether to proactively reach out
interface InnerThoughtsInput {
  sessionSummary: SessionSummaryRow;       // What happened in the session
  recentGapSignals: GapSignal[];           // Any gap scanner signals for this user
  affect: SmoothedAffect | null;           // User's current mood
  dial: 'conservative' | 'moderate' | 'eager';
  lastProactiveMessageAt: number | null;   // When we last reached out
  activeHours: number[];                   // User's typical active hours
}

interface InnerThoughtsResult {
  decision: 'proact' | 'wait' | 'skip';
  reason: string;                          // For logging/debugging
  message?: string;                        // Suggested proactive message
  urgency: 'low' | 'medium' | 'high';
  preferredDeliveryWindow?: {
    earliest: number;                      // Timestamp
    latest: number;                        // Timestamp
  };
}

// Pure function — takes input, returns result, no side effects
async function evaluateInnerThoughts(
  input: InnerThoughtsInput,
  provider: LLMProvider,
): Promise<InnerThoughtsResult>
```

### Pattern 2: Timing Model (from Microsoft CHI 2025 + Liu et al.)
**What:** Determine optimal delivery time based on quiet hours, user activity patterns, and session boundaries
**When to use:** Before inserting scheduled items; when UnifiedScheduler fires items

**Key findings from research:**
- Session-start moments have 52% engagement rate vs 38% for mid-task (Microsoft CHI 2025)
- Quiet hours respect is non-negotiable for personal assistants
- Silence duration should increase motivation score (Liu et al.)
- 20-second minimum between suggestions to avoid fatigue (CHI 2025 proactive programming)

**Architecture:**
```typescript
interface TimingContext {
  userActiveHours: number[];         // From behavioral signals
  quietHours: { start: number; end: number };
  lastSessionEnd: number | null;     // When user's last session ended
  lastProactiveAt: number | null;    // When we last proactively messaged
  currentHour: number;
  urgency: 'low' | 'medium' | 'high';
}

interface DeliveryTiming {
  deliverAt: number;                 // Optimal timestamp
  reason: string;                    // For logging
  strategy: 'session_start' | 'active_hours' | 'urgent_now' | 'next_morning';
}

// Pure function
function computeDeliveryTime(context: TimingContext): DeliveryTiming
```

**Timing strategies (priority order):**
1. **Urgent now:** High urgency + within active hours → deliver in 5 min
2. **Session start:** Prefer delivering at expected next session start (from behavioral signals)
3. **Active hours:** Deliver during user's typical active hours
4. **Next morning:** If currently in quiet hours, defer to after quiet hours end

### Pattern 3: Per-Channel Proactive Formatting
**What:** Format proactive messages differently for Telegram vs WebSocket
**When to use:** In UnifiedScheduler before sending via TriggerSource

**Architecture:**
```typescript
interface ProactiveMessageContext {
  channel: 'telegram' | 'api';
  gapType: string;
  message: string;
  urgency: 'low' | 'medium' | 'high';
  source: 'inner_thoughts' | 'gap_scanner';
}

// Telegram: short summary + "Reply to discuss" footer
// WebSocket: structured JSON with type, category, urgency
function formatProactiveMessage(context: ProactiveMessageContext): string | object
```

**Telegram format:**
```
[proactive icon based on type] [short message, 1-2 sentences]

Reply to discuss, or ignore to dismiss.
```

**WebSocket format:**
```json
{
  "type": "proactive",
  "category": "stale_goal",
  "urgency": "medium",
  "message": "Your Spanish learning goal hasn't had activity in 2 weeks...",
  "source": "gap_scanner",
  "dismissAction": "dismiss"
}
```

### Pattern 4: Trust-Calibrated Feedback Loop
**What:** Track user reactions to proactive messages to update trust score
**When to use:** After proactive message delivery, track engagement vs dismiss

**Architecture:**
The feedback loop already exists in skeleton form:
1. `trust-score.ts` already has `proactiveAcceptRate` (weight 0.30) and `proactiveDismissRate` (weight -0.20)
2. `scheduled_items` already has `status: 'fired' | 'dismissed'`
3. `db.markScheduledItemDismissed()` already exists

**What's missing:** No `markScheduledItemActed()` method, and no mechanism to detect engagement (user replied to a proactive message = "acted").

**Detection strategy:**
- **Dismissed:** User sends a dismiss command (e.g., via trigger skill) or item expires without response
- **Acted:** User sends a message within N minutes of proactive message delivery → mark as "acted"
- **Fired (no feedback):** Message delivered but no engagement signal within timeout

### Anti-Patterns to Avoid
- **Running inner thoughts on every message:** Liu et al. runs continuously, but that's for multi-agent simulations. For personal assistant, post-session is sufficient and much cheaper.
- **Blocking the response loop:** Inner thoughts must be asynchronous. Never delay a user response to run inner thought evaluation.
- **Delivering during quiet hours:** Even urgent items should wait. Exception: only if user explicitly set override.
- **Same format for all channels:** Telegram's 4096 char limit and conversational nature requires short messages. WebSocket clients are typically rich UIs that can render structured data.
- **Trust score without feedback:** Computing trust without wiring dismiss/engage feedback creates a static score that never adapts.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Proactiveness gating | Custom inner-thoughts gating | Existing trust-score.ts → proactivenessDial | Already computes conservative/moderate/eager from user behavior |
| Session end detection | Custom event system | Session inactivity timeout (behavioral signals show avg session duration) | No explicit session end event exists; inactivity is pragmatic |
| Quiet hours | Custom time-of-day logic | Existing `isQuietHours()` in BackgroundGardener | Already handles wrap-around (e.g., 23:00-05:00) |
| Channel detection | Custom channel parsing | Existing `parseUserIdPrefix()` | Already extracts 'telegram' vs 'api' from prefixed userId |
| Message delivery | Custom delivery pipeline | Existing UnifiedScheduler + TriggerSource | Already handles claiming, LLM gen, routing, recurring |
| User mood check | Custom affect detection | Existing affect-smoothing.ts → goalSignal | Already provides 'user_distressed', 'user_improving', etc. |
| Active hours estimation | Custom time tracking | Existing behavioral-signals.ts → activeHours | Already tracks when user typically messages |
| Dismiss tracking | Custom interaction tracking | Existing db.markScheduledItemDismissed() | Already in the DB layer |

**Key insight:** Phase 32 wires together existing components (gap scanner → inner thoughts → timing model → scheduler → channel formatting → feedback → trust score). The only truly new logic is the inner thoughts LLM evaluation and the timing model computation — everything else reuses existing infrastructure.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Inner Thoughts Running Too Often
**What goes wrong:** Inner thoughts runs after every session, costing LLM tokens even when there's nothing to proactively address
**Why it happens:** No pre-filter before the LLM call
**How to avoid:**
- Gate inner thoughts on pre-conditions: session had ≥ 3 messages AND (gap signals exist OR session ended with unresolved question)
- Skip if last proactive message was within 6 hours
- Skip if dial is 'conservative' and no high-severity signals exist
**Warning signs:** Inner thoughts running but always returning 'skip'

### Pitfall 2: Timing Model Deadlocks
**What goes wrong:** All delivery windows are blocked (quiet hours + no active hours detected), item never delivers
**Why it happens:** Cold start — no behavioral data to infer active hours
**How to avoid:**
- Default active hours: 9 AM–10 PM when behavioral data unavailable
- Maximum deferral: 24 hours. If item can't deliver within 24h, deliver at next non-quiet-hour moment
- Expiry: Items older than `maxItemAge` (existing 24h default) get expired by UnifiedScheduler
**Warning signs:** Scheduled items accumulating as 'pending' without firing

### Pitfall 3: Feedback Loop Not Closing
**What goes wrong:** Trust score never changes because 'acted'/'dismissed' status is never set
**Why it happens:** No mechanism to detect user engagement with proactive messages
**How to avoid:**
- For dismiss: Wire the existing `triggers` skill to mark items as dismissed
- For engagement: When user sends a message, check if there's a recently-fired proactive item (within 30 min). If so, mark it as 'acted'
- For expiry: If fired item gets no response within the maxItemAge window, leave as 'fired' (neutral signal)
**Warning signs:** All scheduled items stuck at 'fired' status, trust score flatlined

### Pitfall 4: Telegram Message Too Long
**What goes wrong:** Proactive message exceeds Telegram's 4096 char limit, gets split awkwardly
**Why it happens:** LLM generates verbose inner thoughts output without length constraints
**How to avoid:**
- Enforce maxTokens: 100 for Telegram-bound messages
- Format as: "[icon] [1-2 sentences]\n\nReply to discuss, or ignore to dismiss."
- Total should be < 300 chars for Telegram proactive messages
**Warning signs:** Split messages appearing in Telegram with partial context

### Pitfall 5: Over-Proacting After Distressed User
**What goes wrong:** User is stressed (negative affect), inner thoughts still proactively messages about stale goals
**Why it happens:** Affect state not checked in inner thoughts pre-filter
**How to avoid:**
- If `goalSignal === 'user_distressed'`, skip all non-urgent proactive messages
- If valence < -0.5 (significantly negative), only allow urgent deadline reminders
- Log suppressed messages for debugging
**Warning signs:** Proactive messages sent when user had negative affect in recent session
</common_pitfalls>

<code_examples>
## Code Examples

Verified patterns from existing codebase modules:

### Inner Thoughts Evaluation (following reflection.ts + gap-diagnosis.ts pattern)
```typescript
// Source: Adapts pattern from src/memory/reflection.ts and src/memory/gap-diagnosis.ts
export interface InnerThoughtsInput {
  sessionSummary: SessionSummaryRow;
  recentGapSignals: GapSignal[];
  affect: SmoothedAffect | null;
  dial: 'conservative' | 'moderate' | 'eager';
  lastProactiveAt: number | null;
  activeHours: number[];
}

export interface InnerThoughtsResult {
  decision: 'proact' | 'wait' | 'skip';
  reason: string;
  message?: string;
  urgency: 'low' | 'medium' | 'high';
  preferredDeliveryWindow?: { earliest: number; latest: number };
}

// Pre-filter (no LLM — pure logic)
function shouldRunInnerThoughts(input: InnerThoughtsInput): boolean {
  // Skip if too recent
  if (input.lastProactiveAt && Date.now() - input.lastProactiveAt < 6 * 60 * 60 * 1000) return false;
  // Skip if distressed
  if (input.affect?.goalSignal === 'user_distressed') return false;
  // Skip if no meaningful session
  if (input.sessionSummary.messageCount < 3) return false;
  // Run if gap signals exist
  if (input.recentGapSignals.length > 0) return true;
  // Run if dial is moderate or eager (more permissive)
  return input.dial !== 'conservative';
}

// LLM evaluation (following gap-diagnosis.ts prompt-builder pattern)
function buildInnerThoughtsPrompt(input: InnerThoughtsInput): CompletionRequest {
  const system = `You are evaluating whether to proactively reach out to a user after their conversation session ended.

Rules:
- Only recommend proactive action if there's a clear, specific reason
- Respect the user's proactiveness preference: "${input.dial}"
- The user's current mood: ${input.affect?.emotion ?? 'unknown'}
- If the session resolved everything, recommend "skip"
- If there's something worth following up but not urgent, recommend "wait"
- If there's a clear action opportunity, recommend "proact"

Respond with JSON only: {"decision": "proact|wait|skip", "reason": "...", "message": "...", "urgency": "low|medium|high"}`;

  return {
    messages: [{ role: 'user', content: `SESSION SUMMARY:\n${input.sessionSummary.summary}\n\nTOPICS: ${(input.sessionSummary.topics ?? []).join(', ')}\n\nGAP SIGNALS: ${input.recentGapSignals.length > 0 ? input.recentGapSignals.map(s => `[${s.type}] ${s.description}`).join('\n') : 'None'}\n\nEvaluate (JSON only):` }],
    system,
    temperature: 0.2,
    maxTokens: 200,
  };
}
```

### Timing Model (pure function, following trust-score.ts pattern)
```typescript
// Source: Adapts patterns from src/memory/trust-score.ts and BackgroundGardener.isQuietHours()
export interface TimingContext {
  userActiveHours: number[];
  quietHours: { start: number; end: number };
  lastProactiveAt: number | null;
  currentHour: number;
  urgency: 'low' | 'medium' | 'high';
}

export interface DeliveryTiming {
  deliverAt: number;
  reason: string;
  strategy: 'session_start' | 'active_hours' | 'urgent_now' | 'next_morning';
}

function isInQuietHours(hour: number, quiet: { start: number; end: number }): boolean {
  if (quiet.start <= quiet.end) return hour >= quiet.start && hour < quiet.end;
  return hour >= quiet.start || hour < quiet.end; // Wrap-around
}

export function computeDeliveryTime(context: TimingContext): DeliveryTiming {
  const now = Date.now();

  // High urgency + not quiet hours → deliver soon
  if (context.urgency === 'high' && !isInQuietHours(context.currentHour, context.quietHours)) {
    return { deliverAt: now + 5 * 60 * 1000, reason: 'High urgency, active hours', strategy: 'urgent_now' };
  }

  // If in quiet hours, defer to after quiet hours end
  if (isInQuietHours(context.currentHour, context.quietHours)) {
    const hoursUntilEnd = /* compute hours until quiet.end */;
    return { deliverAt: now + hoursUntilEnd * 60 * 60 * 1000, reason: 'Deferred past quiet hours', strategy: 'next_morning' };
  }

  // Prefer active hours
  const activeHours = context.userActiveHours.length > 0 ? context.userActiveHours : [9,10,11,12,13,14,15,16,17,18,19,20,21];
  if (activeHours.includes(context.currentHour)) {
    return { deliverAt: now + 15 * 60 * 1000, reason: 'Within active hours', strategy: 'active_hours' };
  }

  // Find next active hour
  // ... compute next active hour timestamp
  return { deliverAt: nextActiveTimestamp, reason: 'Deferred to next active period', strategy: 'session_start' };
}
```

### Per-Channel Formatting (pure function)
```typescript
// Source: Adapts patterns from src/channels/telegram.ts formatMarkdownToHtml
// and src/channels/api.ts WsResponse

const GAP_TYPE_ICONS: Record<string, string> = {
  stale_goal: '🎯',
  approaching_deadline: '⏰',
  unresolved_thread: '💬',
  behavioral_anomaly: '📊',
  follow_up: '👋',
};

export function formatForTelegram(message: string, gapType?: string): string {
  const icon = gapType ? (GAP_TYPE_ICONS[gapType] ?? '💡') : '💡';
  // Enforce brevity for Telegram
  const shortMessage = message.length > 250 ? message.slice(0, 247) + '...' : message;
  return `${icon} ${shortMessage}\n\n_Reply to discuss, or ignore to dismiss._`;
}

export function formatForWebSocket(
  message: string,
  gapType: string,
  urgency: string,
  source: string,
): WsResponse {
  return {
    type: 'proactive',
    content: message,
    // Additional structured fields for rich UI rendering
    // (extend WsResponse type with optional proactive fields)
  };
}
```

### Feedback Loop: Engagement Detection
```typescript
// Source: New logic, wired into agent.processMessage or gateway
// When user sends a message, check for recently-fired proactive items

function detectProactiveEngagement(
  userId: string,
  db: ScallopDatabase,
  engagementWindowMs: number = 30 * 60 * 1000, // 30 min
): void {
  // Find recently fired agent items (proactive messages)
  const recentFired = db.getScheduledItemsByUser(userId)
    .filter(item =>
      item.source === 'agent' &&
      item.status === 'fired' &&
      item.firedAt &&
      Date.now() - item.firedAt < engagementWindowMs
    );

  // Mark as acted (user engaged by replying)
  for (const item of recentFired) {
    db.markScheduledItemActed(item.id); // New DB method needed
  }
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Reactive-only agents | Liu et al. Inner Thoughts framework | Jan 2025 (CHI) | 7-heuristic scoring for proactive participation; significantly beats baselines on anthropomorphism, coherence, initiative |
| Static timing | Microsoft CHI 2025 natural breakpoints | 2025 | Session boundaries achieve 52% engagement vs 38% mid-task; 45s vs 101s interpretation time |
| No inner state | MIRROR architecture (temporal decoupling) | Jun 2025 | Talker/Thinker split: 21% avg improvement across models; 156% safety improvement |
| Fixed notification schedule | Trust-calibrated adaptive timing | 2025 | Adaptive calibration outperforms constant feedback (PLOS ONE research) |
| User-controlled only | Mixed-initiative hybrid | 2025 | Balance AI initiative with user control over when/what/where |

**New tools/patterns to consider:**
- **Liu et al. Inner Thoughts (CHI 2025):** G-Eval inspired 7-heuristic scoring with silence-duration adjustment. Open-sourced as Swimmy2 chatbot. Key: intrinsic motivation scoring on 1-5 scale using token probability.
- **MIRROR Architecture:** Persistent first-person narrative maintained across turns via parallel Thinker threads (goals/reasoning/memory). Progressive compression.
- **KNOWNO Framework:** Conformal prediction for uncertainty quantification — only request human input when prediction set has >1 option. Could enhance inner thoughts confidence.
- **ProactiveAgent library (leomariga/ProactiveAgent):** probability_weight parameter, engagement_threshold, configurable min/max sleep bounds. Pattern for parameterized proactive behavior.

**Deprecated/outdated:**
- **Always-on inner monologue:** Too expensive for personal assistant. Post-session evaluation is sufficient.
- **Fixed 30-min delivery delay:** Gap scanner currently uses fixed 30-min delay. Replace with timing model.
- **No affect suppression:** Research consensus: suppress non-urgent proactive messages when user is distressed.
</sota_updates>

<open_questions>
## Open Questions

Things that couldn't be fully resolved:

1. **Session boundary detection: inactivity timeout vs explicit signal**
   - What we know: No explicit session-end event exists. Sessions are created but never formally closed. Session summaries are generated in deepTick (6h cycle), not immediately.
   - What's unclear: Whether to add a session inactivity timeout (30 min no messages → session "ended") or to run inner thoughts only during existing deepTick/sleepTick cycles.
   - Recommendation: Run inner thoughts in deepTick for new session summaries created since last deep tick. This avoids adding a new timer/event system and fits the existing tiered architecture. The 6-hour cycle means some delay but is acceptable for non-urgent proactive follow-ups.

2. **Where to run inner thoughts: deepTick vs sleepTick?**
   - What we know: sleepTick already runs gap scanner (Phase 31). deepTick runs every 6 hours and generates session summaries.
   - What's unclear: Whether inner thoughts should piggyback on deepTick (more timely, 6h cycle) or sleepTick (daily, consolidated with gap scanner).
   - Recommendation: Run in deepTick after session summarization. Inner thoughts acts on recent sessions; waiting 24h for sleepTick loses timeliness. Gap scanner stays in sleepTick for batch processing.

3. **'Acted' vs 'fired' disambiguation**
   - What we know: DB has `markScheduledItemFired()` and `markScheduledItemDismissed()`. Trust score uses 'acted' status that doesn't exist as a DB method yet.
   - What's unclear: Whether engagement detection (user replied within 30 min of proactive message) is reliable enough to distinguish 'acted' from coincidental messages.
   - Recommendation: Add `markScheduledItemActed()` to DB. Use a conservative 15-min window. Only count as 'acted' if user's message appears to reference the proactive topic (simple keyword overlap check). Err on the side of leaving as 'fired' (neutral).

4. **Telegram "expand" pattern feasibility**
   - What we know: Telegram supports inline keyboard buttons. The current TelegramChannel uses grammY which supports inline keyboards.
   - What's unclear: Whether to implement a full inline keyboard for "Expand" / "Dismiss" buttons or just use text-based prompts.
   - Recommendation: Start with text-based format ("Reply to discuss, or ignore to dismiss."). Inline buttons can be added later if needed — they require callback query handling which adds complexity.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/proactive/scheduler.ts` — UnifiedScheduler delivery pipeline
- Existing codebase: `src/memory/trust-score.ts` — Trust score with proactiveAcceptRate/proactiveDismissRate signals
- Existing codebase: `src/memory/gap-scanner.ts` + `gap-diagnosis.ts` + `gap-actions.ts` — 3-stage gap scanner pipeline
- Existing codebase: `src/memory/affect-smoothing.ts` — SmoothedAffect with goalSignal
- Existing codebase: `src/memory/behavioral-signals.ts` — EMA-smoothed behavioral patterns including activeHours
- Existing codebase: `src/channels/api.ts` — WsResponse type with 'trigger' message type
- Existing codebase: `src/channels/telegram.ts` — formatMarkdownToHtml(), splitMessage()
- Existing codebase: `src/triggers/types.ts` — TriggerSource interface, parseUserIdPrefix()
- Existing codebase: `src/memory/memory.ts` — BackgroundGardener tiered tick structure

### Secondary (MEDIUM confidence)
- Liu et al. CHI 2025 "Proactive Conversational Agents with Inner Thoughts" (ACM DL, arXiv 2501.00383v2) — 7-heuristic scoring, G-Eval inspired, 24-participant study showing significant improvements
- Microsoft CHI 2025 "Need Help? Designing Proactive AI Assistants for Programming" (arXiv 2410.04596) — Natural breakpoints, 52% vs 38% engagement rates, 20s minimum interval
- MIRROR Architecture (arXiv 2506.00430v1) — Temporal decoupling (Talker/Thinker), 21% average improvement, persistent first-person narrative
- Adaptive Trust Calibration (PLOS ONE, PMC 8181412) — Targeted calibration cues outperform constant feedback
- KNOWNO Framework (robot-help.github.io) — Conformal prediction for uncertainty, minimal-help principle

### Tertiary (LOW confidence - needs validation)
- ProactiveAgent library (github.com/leomariga/ProactiveAgent) — probability_weight pattern, needs validation that parameterized approach is suitable
- CHI 2025 "Assistance or Disruption?" (arXiv) — Trade-off measurement (proactive agents increase efficiency but incur disruptions)
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Post-session LLM evaluation (inner thoughts) + timing model
- Ecosystem: Liu et al. CHI 2025, Microsoft CHI 2025, MIRROR, trust calibration
- Patterns: Asynchronous inner thoughts, timing model, per-channel formatting, feedback loops
- Pitfalls: Over-proacting, timing deadlocks, feedback loop gaps, affect-blind messaging

**Confidence breakdown:**
- Standard stack: HIGH — all existing codebase components, no new dependencies
- Architecture: HIGH — patterns validated by CHI 2025 research + map cleanly to existing codebase
- Pitfalls: HIGH — documented in research literature + derived from existing gap scanner pitfalls
- Code examples: HIGH — adapted from existing codebase modules (reflection.ts, gap-diagnosis.ts, trust-score.ts patterns)

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — proactive AI patterns stable, no breaking changes expected)
</metadata>

---

*Phase: 32-inner-thoughts-timing*
*Research completed: 2026-02-10*
*Ready for planning: yes*
