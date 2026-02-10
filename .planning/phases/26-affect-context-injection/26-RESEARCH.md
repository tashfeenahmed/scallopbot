# Phase 26: Affect Context Injection - Research

**Researched:** 2026-02-10
**Domain:** Affect-aware system prompt design — observation-only affect blocks, affect guard patterns, and prompt section architecture for emotion-aware LLM chatbots
**Confidence:** HIGH

<research_summary>
## Summary

Researched how to wire affect signals into the agent's system prompt with proper guardrails. The key finding is that Phase 25-03 already implemented the core observation-only affect display in `formatProfileContext()` (profiles.ts:497-504) — but this context is **not consumed by the agent**. The agent's `buildMemoryContext()` (agent.ts:619-784) builds its own memory context inline, pulling behavioral patterns directly from the DB and only showing `communicationStyle` and `expertiseAreas`. The `formatProfileContext()` output (which includes affect) goes unused in the agent loop.

Phase 26's real work is therefore:
1. **Wire affect into the agent's actual prompt** — either refactor `buildMemoryContext()` to use `formatProfileContext()`, or add affect display directly to the existing inline behavioral patterns section in `buildMemoryContext()` (agent.ts:662-680)
2. **Add a dedicated "User Affect Context" observation block** — a separate `## USER AFFECT CONTEXT` section in the system prompt that presents the full affect state (emotion, valence, arousal, goal signal) with explicit observation framing
3. **Implement the affect guard** — explicit prompt engineering that tells the LLM "this is an observation about the user's emotional state, not an instruction to change your behavior" — the established pattern from emotion-aware chatbot research (MIND-SAFE framework, CHI 2025 studies)

The existing codebase has all the data (smoothedAffect, goalSignal stored in behavioral_patterns), all the formatting (formatProfileContext in profiles.ts), and all the types. The gap is purely architectural wiring and prompt design.

**Primary recommendation:** Add a `## USER AFFECT CONTEXT` observation block to `buildMemoryContext()` that reads `smoothedAffect` from behavioral patterns and formats it with an explicit observation-only preamble. Refactor the duplicated behavioral patterns display to use `formatProfileContext()` instead of the inline approach, eliminating code duplication.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Existing `profiles.ts` | N/A | ProfileContext formatting with affect display | Already built in Phase 25-03, includes smoothedAffect observation block |
| Existing `affect-smoothing.ts` | N/A | SmoothedAffect with goalSignal | Already built in Phase 25-02, provides the data |
| Existing `agent.ts` buildSystemPrompt/buildMemoryContext | N/A | System prompt assembly pipeline | The integration target — where affect needs to appear |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing `db.ts` getBehavioralPatterns | N/A | Retrieves affect state from SQLite | Already used in buildMemoryContext for comm style |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Dedicated `## USER AFFECT CONTEXT` block | Inline affect in existing behavioral patterns section (agent.ts:662-680) | Dedicated block is more explicit about observation-only framing; inline is simpler but risks affect being treated as part of behavioral instructions |
| Refactoring to use formatProfileContext() | Keep inline approach + add affect there | Refactoring eliminates duplication (behavioral patterns built twice: profiles.ts and agent.ts:662-680) but is a larger change |
| Custom affect-to-prompt formatter | Reuse formatProfileContext as-is | Custom gives finer control over what appears in the prompt; reuse is DRY but couples agent to profiles.ts format |

**Installation:**
```bash
# No new dependencies needed — all existing code
```
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Current System Prompt Structure (Before Phase 26)
```
buildSystemPrompt():
├── DEFAULT_SYSTEM_PROMPT (base instructions)
├── ITERATION BUDGET
├── Date/Time/Timezone
├── CHANNEL
├── FILE SENDING
├── Skills prompt (from skillRegistry)
├── SOUL.md (behavioral guidelines)
├── buildMemoryContext():              ← AFFECT GOES HERE
│   ├── ## YOUR IDENTITY
│   ├── ## USER PROFILE
│   ├── ## USER BEHAVIORAL PATTERNS    ← currently only style + expertise
│   ├── ## MEMORIES FROM THE PAST
│   └── ## PAST CONVERSATIONS
└── Goal context
```

### Pattern 1: Dedicated Observation Block with Affect Guard
**What:** Add a `## USER AFFECT CONTEXT` section between `## USER BEHAVIORAL PATTERNS` and `## MEMORIES FROM THE PAST` in `buildMemoryContext()`. Frame it explicitly as observation.
**When to use:** Always, when smoothedAffect is available.
**Why:** Research from MIND-SAFE (PMC 2025) and CHI 2025 studies show that emotional context should be presented as "background intelligence" (descriptive context) rather than "reactive commands" (behavioral instructions). Separating affect into its own section with an explicit observation preamble makes this distinction unambiguous.
**Example:**
```typescript
// In buildMemoryContext(), after USER BEHAVIORAL PATTERNS section:
if (behavioral?.smoothedAffect) {
  const sa = behavioral.smoothedAffect;
  let affectBlock = '\n\n## USER AFFECT CONTEXT\n';
  affectBlock += 'The following is an observation about the user\'s current emotional state. ';
  affectBlock += 'Use this to understand their mood, not as an instruction to change your behavior.\n';
  affectBlock += `- Current emotion: ${sa.emotion}\n`;
  affectBlock += `- Valence: ${sa.valence.toFixed(2)} (negative ← 0 → positive)\n`;
  affectBlock += `- Arousal: ${sa.arousal.toFixed(2)} (calm ← 0 → activated)\n`;
  if (sa.goalSignal !== 'stable') {
    affectBlock += `- Mood trend: ${sa.goalSignal}\n`;
  }
  context += affectBlock;
}
```

### Pattern 2: Observation-Only Framing (Affect Guard)
**What:** The "affect guard" — explicit natural language that frames affect data as observation, not instruction. Per Mozikov et al. and the MIND-SAFE framework, emotional data should inform the LLM's understanding without commanding behavior changes.
**When to use:** Every time affect data appears in the system prompt.
**Why:** Without explicit framing, LLMs can over-interpret emotional signals. A user with `user_distressed` signal might cause the LLM to become overly cautious, refuse tasks, or add unsolicited empathetic language. The guard pattern prevents this.
**Example preamble options:**
```
Option A (concise):
"The following is an observation about the user's emotional state. Use this for understanding, not as behavioral instruction."

Option B (explicit):
"User emotional state (observation only — do not modify your communication style or add unsolicited emotional support based on this data):"

Option C (minimal):
"User mood observation:"
```
**Recommendation:** Option A — concise but clear about the observation-only boundary.

### Pattern 3: Consolidate Behavioral Display (Refactor)
**What:** Replace the inline behavioral patterns section in `buildMemoryContext()` (agent.ts:662-680) with a call to `formatProfileContext()` or a shared formatting function. Currently the agent builds behavioral display inline (only style + expertise), while `formatProfileContext()` builds a richer version (style, expertise, messaging pace, session style, topic switching, message length trend, affect).
**When to use:** During Phase 26 refactoring.
**Why:** Eliminates duplication. The agent's current inline approach misses all the v3.0 behavioral signal insights (messageFrequency, sessionEngagement, topicSwitch, responseLength) AND the Phase 25 affect data. Consolidating ensures all behavioral data flows through one code path.
**Example:**
```typescript
// Replace agent.ts:662-680 with:
const profileContext = profileManager.formatProfileContext(userId);
if (profileContext.behavioralPatterns) {
  context += `\n\n## USER BEHAVIORAL PATTERNS${profileContext.behavioralPatterns}`;
}
```

### Pattern 4: Dynamic Profile currentMood Backward Compatibility
**What:** Keep `currentMood` in the dynamic context section as a backward-compatible label, but add the richer affect observation block separately.
**When to use:** Always — `currentMood` was the pre-Phase-25 field, still used for simple mood display.
**Why:** `currentMood` is a single word ("happy", "sad") shown in dynamic context. The affect observation block shows the full dimensional state (valence, arousal, emotion, goalSignal). Both serve different purposes — quick label vs. rich observation.

### Anti-Patterns to Avoid
- **Affect as instruction:** "When the user is distressed, be extra empathetic and gentle" — this is an instruction, not an observation. It causes the LLM to change behavior unpredictably.
- **Duplicate affect in multiple sections:** Don't show affect in both `## USER BEHAVIORAL PATTERNS` and a separate `## USER AFFECT CONTEXT`. Pick one location. Either use the dedicated block (recommended) or keep it inline in behavioral patterns, but not both.
- **Conditional system prompt swapping:** The emotion-sensitive chatbot pattern (Exploring Emotion-Sensitive LLM-Based Conversational AI, 2025) swaps entire system prompts based on detected emotion. This is heavy-handed for a personal assistant — observation injection is more appropriate.
- **Omitting the observation guard:** Without explicit framing, the LLM may treat affect data as an implicit instruction to change communication style. Always include the guard preamble.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Affect data retrieval | New DB queries for affect | Existing `getBehavioralPatterns()` → `smoothedAffect` | Already stored and deserialized in Phase 25 |
| Behavioral formatting | New formatting in agent.ts | Existing `formatProfileContext()` in profiles.ts | Already handles all behavioral signals including affect |
| Affect-to-text conversion | Custom affect string builder | SmoothedAffect's existing fields (.emotion, .valence, .arousal, .goalSignal) | Already structured with meaningful field names |
| EMA state management | New state tracking | Existing `updateAffectEMA()` in affect-smoothing.ts | Already wired in agent.processMessage (Phase 25-03) |
| Mood label for dynamic profile | New mood extraction | Existing `setCurrentMood()` call in agent.ts:283 | Already wired in Phase 25-03 |

**Key insight:** Phase 25 built all the affect data infrastructure. Phase 26's work is purely prompt engineering and architectural wiring — connecting existing formatted output to the agent's prompt assembly pipeline. The gap is that `buildMemoryContext()` in agent.ts builds its own behavioral display (only style + expertise) instead of using the richer `formatProfileContext()` output.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Affect as Behavioral Instruction
**What goes wrong:** The system prompt includes affect data in a way that makes the LLM change its communication style unpredictably ("User is distressed — be gentle and supportive")
**Why it happens:** Affect data placed near behavioral instructions is implicitly treated as instruction by the LLM
**How to avoid:** Use a dedicated observation block with explicit "this is an observation, not an instruction" preamble. Keep affect data physically separated from instruction sections (DEFAULT_SYSTEM_PROMPT, SOUL.md, CHANNEL)
**Warning signs:** The bot suddenly becomes overly empathetic, refuses to be direct, or adds unsolicited emotional support phrases

### Pitfall 2: Duplicate Behavioral Data
**What goes wrong:** Behavioral patterns appear twice in the prompt — once from `buildMemoryContext()` inline code (style + expertise only) and once from `formatProfileContext()` if wired
**Why it happens:** `buildMemoryContext()` already has inline behavioral display (agent.ts:662-680) that would conflict with formatProfileContext output
**How to avoid:** Either replace the inline code with formatProfileContext, or extend the inline code. Don't add a second display path alongside the existing one.
**Warning signs:** LLM context shows "Communication style: concise" twice, wasting token budget

### Pitfall 3: Affect Block When No Data Available
**What goes wrong:** A `## USER AFFECT CONTEXT` section appears with empty/null values on first interaction or when affect hasn't been computed yet
**Why it happens:** smoothedAffect is null until the first message is classified
**How to avoid:** Only inject the affect block when `smoothedAffect !== null`. Don't show an empty observation block — it wastes tokens and confuses the LLM
**Warning signs:** "Current emotion: null" or "Valence: NaN" appearing in system prompt

### Pitfall 4: Over-Sized Affect Block
**What goes wrong:** The affect observation block becomes too verbose, consuming token budget that should go to memories or session context
**Why it happens:** Adding too much detail (full EMA state, confidence scores, raw vs smoothed values, history)
**How to avoid:** Keep the affect block to 3-5 lines maximum: emotion label, valence, arousal, and goalSignal when non-stable. The EMA internals (fastValence, slowValence, lastUpdateMs) are implementation detail, not LLM context.
**Warning signs:** Affect block exceeds 200 characters; user facts get truncated due to token pressure

### Pitfall 5: Breaking Existing Test Assertions
**What goes wrong:** Refactoring the behavioral patterns section in buildMemoryContext changes the system prompt structure, breaking E2E tests that assert on prompt content
**Why it happens:** E2E tests (memory-lifecycle.test.ts) may assert on the exact format of behavioral patterns in the system prompt
**How to avoid:** Check existing test assertions before refactoring. If tests assert on "Communication style:" appearing in the system prompt, ensure the new format still includes it. Run the full test suite after changes.
**Warning signs:** E2E tests fail after prompt restructuring
</common_pitfalls>

<code_examples>
## Code Examples

### Current Inline Behavioral Display (to be replaced/extended)
```typescript
// Source: agent.ts:662-680 — current implementation
// This is the code that Phase 26 needs to modify
try {
  const db = this.scallopStore!.getDatabase();
  const behavioral = db.getBehavioralPatterns('default');
  if (behavioral) {
    let behavioralText = '';
    if (behavioral.communicationStyle) {
      behavioralText += `- Communication style: ${behavioral.communicationStyle}\n`;
    }
    if (behavioral.expertiseAreas && behavioral.expertiseAreas.length > 0) {
      behavioralText += `- Expertise areas: ${behavioral.expertiseAreas.join(', ')}\n`;
    }
    if (behavioralText) {
      context += `\n\n## USER BEHAVIORAL PATTERNS\n${behavioralText}`;
    }
  }
} catch {
  // Behavioral patterns not available, that's fine
}
```

### Existing formatProfileContext Affect Display (already built, unused by agent)
```typescript
// Source: profiles.ts:497-504 — built in Phase 25-03
// Affect signals (observation only — not instructions, per Mozikov et al.)
if (profile.behavioral.smoothedAffect) {
  const sa = profile.behavioral.smoothedAffect;
  behavioralPatterns += `\n  - Current affect: ${sa.emotion} (valence: ${sa.valence.toFixed(2)}, arousal: ${sa.arousal.toFixed(2)})`;
  if (sa.goalSignal !== 'stable') {
    behavioralPatterns += `\n  - Mood signal: ${sa.goalSignal}`;
  }
}
```

### Recommended Approach: Dedicated Affect Block with Guard
```typescript
// Add to buildMemoryContext(), after the behavioral patterns section:
// Read affect from already-fetched behavioral patterns
if (behavioral?.smoothedAffect) {
  const sa = behavioral.smoothedAffect;
  let affectBlock = '\n\n## USER AFFECT CONTEXT\n';
  affectBlock += 'Observation about the user\'s current emotional state — not an instruction to change your tone.\n';
  affectBlock += `- Emotion: ${sa.emotion}\n`;
  affectBlock += `- Valence: ${sa.valence.toFixed(2)} (negative ← 0 → positive)\n`;
  affectBlock += `- Arousal: ${sa.arousal.toFixed(2)} (calm ← 0 → activated)\n`;
  if (sa.goalSignal !== 'stable') {
    affectBlock += `- Mood trend: ${sa.goalSignal}\n`;
  }
  context += affectBlock;
}
```

### Alternative: Extend Existing Inline Section
```typescript
// Extend agent.ts:662-680 to include all behavioral data + affect
// Simpler but no refactoring, keeps duplication with profiles.ts
if (behavioral) {
  let behavioralText = '';
  if (behavioral.communicationStyle) {
    behavioralText += `- Communication style: ${behavioral.communicationStyle}\n`;
  }
  if (behavioral.expertiseAreas && behavioral.expertiseAreas.length > 0) {
    behavioralText += `- Expertise areas: ${behavioral.expertiseAreas.join(', ')}\n`;
  }
  // Add affect observation (Phase 26)
  if (behavioral.smoothedAffect) {
    const sa = behavioral.smoothedAffect;
    behavioralText += `- Current affect: ${sa.emotion} (valence: ${sa.valence.toFixed(2)}, arousal: ${sa.arousal.toFixed(2)})\n`;
    if (sa.goalSignal !== 'stable') {
      behavioralText += `- Mood signal: ${sa.goalSignal}\n`;
    }
  }
  if (behavioralText) {
    context += `\n\n## USER BEHAVIORAL PATTERNS\n${behavioralText}`;
  }
}
```

### Test Pattern for Affect in System Prompt
```typescript
// Verify affect appears in system prompt context
it('should include affect observation in system prompt when available', async () => {
  // Setup: create behavioral patterns with affect data
  const profileManager = store.getProfileManager();
  profileManager.updateBehavioralPatterns('default', {
    smoothedAffect: {
      emotion: 'happy',
      valence: 0.45,
      arousal: 0.32,
      goalSignal: 'user_engaged',
    },
  });

  // Build system prompt via agent
  const { prompt } = await agent.buildSystemPrompt('hello', sessionId, 'default');

  // Verify affect observation block exists
  expect(prompt).toContain('USER AFFECT CONTEXT');
  expect(prompt).toContain('Emotion: happy');
  expect(prompt).toContain('observation');
  // Verify it does NOT contain instruction-like framing
  expect(prompt).not.toContain('be more empathetic');
  expect(prompt).not.toContain('change your tone');
});
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Swap entire system prompt based on detected emotion | Inject affect as observation context within a single prompt | 2024-2025 | Less disruptive, more nuanced — LLM sees the data and decides how to respond naturally |
| Emotion as behavioral instruction ("be empathetic when user is sad") | Emotion as observation ("user emotion: sad, valence: -0.3") | 2025 (MIND-SAFE, CHI 2025) | Prevents over-reaction and manipulation; LLM retains its base personality |
| Single mood label ("happy", "sad") | Dimensional affect (valence + arousal + emotion label + goal signal) | Long-established in affect research, newly adopted in chatbot systems | Distinguishes "sad but calm" from "angry and agitated" — both negative valence, different arousal |
| Affect mixed into general instructions | Dedicated affect observation section | 2025 emerging pattern | Cleaner separation of concerns; easier to audit what the LLM "knows" vs what it's "told to do" |

**New tools/patterns to consider:**
- **MIND-SAFE framework (JMIR 2025):** Three-layer separation — User State Database (emotional awareness) → Dialogue Manager (strategy selection) → LLM Prompt (role + context, not raw emotion). Our architecture maps directly: BehavioralPatterns (USD) → buildMemoryContext (strategy) → system prompt (context injection).
- **Observation-only affect framing (CHI 2025):** Users intuitively structure emotion-awareness as "contextual background" rather than "response instructions". Our dedicated observation block follows this pattern.

**Deprecated/outdated:**
- **Conditional prompt selection based on emotion:** Switching between 3 system prompts (positive/negative/neutral) is too coarse-grained and causes behavioral discontinuities.
- **Emotion-reactive instructions:** "When user is upset, be extra gentle" — leads to patronizing behavior and reduces user autonomy.
</sota_updates>

<open_questions>
## Open Questions

1. **Dedicated section vs. inline behavioral extension?**
   - What we know: Both approaches work. Dedicated block (`## USER AFFECT CONTEXT`) is cleaner and more explicit about observation-only framing. Inline extension (adding affect to existing `## USER BEHAVIORAL PATTERNS`) is simpler and keeps the change minimal.
   - What's unclear: Whether LLMs respond differently to affect data when it's in its own section vs. buried in behavioral patterns.
   - Recommendation: Use dedicated section for clarity. The explicit observation guard text in its own section is harder for the LLM to ignore or misinterpret.

2. **Should Phase 26 refactor buildMemoryContext to use formatProfileContext?**
   - What we know: There's code duplication — agent.ts:662-680 builds a stripped-down version of what profiles.ts:468-504 already builds. Refactoring would eliminate duplication and ensure all behavioral signals (not just style + expertise) reach the LLM.
   - What's unclear: Whether the agent intentionally keeps a minimal version (to save tokens) or this is technical debt from incremental development.
   - Recommendation: Refactor to use formatProfileContext. The additional behavioral signals (messaging pace, session style, topic switching, response length) are valuable context. Token cost is minimal (~200 extra characters).

3. **Affect guard preamble wording**
   - What we know: Research consensus is that affect should be framed as observation. Exact wording matters — too strong ("DO NOT change behavior") may paradoxically draw attention to the affect data; too weak ("mood observation:") may not prevent over-interpretation.
   - What's unclear: Optimal preamble length and tone for the specific LLM provider (Anthropic vs OpenAI vs Kimi).
   - Recommendation: Start with concise preamble: "Observation about the user's current emotional state — not an instruction to change your tone." Test and tune based on observed behavior.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- SmartBot codebase — `agent.ts` buildSystemPrompt (lines 530-614), buildMemoryContext (lines 619-784), affect classification (lines 262-292)
- SmartBot codebase — `profiles.ts` formatProfileContext (lines 436-526), affect display (lines 497-504)
- SmartBot codebase — `affect-smoothing.ts` SmoothedAffect type, GoalSignal derivation
- Phase 25 research (25-RESEARCH.md) — affect architecture decisions, Mozikov et al. reference

### Secondary (MEDIUM confidence)
- [MIND-SAFE Framework (JMIR Mental Health 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12594504/) — Three-layer separation: emotional awareness as "background intelligence" not "reactive commands"; User State Database → Dialogue Manager → LLM Prompt architecture
- [Customizing Emotional Support (CHI 2025)](https://arxiv.org/html/2504.12943v1) — Users separate emotional context (what AI should know) from response guidance (how AI should respond); emotional awareness as contextual background
- [Emotion-Sensitive LLM Conversational AI (2025)](https://arxiv.org/html/2502.08920v1) — Conditional prompt selection pattern (positive/negative/neutral system prompts) — referenced as an anti-pattern for personal assistants
- [Emotional Prompting in AI](https://promptengineering.org/emotional-prompting-in-ai-transforming-chatbots-with-empathy-and-intelligence/) — Observation layer vs. instruction layer distinction; guardrail patterns for emotional prompting

### Tertiary (LOW confidence - needs validation)
- Affect guard preamble wording — educated best practice from research synthesis, not empirically tested. Should be tuned based on observed LLM behavior during implementation.
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: System prompt engineering for affect-aware context injection
- Ecosystem: Existing SmartBot infrastructure (profiles.ts, agent.ts, affect-smoothing.ts, db.ts)
- Patterns: Observation-only affect blocks, affect guard preambles, dedicated vs. inline context sections
- Pitfalls: Affect as instruction, duplicate data, empty blocks, over-sized blocks, test breakage

**Confidence breakdown:**
- Standard stack: HIGH — all code already exists, no new dependencies
- Architecture: HIGH — codebase fully explored, prompt assembly pipeline understood, clear integration points
- Pitfalls: HIGH — identified from codebase analysis and research literature
- Code examples: HIGH — from actual SmartBot source code

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — this is internal architectural work, no external ecosystem changes expected)
</metadata>

---

*Phase: 26-affect-context-injection*
*Research completed: 2026-02-10*
*Ready for planning: yes*
