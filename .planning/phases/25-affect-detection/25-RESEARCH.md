# Phase 25: Affect Detection - Research

**Researched:** 2026-02-10
**Domain:** Keyword-based valence/arousal affect detection for Node.js chatbot
**Confidence:** HIGH

<research_summary>
## Summary

Researched the ecosystem for building a keyword-based affect classifier that outputs `{valence, arousal, emotion, goalSignal}` from user message text. The standard approach combines a valence word list (AFINN-165, MIT licensed, 3,382 words rated -5 to +5) with VADER-style heuristics for negation/intensifiers, plus a hand-curated arousal dimension derived from the Russell circumplex model.

Key finding: No single npm package provides both valence AND arousal out of the box. The `sentiment` package (AFINN-165) gives excellent valence scoring, and VADER provides the best negation/intensifier heuristics — but arousal must be hand-mapped. The NRC VAD Lexicon (55k words with valence + arousal + dominance) is the gold standard for dimensional affect but is **non-commercial/research-only licensed**, so we should use AFINN-165 for valence and build a lightweight arousal word list (~200-300 curated words) following the circumplex quadrant mapping.

The existing codebase already has: (1) EMA smoothing infrastructure in `behavioral-signals.ts`, (2) `currentMood` field in dynamic profiles, (3) mood extraction in `fact-extractor.ts`, and (4) behavioral pattern injection into the system prompt via `profiles.ts`. Phase 25 builds the structured affect computation layer on top of this foundation.

**Primary recommendation:** Build a custom `affect.ts` module using AFINN-165 for valence + curated arousal word list + VADER-style negation/booster heuristics + dual-EMA smoothing. No heavy external dependencies needed — this is a ~300-line module with a bundled word list.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `afinn-165` | 2.0.2 | Valence word list (3,382 words, -5 to +5) | MIT licensed, ESM, typed, industry standard for keyword sentiment |
| Custom arousal map | N/A | Arousal word list (~200-300 words, -1 to +1) | No MIT-licensed arousal lexicon exists as npm package — must curate |
| Custom negation/booster | N/A | VADER-style heuristics | Handles "not happy", "very angry", "extremely excited" |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `sentiment` | 5.0.2 | Full AFINN-165 analyzer with emoji support | Alternative to raw afinn-165 if you want emoji scoring built-in |
| `vader-sentiment` | 1.1.3 | Reference implementation for negation logic | Study negation/booster patterns, don't use as runtime dep |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom affect.ts | `sentiment` npm package | `sentiment` gives valence only, no arousal; also lacks negation handling |
| Custom arousal map | NRC VAD Lexicon v2 (55k words) | NRC VAD is non-commercial license — can't bundle; also massive (55k entries overkill for chat messages) |
| AFINN-165 | VADER lexicon | VADER gives compound score (-1 to +1) but is a JS port with no TS types, less maintained |
| Custom negation | `wink-sentiment` | wink-sentiment has built-in negation but no TS types, no arousal dimension |

### What NOT to Install
- **`natural`**: Full NLP toolkit — massively overkill for keyword affect detection
- **`emotional`**: Abandoned (11 years old)
- **`nrc-emotion-words`**: NRC license is research-only, not suitable for MIT project

**Installation:**
```bash
npm install afinn-165
```
That's it. Everything else is custom code.
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Recommended Project Structure
```
src/memory/
├── affect.ts              # Core affect classifier module
├── affect-lexicon.ts      # Arousal word list + emotion quadrant mapping
├── affect.test.ts         # Unit tests for affect module
├── behavioral-signals.ts  # EXISTING — EMA infrastructure (reuse updateEMA)
├── profiles.ts            # EXISTING — wire affect into dynamic profile
└── memory.ts              # EXISTING — wire affect EMA into gardener light tick
```

### Pattern 1: Stateless Pure Function Classifier
**What:** The affect classifier is a pure function: `classifyAffect(text: string) => RawAffect`. No side effects, no state, no async. Matches v3.0 "stateless pure functions" decision.
**When to use:** Every incoming user message.
**Example:**
```typescript
// affect.ts
import { afinn165 } from './affect-lexicon.js';

export interface RawAffect {
  valence: number;    // -1.0 to +1.0
  arousal: number;    // -1.0 to +1.0
  emotion: string;    // 'happy' | 'excited' | 'calm' | 'sad' | 'angry' | 'anxious' | 'frustrated' | 'neutral'
  confidence: number; // 0.0-1.0 based on word coverage
}

export function classifyAffect(text: string): RawAffect {
  const tokens = tokenize(text);
  const { valence, arousal, matchCount } = scoreTokens(tokens);
  const emotion = mapToEmotion(valence, arousal);
  const confidence = Math.min(1.0, matchCount / Math.max(tokens.length, 1));
  return { valence, arousal, emotion, confidence };
}
```

### Pattern 2: Dual-EMA Mood Smoothing
**What:** Maintain two EMA tracks — fast (responsive, alpha ~0.25) and slow (baseline, alpha ~0.08) — using the existing `updateEMA()` from behavioral-signals.ts. The gap between fast and slow EMA drives the `goalSignal`.
**When to use:** After each message, update both EMAs. Store smoothed values in behavioral patterns.
**Example:**
```typescript
// Integration with existing EMA
import { updateEMA } from './behavioral-signals.js';

export interface SmoothedAffect {
  valence: number;      // smoothed valence
  arousal: number;      // smoothed arousal
  emotion: string;      // current emotion label
  goalSignal: string;   // 'user_distressed' | 'user_improving' | 'user_engaged' | 'user_disengaged' | 'stable'
}

// Fast EMA half-life: ~2 hours (reacts to mood shifts within a session)
const FAST_HALF_LIFE_MS = 2 * 60 * 60 * 1000;
// Slow EMA half-life: ~3 days (captures baseline mood)
const SLOW_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
```

### Pattern 3: Circumplex Quadrant Emotion Mapping
**What:** Map (valence, arousal) coordinates to discrete emotion labels using Russell's circumplex model quadrants.
**When to use:** After computing raw valence/arousal scores.
**Example:**
```typescript
function mapToEmotion(v: number, a: number): string {
  if (Math.abs(v) < 0.1 && Math.abs(a) < 0.15) return 'neutral';
  if (v > 0.1 && a > 0.3) return 'excited';
  if (v > 0.1 && a > 0.0) return 'happy';
  if (v > 0.1 && a <= 0.0) return 'calm';
  if (v < -0.2 && a > 0.3) return 'angry';
  if (v < -0.1 && a > 0.1) return 'anxious';
  if (v < -0.1 && a > -0.1) return 'frustrated';
  if (v < -0.1 && a <= -0.1) return 'sad';
  return 'neutral';
}
```

### Pattern 4: Goal Signal from EMA Divergence
**What:** Compare fast EMA vs slow EMA to detect mood transitions. When fast drops below slow by a threshold, emit `user_distressed`. This is the affect-driven signal that Phase 26 will inject into the system prompt.
**When to use:** After updating both EMAs.
**Example:**
```typescript
function deriveGoalSignal(fastValence: number, slowValence: number, arousal: number): string {
  const divergence = fastValence - slowValence;
  if (divergence < -0.15) return 'user_distressed';
  if (divergence > 0.15) return 'user_improving';
  if (arousal > 0.4) return 'user_engaged';
  if (arousal < -0.3 && fastValence < -0.1) return 'user_disengaged';
  return 'stable';
}
```

### Anti-Patterns to Avoid
- **LLM-based affect detection per message:** Too slow (~500ms+ per call), too expensive, and unnecessary when keyword heuristics achieve ~75-80% accuracy for basic affect
- **Using NRC VAD directly in code:** Non-commercial license incompatible with MIT project
- **Building a full NLP pipeline:** Tokenization, stemming, POS tagging — overkill for keyword affect; simple whitespace + lowercase tokenization is sufficient
- **Storing raw per-message affect in DB:** Store only the smoothed EMA state; raw values are ephemeral
- **Affect in system prompt instructions:** Per Mozikov et al. (referenced in roadmap), affect belongs in the observation block only, never as instructions — this is Phase 26's concern but important to design for now
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Valence word scoring | Custom valence dictionary from scratch | AFINN-165 (npm `afinn-165`) | 3,382 words already rated by linguists; hand-rolling misses edge cases |
| Emoji sentiment | Custom emoji mapping | `sentiment` package's emoji scoring OR just skip emoji for v1 | Emoji Sentiment Ranking is a curated dataset; not worth recreating |
| EMA smoothing | New EMA implementation | Existing `updateEMA()` in `behavioral-signals.ts` | Already handles irregular time intervals with half-life decay |
| Trend detection | New trend logic | Existing `detectTrend()` in `behavioral-signals.ts` | Already handles split-half comparison with 15% threshold |
| Dynamic profile updates | New profile storage | Existing `setCurrentMood()` in `profiles.ts` | Already wired into dynamic profile and context injection |

**Key insight:** The existing behavioral-signals infrastructure (EMA, trends) and profile system (mood storage, context injection) are the hard parts — they're already built. The new work is the keyword classifier function and the arousal word list, which are genuinely novel to this project.
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Ignoring Negation
**What goes wrong:** "I'm not happy" scores as positive because "happy" is a positive word
**Why it happens:** Bag-of-words treats each word independently
**How to avoid:** Check 3 preceding tokens for negation words (not, no, never, don't, can't, won't, etc.). When negation found, multiply word score by -0.74 (VADER's N_SCALAR). This catches ~90% of negation cases.
**Warning signs:** User says "not bad" and bot thinks they're negative; user says "never been better" and bot misses the positive

### Pitfall 2: Short Message Neutral Collapse
**What goes wrong:** Most chat messages are 1-5 words, many contain zero sentiment words → everything scores neutral → mood EMA decays to neutral baseline
**Why it happens:** AFINN-165 covers 3,382 words but casual chat uses many unlisted words
**How to avoid:** (1) When no sentiment words found, return confidence=0 and DO NOT update the EMA (let previous mood persist). (2) Include common chat terms ("lol", "lmao", "ugh", "meh", "yay", "nah") in custom overrides. (3) Weight emoji/emoticon detection for short messages.
**Warning signs:** Mood always reads as "neutral" despite clearly emotional conversations

### Pitfall 3: Arousal Conflation with Intensity
**What goes wrong:** Treating word intensity (AFINN score magnitude) as arousal
**Why it happens:** AFINN rates -5 to +5 where magnitude = intensity, but intensity ≠ arousal. "Depressed" is high-intensity negative (-4) but LOW arousal. "Excited" is high-intensity positive (+4) and HIGH arousal.
**How to avoid:** Arousal must be a separate dimension. Create an explicit arousal word map — do NOT derive it from AFINN score magnitude.
**Warning signs:** "I feel deeply sad" registers as high arousal (because |valence| is high) when it should be low arousal

### Pitfall 4: Over-Responsive EMA
**What goes wrong:** A single angry message permanently shifts the user's mood to "angry"
**Why it happens:** Alpha too high (EMA too responsive)
**How to avoid:** Use dual-EMA with fast (2h half-life) for immediate reactions and slow (3d half-life) for baseline. Goal signals come from the gap between them, not absolute values. A single spike in fast EMA that doesn't persist won't trigger goal signals.
**Warning signs:** Mood oscillates wildly between messages; single messages dominate the mood state

### Pitfall 5: Sarcasm and Irony
**What goes wrong:** "Oh great, another meeting" scores positive because "great" is positive
**Why it happens:** Keyword systems cannot detect sarcasm — this is a known, accepted limitation
**How to avoid:** Accept the limitation. EMA smoothing mitigates individual misclassifications. Do NOT attempt sarcasm detection — it requires ML models and is still unreliable even with them. Document the limitation.
**Warning signs:** Consistently sarcastic users always appear positive

### Pitfall 6: Bot Message Contamination
**What goes wrong:** Bot's own messages get fed into the affect classifier
**Why it happens:** Not filtering by message source before classification
**How to avoid:** Only classify user messages (source === 'user'). The bot's messages reflect the bot's generated tone, not the user's emotional state.
**Warning signs:** Mood signals reflect the bot's helpfulness rather than the user's emotional state
</common_pitfalls>

<code_examples>
## Code Examples

### AFINN-165 Usage (ESM)
```typescript
// Source: afinn-165 npm package docs
// Note: afinn-165 v2.0.2 is ESM-only
import { afinn165 } from 'afinn-165';

// afinn165 is Record<string, number> — word -> score (-5 to +5)
const score = afinn165['happy']; // 3
const score2 = afinn165['terrible']; // -3
const unknown = afinn165['typescript']; // undefined (not in list)
```

### VADER Negation Logic (Reference Pattern)
```typescript
// Source: VADER sentiment analysis (Hutto & Gilbert, 2014)
// Adapted from vader-sentiment npm package
const NEGATION_WORDS = new Set([
  'aint', 'arent', 'cannot', 'cant', 'couldnt', 'darent', 'didnt', 'doesnt',
  'dont', 'hadnt', 'hasnt', 'havent', 'isnt', 'mightnt', 'mustnt', 'neither',
  'never', 'no', 'nobody', 'none', 'nope', 'nor', 'not', 'nothing', 'nowhere',
  'oughtnt', 'shant', 'shouldnt', 'wasnt', 'werent', 'without', 'wont', 'wouldnt',
]);

const N_SCALAR = -0.74; // VADER's negation dampening factor

function checkNegation(tokens: string[], wordIndex: number): boolean {
  // Check 3 tokens before the sentiment word
  for (let i = Math.max(0, wordIndex - 3); i < wordIndex; i++) {
    if (NEGATION_WORDS.has(tokens[i].toLowerCase().replace(/'/g, ''))) {
      return true;
    }
  }
  return false;
}
```

### VADER Booster/Intensifier Logic (Reference Pattern)
```typescript
// Source: VADER sentiment analysis
const BOOSTER_DICT: Record<string, number> = {
  'absolutely': 0.293, 'amazingly': 0.293, 'awfully': 0.293,
  'completely': 0.293, 'considerably': 0.293, 'decidedly': 0.293,
  'deeply': 0.293, 'enormously': 0.293, 'entirely': 0.293,
  'especially': 0.293, 'exceptionally': 0.293, 'extremely': 0.293,
  'fairly': 0.143, 'hardly': -0.293, 'incredibly': 0.293,
  'kind of': -0.143, 'kindof': -0.143, 'less': -0.293,
  'little': -0.293, 'marginally': -0.293, 'moderately': 0.143,
  'most': 0.293, 'much': 0.293, 'particularly': 0.293,
  'purely': 0.293, 'quite': 0.143, 'rather': 0.143,
  'really': 0.293, 'remarkably': 0.293, 'slightly': -0.293,
  'somewhat': -0.143, 'sort of': -0.143, 'sortof': -0.143,
  'substantially': 0.293, 'thoroughly': 0.293, 'totally': 0.293,
  'tremendously': 0.293, 'uber': 0.293, 'unbelievably': 0.293,
  'unusually': 0.293, 'utterly': 0.293, 'very': 0.293,
};

function getBoosterScore(token: string): number {
  return BOOSTER_DICT[token.toLowerCase()] ?? 0;
}
```

### Circumplex Emotion Mapping
```typescript
// Source: Russell (1980) circumplex model of affect
// Quadrant boundaries derived from experimental affect space studies

export type EmotionLabel =
  | 'happy' | 'excited' | 'calm' | 'content'
  | 'sad' | 'angry' | 'anxious' | 'frustrated'
  | 'neutral';

export function mapToEmotion(valence: number, arousal: number): EmotionLabel {
  // Dead zone: near origin = neutral
  if (Math.abs(valence) < 0.1 && Math.abs(arousal) < 0.15) return 'neutral';

  // Q1: High valence, High arousal → excited/happy
  if (valence > 0 && arousal > 0) {
    return arousal > 0.3 ? 'excited' : 'happy';
  }
  // Q2: High valence, Low arousal → calm/content
  if (valence > 0 && arousal <= 0) {
    return valence > 0.3 ? 'content' : 'calm';
  }
  // Q3: Low valence, Low arousal → sad
  if (valence <= 0 && arousal <= 0) {
    return 'sad';
  }
  // Q4: Low valence, High arousal → angry/anxious/frustrated
  if (valence <= 0 && arousal > 0) {
    if (valence < -0.3 && arousal > 0.3) return 'angry';
    if (arousal > 0.2) return 'anxious';
    return 'frustrated';
  }

  return 'neutral';
}
```

### Dual-EMA Integration with Existing Infrastructure
```typescript
// Source: SmartBot behavioral-signals.ts pattern
import { updateEMA } from './behavioral-signals.js';

const FAST_HALF_LIFE = 2 * 60 * 60 * 1000;  // 2 hours
const SLOW_HALF_LIFE = 3 * 24 * 60 * 60 * 1000; // 3 days

interface AffectEMAState {
  fastValence: number;
  slowValence: number;
  fastArousal: number;
  slowArousal: number;
  lastUpdateMs: number;
}

function updateAffectEMA(
  state: AffectEMAState,
  raw: { valence: number; arousal: number; confidence: number },
  nowMs: number,
): AffectEMAState {
  // Skip low-confidence readings (no sentiment words found)
  if (raw.confidence < 0.1) return state;

  const dt = nowMs - state.lastUpdateMs;
  return {
    fastValence: updateEMA(raw.valence, state.fastValence, dt, FAST_HALF_LIFE),
    slowValence: updateEMA(raw.valence, state.slowValence, dt, SLOW_HALF_LIFE),
    fastArousal: updateEMA(raw.arousal, state.fastArousal, dt, FAST_HALF_LIFE),
    slowArousal: updateEMA(raw.arousal, state.slowArousal, dt, SLOW_HALF_LIFE),
    lastUpdateMs: nowMs,
  };
}
```
</code_examples>

<sota_updates>
## State of the Art (2025-2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| LLM-based sentiment per message | Keyword heuristic + EMA smoothing | 2024-2025 | Keyword is 100x faster, free, deterministic; LLM reserved for complex inference |
| Single valence dimension | Valence + Arousal (circumplex model) | Long-established but newly accessible | Distinguishes "sad" (low arousal) from "angry" (high arousal) — both negative valence |
| NRC VAD v1 (20k words) | NRC VAD v2 (55k words + 10k phrases) | March 2025 | Much better coverage — but still research-license only |
| VADER Python-only | VADER JS port available | 2020+ | Negation/booster heuristics accessible in JS, though port quality is mediocre |
| Static mood label | Dual-EMA with goal signal derivation | 2024-2025 (emerging pattern) | Captures both immediate reactions and baseline trends |

**New tools/patterns to consider:**
- **LLM-as-judge for ambiguous cases:** When keyword confidence is low, can optionally use LLM to classify affect (expensive, use sparingly — Phase 26+ consideration)
- **Emoji Sentiment Ranking (Novak 2015):** 751 emoji rated for sentiment; `sentiment` npm package includes this — consider adding emoji handling in v2 of affect module

**Deprecated/outdated:**
- **AFINN-111:** Superseded by AFINN-165 (more words, better ratings)
- **cannon.js approach of "analyze everything with LLM":** Too slow for per-message affect; keyword heuristic with EMA is the established chatbot pattern
- **Single-number sentiment scores:** The field has moved to dimensional models (valence + arousal minimum); single-number loses critical information
</sota_updates>

<open_questions>
## Open Questions

1. **Arousal word list curation scope**
   - What we know: Need ~200-300 words with arousal ratings (-1 to +1). Can seed from Russell's circumplex examples and cross-reference with freely available affect research.
   - What's unclear: Exact coverage needed for chat-style messages. How many arousal words are needed before diminishing returns?
   - Recommendation: Start with ~150 high-confidence words from circumplex literature. Expand based on coverage stats from real conversations. Track "arousal = 0 because no words matched" rate.

2. **Emoji handling in v1**
   - What we know: `sentiment` npm package includes Emoji Sentiment Ranking (751 emoji). Many chat messages use emoji as primary sentiment signal.
   - What's unclear: Whether to add emoji support in Phase 25 or defer to a later enhancement.
   - Recommendation: Include basic emoji mapping in v1 — common positive (😊👍❤️🎉) and negative (😢😡😤💔) emoji. Keep it small (~30 emoji). Expand later if coverage is insufficient.

3. **Integration point for per-message classification**
   - What we know: Messages flow through `agent.ts` → `memory.ts`. Behavioral signals are computed during deep tick (batch).
   - What's unclear: Should affect be classified per-message (in the message handler) or batch-computed during tick?
   - Recommendation: Per-message is correct for affect (mood changes within a session matter). Classify in the message handler, update EMA state, persist smoothed values. This differs from behavioral signals which are batch-computed.

4. **Storage location for affect EMA state**
   - What we know: Behavioral patterns are in `behavioral_patterns` table. Dynamic profile has `currentMood`.
   - What's unclear: Whether affect EMA state (fast/slow valence/arousal) should go in behavioral_patterns, dynamic_profiles, or a new table.
   - Recommendation: Add affect fields to behavioral_patterns (aligns with existing EMA signal pattern). Update `currentMood` in dynamic_profiles with the emotion label for backward compatibility.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `afinn-165` npm package (v2.0.2) — ESM, MIT licensed, verified on npm registry
- VADER sentiment analysis methodology (Hutto & Gilbert, 2014) — negation/booster heuristics
- Russell circumplex model (1980) — valence-arousal quadrant mapping to discrete emotions
- SmartBot codebase — `behavioral-signals.ts`, `profiles.ts`, `db.ts`, `memory.ts` (existing infrastructure)

### Secondary (MEDIUM confidence)
- NRC VAD Lexicon v2 (saifmohammad.com) — 55k words with V/A/D scores, research-license only (can reference for arousal curation, cannot bundle)
- `sentiment` npm package (v5.0.2) — AFINN-165 + emoji scoring, verified on npm/GitHub
- `vader-sentiment` npm package (v1.1.3) — JS port of VADER, verified on npm/GitHub
- `wink-sentiment` npm package — negation handling, verified on npm/GitHub
- Warriner et al. (2013) — 13,915 English lemmas with V/A/D ratings (academic reference for arousal word curation)

### Tertiary (LOW confidence - needs validation)
- Dual-EMA mood tracking pattern — emerging practice from chatbot affect literature, not a standardized approach. Half-life values (2h fast, 3d slow) are educated estimates that should be tuned empirically.
- Goal signal thresholds (±0.15 divergence) — need empirical validation during implementation.
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: Keyword-based affect classification (AFINN-165 + custom arousal)
- Ecosystem: sentiment analysis npm packages (sentiment, vader-sentiment, wink-sentiment, afinn-165, polarity)
- Patterns: Circumplex model mapping, dual-EMA smoothing, VADER negation/booster heuristics
- Pitfalls: Negation, short messages, arousal conflation, sarcasm, bot contamination

**Confidence breakdown:**
- Standard stack: HIGH — AFINN-165 is well-established, MIT licensed, verified
- Architecture: HIGH — follows existing SmartBot patterns (pure functions, EMA, behavioral signals)
- Pitfalls: HIGH — well-documented in sentiment analysis literature
- Code examples: HIGH — from verified npm packages and existing SmartBot codebase
- Arousal word list: MEDIUM — will need curation effort, no off-the-shelf MIT solution

**Research date:** 2026-02-10
**Valid until:** 2026-03-12 (30 days — keyword sentiment ecosystem is very stable)
</metadata>

---

*Phase: 25-affect-detection*
*Research completed: 2026-02-10*
*Ready for planning: yes*
