# Phase 30: Self-Reflection - Research

**Researched:** 2026-02-10
**Domain:** LLM agent self-reflection, metacognitive distillation, evolving identity documents
**Confidence:** HIGH

<research_summary>
## Summary

Researched self-reflection patterns for LLM agents across five key papers: Renze & Guven 2024 (reflection taxonomy), Shinn et al. 2023 Reflexion (verbal reinforcement), MARS 2025 (metacognitive principle + procedural reflection), EvolveR 2025 (offline self-distillation into strategic principles), and SAGE 2024 (Ebbinghaus-curve memory optimization).

The standard approach combines **Composite reflection** (Renze & Guven's best-performing type at +14.6%) with **dual-output distillation**: (1) `insight`-category memories stored with DERIVES relations to source sessions, and (2) an evolving **SOUL.md** document that distills behavioral principles from accumulated reflections into the system prompt.

Key finding: SOUL.md injection already exists in `agent.ts:578-585` — reading `{workspace}/SOUL.md` into `## Behavioral Guidelines`. The reflection pipeline should both generate granular insight memories AND re-distill SOUL.md with new learnings, following MARS's principle-based reflection pattern (do's/don'ts from failures, strategies from successes).

**Primary recommendation:** Two-phase reflection: (1) generate process-focused insight memories from session summaries, (2) re-distill SOUL.md by merging old principles + new reflections via LLM, keeping it bounded (~500-800 words). Run after dream cycle in sleepTick.
</research_summary>

<standard_stack>
## Standard Stack

### Core (Already in Codebase)
| Library/Module | Location | Purpose | Why Standard |
|----------------|----------|---------|--------------|
| sleepTick | memory.ts:457-619 | Tier 3 scheduling | Already runs NREM+REM, self-reflection goes after |
| Session summaries | session-summary.ts | Input data | LLM-generated 2-3 sentence summaries with topics |
| ScallopMemoryStore | db.ts | Insight storage | `insight` category with DERIVES relations exists |
| SOUL.md injection | agent.ts:578-585 | System prompt | Already reads `{workspace}/SOUL.md` into prompt |
| fusionProvider | memory.ts constructor | LLM calls | Reuse existing provider for reflection LLM calls |

### New Modules to Create
| Module | Purpose | Pattern |
|--------|---------|---------|
| `reflection.ts` | Pure function: session summaries → reflections + SOUL update | Same pattern as `dream.ts`, `nrem-consolidation.ts` |
| SOUL.md | Persistent behavioral principles document | Written to workspace root, read by agent.ts |

### Supporting (Already Available)
| Module | Purpose | Reuse Pattern |
|--------|---------|---------------|
| ProfileManager | Agent identity profiles | SOUL.md complements existing `## YOUR IDENTITY` |
| formatProfileContext | Behavioral signals | Reflections can reference behavioral patterns |
| db.getSessionSummariesByUser | Retrieve summaries | Already exists for querying by user + time range |
| db.addRelation (DERIVES) | Link insights to sources | Same pattern as NREM consolidation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SOUL.md file | Static profile entries | File is more readable/editable, always in prompt |
| Re-distill SOUL.md each time | Append to SOUL.md | Append grows unbounded; re-distill keeps it compact |
| One LLM call | Two calls (reflect + distill) | Two calls cleaner but more cost; single call with structured output is viable |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Recommended Module Structure
```
src/memory/
├── reflection.ts          # Pure function: reflect(summaries, soulContent) → ReflectionResult
├── reflection.test.ts     # Unit tests with mock provider
└── (memory.ts)            # Wire into sleepTick after dream cycle
```

### Pattern 1: Composite Reflection (Renze & Guven)
**What:** Combine all reflection types into one prompt — explanation (why), advice (general guidance), instructions (step-by-step), solution (specific fixes). Composite outperforms individual types.
**When to use:** Always — it's the highest-performing single approach (+14.6% over baseline).
**Implementation:**
```typescript
// Reflection prompt structure (Composite type)
const reflectionPrompt = `
You are reflecting on today's interactions. Analyze these session summaries:

${sessionSummaries.map(s => `- [${s.topics.join(', ')}] ${s.summary}`).join('\n')}

Generate a composite reflection covering:
1. EXPLANATION: What went well and what could improve? Why?
2. PRINCIPLES: What do's/don'ts emerge from today's patterns?
3. PROCEDURES: What step-by-step strategies worked or should be tried?
4. ADVICE: What general guidance applies to future interactions?

Focus on PROCESS (how you interacted) not just OUTCOMES (what was discussed).
Output JSON: { reflections: string[], principles: string[], patterns: string[] }
`;
```

### Pattern 2: SOUL.md Re-Distillation (MARS + EvolveR Hybrid)
**What:** Instead of appending new reflections to SOUL.md, re-distill the entire document: feed old SOUL.md + new reflections to LLM, output a fresh, bounded SOUL.md.
**When to use:** Every reflection cycle. Prevents unbounded growth.
**Why:** MARS shows principle-based + procedural reflection hybrid is best (+7.1%). EvolveR shows distilling trajectories into reusable principles creates a closed improvement loop.
**Implementation:**
```typescript
// SOUL.md re-distillation prompt
const distillPrompt = `
You maintain a behavioral guidelines document for an AI assistant.

CURRENT GUIDELINES (may be empty if first reflection):
${currentSoulContent || '(No existing guidelines yet)'}

NEW REFLECTIONS FROM TODAY:
${reflections.map(r => `- ${r}`).join('\n')}

NEW PRINCIPLES DISCOVERED:
${principles.map(p => `- ${p}`).join('\n')}

Re-distill into an updated guidelines document:
- Keep what's still relevant from current guidelines
- Integrate new learnings naturally
- Remove redundant or outdated guidance
- Stay concise: aim for 400-600 words
- Structure: personality traits, interaction principles, known patterns, growth areas
- Write as instructions TO the assistant (you'll read this in your system prompt)

Output the complete updated document (markdown).
`;
```

### Pattern 3: Error-Isolated Sequential Execution (Existing Dream Pattern)
**What:** Run reflection after dreams with per-phase error isolation. If reflection fails, dreams still succeed.
**When to use:** Always — matches existing dream.ts orchestration pattern.
**Implementation:**
```typescript
// In sleepTick, after dream cycle:
let reflectionResult: ReflectionResult | null = null;
try {
  reflectionResult = await reflect(todaySummaries, currentSoulContent, provider);
} catch (err) {
  this.logger.warn({ error: (err as Error).message }, 'Self-reflection failed');
  // Dreams and other sleep processing unaffected
}
```

### Anti-Patterns to Avoid
- **Appending to SOUL.md without compression:** Grows unbounded, consumes prompt budget
- **Reflecting without session data:** If no sessions today, skip reflection entirely
- **Storing SOUL.md updates as memories:** SOUL.md IS the distilled output; don't double-store
- **Reflecting on individual messages:** Reflect on session summaries (higher abstraction)
- **Ignoring existing SOUL.md in re-distillation:** Must read + merge, not replace from scratch
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reflection taxonomy | Custom prompt from scratch | Renze & Guven Composite type | Empirically validated (+14.6%), covers all reflection angles |
| Memory storage for insights | New storage mechanism | Existing `insight` category + DERIVES | Already supports decay, prominence, retrieval |
| Sleep scheduling | Custom timer/cron | Existing sleepTick Tier 3 | Already handles quiet hours, tick counting, 24h cadence |
| LLM provider management | New provider config | Reuse fusionProvider | Same fast-tier provider used for NREM/REM |
| Session retrieval | Custom SQL queries | db.getSessionSummariesByUser() | Already handles user filtering, ordering, limits |
| Relation creation | Custom graph operations | db.addRelation(id, sourceId, 'DERIVES', conf) | Existing pattern from NREM consolidation |
| SOUL.md file I/O | Custom file management | fs.readFile/writeFile to workspace path | agent.ts already reads from this exact location |

**Key insight:** This phase is almost entirely prompt engineering + orchestration. Every infrastructure component already exists. The only new artifacts are: (1) the `reflection.ts` module with LLM prompts, (2) the SOUL.md file written to workspace, and (3) wiring into sleepTick.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Reflection Hallucination
**What goes wrong:** LLM generates plausible-sounding reflections not grounded in actual session content
**Why it happens:** Session summaries are short (2-3 sentences); LLM fills gaps with generic advice
**How to avoid:** Include specific session topics and message counts in prompt; validate reflections reference actual summary content; keep reflection prompt tightly scoped to provided summaries
**Warning signs:** Reflections that could apply to any agent on any day

### Pitfall 2: SOUL.md Drift
**What goes wrong:** SOUL.md evolves away from user's actual preferences over many cycles
**Why it happens:** Re-distillation is lossy; each cycle can shift meaning slightly; single bad session overwrites accumulated wisdom
**How to avoid:** Weight existing SOUL.md content higher than new reflections in prompt; consider a minimum session threshold (e.g., skip if < 2 sessions today); periodically validate SOUL.md content is coherent
**Warning signs:** Agent personality shifts noticeably; user feedback contradicts SOUL.md guidelines

### Pitfall 3: Unbounded SOUL.md Growth
**What goes wrong:** SOUL.md exceeds prompt token budget, crowds out memory context
**Why it happens:** Re-distillation prompt doesn't enforce hard length limits; LLM tends to be additive
**How to avoid:** Hard token/word limit in prompt (400-600 words); validate output length; truncate or re-distill if over limit; measure SOUL.md size in tests
**Warning signs:** SOUL.md > 1000 words; memory context section shrinks

### Pitfall 4: No-Op Reflection Days
**What goes wrong:** Reflection runs when there's nothing meaningful to reflect on (0 sessions, or only trivial "hi" messages)
**Why it happens:** sleepTick fires on schedule regardless of activity
**How to avoid:** Gate reflection on minimum session count (>= 1 session with >= 3 messages); skip cleanly if threshold not met
**Warning signs:** SOUL.md fills with generic platitudes instead of specific learnings

### Pitfall 5: SOUL.md vs Agent Identity Conflict
**What goes wrong:** SOUL.md guidelines contradict hardcoded system prompt or static agent profile
**Why it happens:** SOUL.md is injected BEFORE memory context (higher priority) but AFTER base system prompt
**How to avoid:** SOUL.md should contain behavioral GUIDELINES, not override core system rules; base prompt sets boundaries, SOUL.md personalizes within them; test that reflection-generated SOUL.md doesn't contain system-prompt-overriding instructions
**Warning signs:** Agent ignoring base prompt rules; personality oscillation between SOUL.md and system prompt
</common_pitfalls>

<code_examples>
## Code Examples

### Reflection Module Signature
```typescript
// Source: Follows dream.ts pure function pattern
export interface ReflectionConfig {
  minSessions: number;          // default: 1
  minMessagesPerSession: number; // default: 3
  maxSoulWords: number;         // default: 600
}

export interface ReflectionResult {
  insights: Array<{
    content: string;           // The reflection text
    topics: string[];          // Related topics from sessions
    sourceSessionIds: string[];// For DERIVES relations
  }>;
  updatedSoul: string | null;  // New SOUL.md content, or null if no update
  skipped: boolean;            // True if insufficient sessions
  skipReason?: string;
}

export async function reflect(
  sessionSummaries: SessionSummaryRow[],
  currentSoulContent: string | null,
  provider: LLMProvider,
  config?: Partial<ReflectionConfig>,
): Promise<ReflectionResult>;
```

### Session Summary Retrieval (Today Only)
```typescript
// Source: Existing db.getSessionSummariesByUser pattern
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const recentSummaries = db.getSessionSummariesByUser(userId, 50)
  .filter(s => s.createdAt >= todayStart.getTime());
```

### Insight Storage Pattern (from NREM)
```typescript
// Source: memory.ts sleepTick NREM storage pattern (lines 513-558)
for (const insight of reflectionResult.insights) {
  const mem = await this.scallopStore.add({
    userId,
    content: insight.content,
    category: 'insight',
    importance: 7,
    confidence: 0.85,
    sourceChunk: insight.sourceSessionIds.join(' | '),
    metadata: {
      reflectedAt: new Date().toISOString(),
      topics: insight.topics,
      sourceSessionIds: insight.sourceSessionIds,
    },
    learnedFrom: 'self_reflection',
    detectRelations: false,
  });

  db.updateMemory(mem.id, { memoryType: 'derived' });

  // DERIVES relations to source session summaries
  for (const sessionId of insight.sourceSessionIds) {
    db.addRelation(mem.id, sessionId, 'DERIVES', 0.9);
  }
}
```

### SOUL.md Write Pattern
```typescript
// Source: agent.ts reads from workspace/SOUL.md (lines 578-585)
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

if (reflectionResult.updatedSoul) {
  const soulPath = path.join(workspace, 'SOUL.md');
  await fs.writeFile(soulPath, reflectionResult.updatedSoul, 'utf-8');
  this.logger.info('SOUL.md updated from self-reflection');
}
```
</code_examples>

<sota_updates>
## State of the Art (2024-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single reflection type | Composite reflection (all types combined) | Renze & Guven 2024 | +14.6% vs baseline; combining explanation+advice+instructions+solution |
| Store reflections only as memories | Dual output: memories + distilled principles doc | MARS/EvolveR 2025 | Principles always in prompt (guaranteed retrieval) vs memories (query-dependent) |
| Scalar reward signals | Verbal reinforcement in episodic memory | Reflexion 2023, NeurIPS | Richer feedback enables targeted improvement |
| Append-only reflection logs | Re-distillation (compress old + new) | EvolveR 2025 | Prevents unbounded growth; keeps principles fresh and relevant |
| Outcome-focused reflection | Process-focused reflection | Renze & Guven 2024 | "How did I interact?" more valuable than "what did I discuss?" |
| Independent reflection + identity | Reflection → SOUL.md → system prompt loop | MARS principle synthesis 2025 | Closed loop: reflect → distill → behave → reflect |

**New patterns to consider:**
- **MARS Hybrid:** Combine principle-based (do's/don'ts) with procedural (strategies) in same reflection — +7.1% over individual types
- **EvolveR Lifecycle:** Distill → Apply → Reinforce → Repeat creates genuine self-improvement loop
- **Metacognitive Learning (2025):** Agents that evaluate their own learning processes, not just task outcomes

**Validated but not needed here:**
- **Multi-agent debate reflection (MAR):** Overkill for single personal agent
- **Ebbinghaus forgetting curve (SAGE):** Already implemented via prominence decay in existing memory system
</sota_updates>

<open_questions>
## Open Questions

1. **SOUL.md update frequency — every sleep tick or only when significant?**
   - What we know: EvolveR distills after every cycle; MARS updates after failure groups
   - What's unclear: For a personal agent with ~1-5 sessions/day, is nightly too frequent?
   - Recommendation: Update every sleep tick but gate on minimum session threshold (>= 1 session with >= 3 messages). Re-distillation is idempotent — running with no new reflections should produce same SOUL.md.

2. **SOUL.md seeding — what does the initial document look like?**
   - What we know: First reflection has no existing SOUL.md to merge with
   - What's unclear: Should we start from a template or let it emerge organically?
   - Recommendation: Let first reflection create it from scratch based on first day's sessions. Include fallback in prompt: "If no existing guidelines, create initial guidelines from today's observations."

3. **Session summary quality as reflection input**
   - What we know: Summaries are 2-3 sentences with 3-7 topic tags
   - What's unclear: Are summaries rich enough for meaningful reflection?
   - Recommendation: Start with summaries; if reflections are too generic, consider also passing high-prominence memories from the day as supplementary context.

4. **SOUL.md and agent static profile overlap**
   - What we know: Agent identity is in static profile (`## YOUR IDENTITY`); SOUL.md is `## Behavioral Guidelines`
   - What's unclear: Will they conflict or complement?
   - Recommendation: SOUL.md focuses on behavioral patterns and interaction style; agent profile focuses on identity attributes (name, role). Keep them complementary. Do NOT have reflection modify agent static profile.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- Renze & Guven (2024) "Self-Reflection in LLM Agents" — arxiv.org/abs/2405.06682 — 8-type taxonomy, Composite best at +14.6%, process-focused findings
- Shinn et al. (NeurIPS 2023) "Reflexion: Language Agents with Verbal Reinforcement Learning" — arxiv.org/abs/2303.11366 — Actor/Evaluator/Self-Reflection trio, episodic memory buffer
- Existing codebase: agent.ts SOUL.md injection (lines 578-585), sleepTick (lines 457-619), dream.ts orchestrator, session-summary.ts

### Secondary (MEDIUM confidence)
- MARS (2025) "Learn Like Humans: Meta-cognitive Reflection" — arxiv.org/abs/2601.11974 — Principle + procedural reflection, hybrid +7.1%, JSON principle storage
- EvolveR (2025) "Self-Evolving LLM Agents" — arxiv.org/abs/2510.16079 — Offline self-distillation into strategic principles, lifecycle loop
- SAGE (2024) "Self-evolving Agents with Reflective and Memory-augmented Abilities" — arxiv.org/abs/2409.00872 — Ebbinghaus curve memory optimization, dual STM/LTM

### Tertiary (LOW confidence - needs validation)
- Prompt template specifics synthesized from multiple papers — exact prompt wording should be iterated during implementation
- SOUL.md word limit (400-600) — heuristic based on prompt token budget estimation, validate empirically
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: LLM self-reflection prompting, verbal reinforcement
- Ecosystem: Renze & Guven taxonomy, Reflexion, MARS, EvolveR, SAGE
- Patterns: Composite reflection, principle distillation, SOUL.md re-distillation
- Pitfalls: Hallucination, drift, unbounded growth, no-op days, identity conflict

**Confidence breakdown:**
- Standard stack: HIGH — all infrastructure already exists in codebase
- Architecture: HIGH — follows established dream.ts pure function + sleepTick wiring pattern
- Pitfalls: HIGH — grounded in paper findings + codebase constraints
- Code examples: HIGH — based on existing codebase patterns (NREM storage, SOUL.md injection)
- Reflection prompts: MEDIUM — synthesized from papers, need empirical iteration
- SOUL.md update mechanism: MEDIUM — novel combination of MARS + EvolveR patterns

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — reflection research is stable)
</metadata>

---

*Phase: 30-self-reflection*
*Research completed: 2026-02-10*
*Ready for planning: yes*
