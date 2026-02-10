# Phase 31: Gap Scanner - Research

**Researched:** 2026-02-10
**Domain:** Proactive AI agent gap detection pipeline (PROBE-inspired 3-stage: Search → Identify → Act)
**Confidence:** HIGH

<research_summary>
## Summary

Researched the proactive AI agent ecosystem for building a gap scanner that detects unresolved threads, approaching deadlines, stale goals, and behavioral anomalies, then creates proactiveness-gated scheduled items. The research covered PROBE (Proactive Resolution Of BottlEnecks), the Proactive Agent framework (Tsinghua/thunlp), ContextAgent (NeurIPS 2025), the CHI 2025 proactive programming assistant, the Goldilocks Time Window, and ProactiveAgent library patterns.

Key finding: The 3-stage pipeline (Search → Identify → Act) maps cleanly to the existing codebase. Stage 1 (Search) should be **entirely rule-based heuristics** running SQL queries against existing tables — no ML needed. Stage 2 (Identify) uses a **single LLM call** to triage and diagnose collected signals. Stage 3 (Act) creates **proactiveness-gated scheduled_items** using the existing trust score dial. The biggest risk is false positives/notification fatigue — research shows even SOTA models have 34-50% false alarm rates, so conservative defaults and deduplication are critical.

**Primary recommendation:** Build Stage 1 as pure functions with SQL-driven heuristics (following goal-deadline-check.ts pattern). Stage 2 as a single LLM triage call (following reflection.ts pattern). Stage 3 as scheduled_item creation gated by proactiveness dial thresholds. Run the full pipeline in sleepTick (Tier 3) or optionally deepTick (Tier 2) for high-urgency signals.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Existing SQLite (better-sqlite3) | 11.x | Heuristic queries | Already in codebase, synchronous, perfect for rule-based gap detection |
| Existing LLM provider | N/A | Stage 2 triage | Reuse fusionProvider pattern for gap diagnosis |
| Existing scheduled_items | N/A | Stage 3 output | Already supports agent-created items with types and dedup |
| Existing behavioral-signals | N/A | Anomaly baselines | EMA-smoothed signals already computed in deep tick |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing trust-score | N/A | Proactiveness gating | Gate which gaps become notifications based on dial |
| Existing affect state | N/A | Stage 2 context | Inject user mood into LLM diagnosis for empathy |
| Existing session-summary | N/A | Unresolved thread detection | Query recent summaries for open questions |
| Existing goal-service | N/A | Stale goal detection | Query active goals for staleness scoring |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rule-based Stage 1 | LLM-based gap detection | LLM is expensive per tick, rules are free and deterministic |
| Single LLM triage (Stage 2) | Per-gap-type LLM calls | Single call is cheaper and sees all signals holistically |
| sleepTick execution | Dedicated cron job | sleepTick already exists, runs at quiet hours, fits the pattern |

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
│   ├── gap-scanner.ts          # Stage 1: Pure heuristic functions
│   ├── gap-scanner.test.ts     # Unit tests for all heuristics
│   └── memory.ts               # Wire into sleepTick (existing)
├── proactive/
│   └── scheduler.ts            # Existing — receives Stage 3 output
```

### Pattern 1: PROBE 3-Stage Pipeline (adapted)
**What:** Decompose proactivity into Search → Identify → Act
**When to use:** Any proactive gap detection scenario
**Architecture:**
```typescript
// Stage 1: Search — pure functions, no LLM, no I/O
interface GapSignal {
  type: 'unresolved_thread' | 'stale_goal' | 'approaching_deadline' | 'behavioral_anomaly' | 'missed_commitment';
  severity: 'low' | 'medium' | 'high';
  description: string;
  context: Record<string, unknown>;  // type-specific data
  sourceId: string;  // memory/goal/session ID
}

function scanForGaps(input: GapScanInput): GapSignal[]

// Stage 2: Identify — single LLM call to triage all signals
interface DiagnosedGap {
  signal: GapSignal;
  diagnosis: string;       // LLM-generated human-readable explanation
  actionable: boolean;     // Whether this warrants user notification
  suggestedAction: string; // What to tell the user
  confidence: number;      // 0.0-1.0
}

function buildGapDiagnosisPrompt(signals: GapSignal[], userContext: UserContext): CompletionRequest
function parseGapDiagnosis(response: string, signals: GapSignal[]): DiagnosedGap[]

// Stage 3: Act — create scheduled items gated by dial
interface GapAction {
  gap: DiagnosedGap;
  scheduledItem: ScheduledItemInput;  // Ready for db.addScheduledItem()
}

function createGapActions(
  diagnosed: DiagnosedGap[],
  dial: 'conservative' | 'moderate' | 'eager',
  existingItems: Array<{ message: string }>,  // for dedup
): GapAction[]
```

### Pattern 2: Rule-Based Heuristic Catalog (Stage 1)
**What:** Each gap type has specific, testable heuristics
**When to use:** Stage 1 search — all heuristics are pure functions
**Heuristics per type:**

**Unresolved Threads:**
- Session ended without resolution: last user message was a question (wh-word/? detection), no follow-up session within 48h
- Open commitment: bot said "I'll look into it" / "let me check" but no follow-up in subsequent sessions
- Abandoned session: session < 2 messages after a bot question

**Stale Goals:**
- Absolute staleness: `days_since_last_touch > 14` (configurable)
- Relative staleness: `days_since_last_touch / checkinFrequency > 3.0`
- Zero-velocity: no sub-task completions in last 2× expected interval
- Orphan goal: active goal with no linked tasks

**Approaching Deadlines:** (extends existing goal-deadline-check.ts)
- Already implemented for goals — extend to commitments detected in conversations
- Compound deadline: multiple deadlines within 48h of each other

**Behavioral Anomalies:**
- Session frequency drop: `sessions_this_week < 0.5 * avg_sessions_per_week`
- Message brevity trend: average word count decreasing over last 5 sessions
- Engagement drop: `avg_messages_per_session` declining below EMA baseline
- Activity time shift: user active outside typical hours (> 2σ from mean)

**Missed Commitments:**
- Commitment phrases in user messages: "I will", "I need to", "remind me to", "I should"
- Co-occurrence with temporal markers: "by Friday", "tomorrow", "next week"
- No completion event within extracted/default deadline

### Pattern 3: Proactiveness Dial Gating (Stage 3)
**What:** Different dial settings allow different gap severities through
**When to use:** Stage 3 — deciding which diagnosed gaps become notifications
**Thresholds:**
```typescript
const DIAL_THRESHOLDS = {
  conservative: {
    // Only high-severity, high-confidence gaps
    minSeverity: 'high',
    minConfidence: 0.7,
    maxDailyNotifications: 1,
    allowedTypes: ['approaching_deadline', 'missed_commitment'],
  },
  moderate: {
    // Medium+ severity with reasonable confidence
    minSeverity: 'medium',
    minConfidence: 0.5,
    maxDailyNotifications: 3,
    allowedTypes: ['approaching_deadline', 'missed_commitment', 'stale_goal', 'unresolved_thread'],
  },
  eager: {
    // All actionable gaps
    minSeverity: 'low',
    minConfidence: 0.3,
    maxDailyNotifications: 5,
    allowedTypes: ['approaching_deadline', 'missed_commitment', 'stale_goal', 'unresolved_thread', 'behavioral_anomaly'],
  },
} as const;
```

### Anti-Patterns to Avoid
- **LLM for Stage 1:** Using LLM to scan for gaps is expensive and non-deterministic. Rule-based heuristics are free, testable, and reproducible.
- **Per-gap LLM calls:** Calling LLM separately for each gap signal wastes tokens. Batch all signals into one triage call.
- **No deduplication:** Creating duplicate scheduled items for the same gap across sleep ticks. Always dedup via word overlap (existing pattern).
- **Notification flood:** Even with gating, creating too many items in one tick. Hard cap per tick + daily budget.
- **Ignoring dismiss signals:** If a user dismisses a gap notification, don't re-raise it. Track dismissed gap source IDs.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Scheduled item creation | Custom notification system | Existing scheduled_items table + UnifiedScheduler | Already handles recurring, dedup, LLM message gen, timezone |
| Proactiveness gating | Custom threshold logic | Existing trust-score.ts → proactivenessDial | Already computes conservative/moderate/eager from user behavior |
| Behavioral baselines | Custom rolling statistics | Existing behavioral-signals.ts EMA signals | Already tracks frequency, engagement, topic switching, response length |
| Deduplication | Custom string matching | Existing wordOverlap() from goal-deadline-check.ts | Already battle-tested for goal notifications |
| Session summary queries | Custom conversation scanning | Existing session_summaries table | Already has topics, messageCount, embedding, created_at |
| Affect context for Stage 2 | Custom mood detection | Existing affect.ts + affect-smoothing.ts | Already provides valence, arousal, emotion, goalSignal |
| LLM call pattern | Custom provider wrapping | Existing fusionProvider opt-in pattern | Already handles cost tracking, error isolation |

**Key insight:** This phase is primarily an **orchestration** problem, not a new-capability problem. Almost every building block exists — the gap scanner wires them together with Stage 1 heuristics and a Stage 2 LLM triage call.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Notification Fatigue / False Positives
**What goes wrong:** Agent creates too many notifications, user dismisses/ignores them, trust score drops, dial shifts to conservative, agent becomes useless
**Why it happens:** SOTA proactive agents have 34-50% false alarm rates (Proactive Agent paper). Rule-based heuristics can be even noisier without calibration.
**How to avoid:**
- Start with conservative defaults (maxDailyNotifications: 1 for conservative, 3 for moderate)
- Hard cap per sleep tick (e.g., max 3 gap actions per tick regardless of dial)
- Track dismiss rate — if dismiss_rate > 0.5 over 7 days, auto-downgrade dial
- Dedup against all pending scheduled items, not just same-type
**Warning signs:** Multiple pending gap-scanner items in scheduled_items table, dismiss rate rising

### Pitfall 2: Stale Heuristic Thresholds
**What goes wrong:** Default thresholds (14 days for stale goal, 48h for unresolved thread) don't fit user's actual patterns
**Why it happens:** Users have different rhythms — some check goals weekly, others monthly
**How to avoid:**
- Use the user's own behavioral signals as baselines (not hard-coded defaults)
- For stale goals: use `checkinFrequency` metadata if set, else fall back to behavioral patterns
- For unresolved threads: adjust based on typical session frequency from behavioral signals
**Warning signs:** All goals flagged as stale simultaneously, or none ever flagged

### Pitfall 3: LLM Triage Hallucinating Urgency
**What goes wrong:** LLM Stage 2 over-diagnoses signals as urgent/actionable when they're noise
**Why it happens:** LLMs tend toward helpfulness bias — they want to suggest actions
**How to avoid:**
- Explicit prompt instruction: "When in doubt, mark as NOT actionable. False silence is better than false alarm."
- Include user's proactiveness dial in prompt context so LLM calibrates to user preference
- Require confidence scores and threshold in Stage 3
**Warning signs:** All diagnosed gaps have confidence > 0.8 and actionable: true

### Pitfall 4: Re-raising Dismissed Gaps
**What goes wrong:** User dismisses a notification about a stale goal, next sleep tick re-detects and re-notifies
**Why it happens:** No memory of which gaps were already surfaced and dismissed
**How to avoid:**
- Store dismissed gap `sourceId + type` tuples
- In Stage 3, filter out gaps matching dismissed tuples
- Clear dismissed list after configurable cooldown (e.g., 30 days) or when source changes
**Warning signs:** Same notification appearing repeatedly after dismiss

### Pitfall 5: Commitment Detection False Positives
**What goes wrong:** "I will think about it" detected as commitment, user gets nagged about thinking
**Why it happens:** Naive regex on "I will" catches hedging language
**How to avoid:**
- Exclude hedging phrases: "I will think about", "I might", "I could", "maybe I'll"
- Require co-occurrence with concrete action verbs (not cognitive verbs)
- Require temporal marker for deadline extraction (else use very long default: 30 days)
**Warning signs:** Many commitment-type gaps about vague statements
</common_pitfalls>

<code_examples>
## Code Examples

Verified patterns from existing codebase modules:

### Stage 1: Pure Heuristic Function (following goal-deadline-check.ts pattern)
```typescript
// Source: Adapts pattern from src/memory/goal-deadline-check.ts
export interface GapScanInput {
  sessionSummaries: SessionSummaryRow[];  // Recent summaries
  activeGoals: GoalItem[];                // Active goals with metadata
  behavioralSignals: BehavioralPatterns;  // From behavioral_patterns table
  existingReminders: Array<{ message: string }>;  // For dedup
  now?: number;
}

export interface GapSignal {
  type: 'unresolved_thread' | 'stale_goal' | 'approaching_deadline'
    | 'behavioral_anomaly' | 'missed_commitment';
  severity: 'low' | 'medium' | 'high';
  description: string;
  context: Record<string, unknown>;
  sourceId: string;
}

export function scanForGaps(input: GapScanInput): GapSignal[] {
  const signals: GapSignal[] = [];
  signals.push(...scanStaleGoals(input.activeGoals, input.now));
  signals.push(...scanBehavioralAnomalies(input.behavioralSignals));
  // ... other scanners
  return signals;
}
```

### Stage 2: LLM Triage Prompt (following reflection.ts pattern)
```typescript
// Source: Adapts pattern from src/memory/reflection.ts buildReflectionPrompt
export function buildGapDiagnosisPrompt(
  signals: GapSignal[],
  userContext: { affect: SmoothedAffect | null; dial: string; recentTopics: string[] },
): CompletionRequest {
  const system = `You are a proactive personal assistant analyzing detected signals about your user's needs. For each signal, determine whether it warrants reaching out to the user.

Rules:
- When in doubt, mark as NOT actionable. False silence is better than false alarm.
- The user's proactiveness preference is "${userContext.dial}" — respect this.
- Consider the user's current mood: ${userContext.affect?.emotion ?? 'unknown'}
- Respond with JSON only: {"gaps": [{"index": 0, "actionable": true/false, "confidence": 0.0-1.0, "diagnosis": "...", "suggestedAction": "..."}]}`;

  const signalLines = signals.map((s, i) =>
    `Signal ${i}: [${s.type}] ${s.severity} severity — ${s.description}`
  ).join('\n');

  return {
    messages: [{ role: 'user', content: `DETECTED SIGNALS:\n${signalLines}\n\nDiagnose each signal (JSON only):` }],
    system,
    temperature: 0.2,
    maxTokens: 800,
  };
}
```

### Stage 3: Proactiveness-Gated Action Creation (following trust-score.ts pattern)
```typescript
// Source: Adapts proactiveness dial from src/memory/trust-score.ts
export function createGapActions(
  diagnosed: DiagnosedGap[],
  dial: 'conservative' | 'moderate' | 'eager',
  existingItems: Array<{ message: string }>,
): GapAction[] {
  const config = DIAL_THRESHOLDS[dial];
  const actions: GapAction[] = [];

  for (const gap of diagnosed) {
    if (!gap.actionable) continue;
    if (gap.confidence < config.minConfidence) continue;
    if (!config.allowedTypes.includes(gap.signal.type)) continue;
    if (severityRank(gap.signal.severity) < severityRank(config.minSeverity)) continue;

    // Dedup against existing items
    if (isDuplicate(gap.suggestedAction, existingItems)) continue;

    // Respect daily budget
    if (actions.length >= config.maxDailyNotifications) break;

    actions.push({
      gap,
      scheduledItem: {
        source: 'agent' as const,
        type: 'follow_up' as const,
        message: gap.suggestedAction,
        context: JSON.stringify({ gapType: gap.signal.type, sourceId: gap.signal.sourceId }),
        triggerAt: Date.now() + 30 * 60 * 1000,  // 30 min from now (next active period)
      },
    });
  }

  return actions;
}
```

### Integration Point: sleepTick (following dream/reflection wiring)
```typescript
// Source: Adapts pattern from memory.ts sleepTick
// In sleepTick, after dream() and reflect():
if (this.gapScannerProvider) {
  try {
    const signals = scanForGaps({ sessionSummaries, activeGoals, behavioralSignals, existingReminders });
    if (signals.length > 0) {
      const diagnosed = await diagnoseGaps(signals, userContext, this.gapScannerProvider);
      const actions = createGapActions(diagnosed, proactivenessDial, existingReminders);
      for (const action of actions) {
        this.db.addScheduledItem({ userId, ...action.scheduledItem });
      }
    }
  } catch (err) {
    this.logger.error({ error: (err as Error).message }, 'Gap scanner failed');
    // Error isolation — gap scanner failure doesn't break sleep tick
  }
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Reactive-only agents | PROBE 3-stage proactive pipeline | Oct 2025 | Formal decomposition: Search → Identify → Act |
| LLM-based gap detection | Rule-based heuristics + LLM triage | 2025 | Rules for detection (cheap, testable), LLM only for diagnosis |
| Fixed notification schedules | Proactiveness dial + trust calibration | 2025 | Adaptive frequency based on user acceptance/dismiss behavior |
| Single threshold for all users | Goldilocks Time Window | Apr 2025 (CHI) | Context-aware timing: too early = false alarms, too late = useless |
| Always-on monitoring | Sleep-time compute (Letta pattern) | 2025 | Batch gap detection during idle periods, not real-time |

**New tools/patterns to consider:**
- **PROBE benchmark** (arxiv 2510.19771): 3-stage proactive pipeline achieving 40% end-to-end with GPT-4. Validates our architecture choice.
- **Proactive Agent** (Tsinghua, arxiv 2410.12361): Task prediction formula Pt = fθ(Et, At, St). Best model: 66.47% F1. False alarm rate: 34-50%.
- **ContextAgent** (NeurIPS 2025, arxiv 2505.14668): 3-stage context extraction → necessity prediction → tool calling. 8.5% better than baselines.
- **CHI 2025 Proactive Programming Assistant**: 20-second minimum interval between suggestions. High frequency = -47% preference despite +11.6% productivity.
- **Goldilocks Time Window** (CHI 2025, arxiv 2504.09332): Debouncer mechanism (St ≠ St-1 || Rt mod 3 = 0). Key: too early = false positives, too late = missed window.
- **ProactiveAgent library** (github.com/leomariga/ProactiveAgent): probability_weight parameter (default 0.3), engagement_threshold, min/max sleep bounds.
- **Proactive Conversational AI Survey** (Deng et al., ACM TOIS 2025): Comprehensive taxonomy of proactive dialogue: open-domain, task-oriented, information-seeking.
- **ChatGPT Pulse** (Sep 2025): Researches for users based on past interactions without prompts. Google CC agent (Dec 2025): daily briefings.

**Deprecated/outdated:**
- **Always-on proactive monitoring:** Research consensus is that batch/sleep-time detection is better than continuous monitoring for personal assistants
- **ML-only commitment detection:** Microsoft Research showed rule-based trigger phrases ("I will", "I need to") achieve good recall for personal assistant use cases
- **Fixed notification timing:** The Goldilocks/CHI research shows adaptive timing outperforms fixed intervals
</sota_updates>

<open_questions>
## Open Questions

Things that couldn't be fully resolved:

1. **Where to run the pipeline: sleepTick vs deepTick?**
   - What we know: sleepTick runs daily during quiet hours (2-5 AM), deepTick runs every 6 hours
   - What's unclear: Whether high-urgency gaps (approaching deadline within 24h) should wait for sleep tick
   - Recommendation: Run full pipeline in sleepTick. Optionally run deadline-only scan in deepTick (lightweight, no LLM).

2. **Commitment detection scope**
   - What we know: Microsoft Research published trigger phrases that work well for email/chat commitments
   - What's unclear: How well these work on the specific conversation patterns in this bot (user may use casual language)
   - Recommendation: Start with high-confidence phrases only ("remind me to", "I need to", "don't let me forget"). Expand after observing real patterns.

3. **Session summary vs raw message scanning for unresolved threads**
   - What we know: Session summaries exist and are efficient to query. Raw messages have more detail.
   - What's unclear: Whether summaries capture enough signal to detect unresolved questions
   - Recommendation: Start with session summaries (topics array + summary text). Fall back to recent session messages only if summaries prove insufficient.

4. **Notification budget enforcement**
   - What we know: DIAL_THRESHOLDS define maxDailyNotifications per dial setting
   - What's unclear: How to track "daily" budget across multiple sleep ticks (if sleepTick runs multiple times)
   - Recommendation: Store last gap scan timestamp and count in behavioral_patterns or bot_config. Reset daily.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/memory/goal-deadline-check.ts` — Pattern for pure heuristic functions
- Existing codebase: `src/memory/reflection.ts` — Pattern for LLM triage with prompt building
- Existing codebase: `src/memory/trust-score.ts` — Proactiveness dial computation
- Existing codebase: `src/proactive/scheduler.ts` — Scheduled item execution
- Existing codebase: `src/memory/behavioral-signals.ts` — EMA-smoothed baselines
- Existing codebase: `src/memory/affect.ts` — Affect classification

### Secondary (MEDIUM confidence)
- PROBE benchmark (arxiv 2510.19771) — 3-stage pipeline decomposition, 40% end-to-end
- Proactive Agent (arxiv 2410.12361) — Task prediction, false alarm analysis (34-50% rate)
- CHI 2025 Proactive Programming Assistant (arxiv 2410.04596) — 20s min interval, frequency studies
- Goldilocks Time Window (arxiv 2504.09332) — Debouncer mechanism, timing factors
- ContextAgent (NeurIPS 2025, arxiv 2505.14668) — 3-stage context → necessity → action
- Proactive Conversational AI Survey (Deng et al., ACM TOIS 2025) — Taxonomy of proactive dialogue
- Microsoft Research commitment detection — Trigger phrases for email/chat commitments
- ProactiveAgent library (github.com/leomariga/ProactiveAgent) — probability_weight, engagement_threshold

### Tertiary (LOW confidence - needs validation)
- Letta sleep-time compute pattern — Architectural analogy confirmed but SmartBot's sleepTick is already similar
- Intercom unresolved question clustering — Commercial product, pattern confirmed in concept
- ChatGPT Pulse / Google CC Agent — Commercial products, limited implementation details available
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: SQLite heuristic queries + LLM triage pipeline
- Ecosystem: PROBE, Proactive Agent, ContextAgent, CHI 2025 proactive design
- Patterns: 3-stage pipeline, rule-based detection, proactiveness gating, notification budgets
- Pitfalls: False positives, notification fatigue, commitment detection noise, re-raising dismissed gaps

**Confidence breakdown:**
- Standard stack: HIGH — all existing codebase components, no new dependencies
- Architecture: HIGH — 3-stage pipeline validated by PROBE + multiple papers, maps cleanly to existing patterns
- Pitfalls: HIGH — false alarm rates well-documented (34-50%), mitigation strategies clear
- Code examples: HIGH — adapted from existing codebase modules with verified patterns

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — proactive AI ecosystem stable, no breaking changes expected)
</metadata>

---

*Phase: 31-gap-scanner*
*Research completed: 2026-02-10*
*Ready for planning: yes*
