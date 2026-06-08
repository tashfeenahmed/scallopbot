/**
 * Response Critic + Best-of-N selection.
 *
 * OpenHands' biggest quality lever on SWE-bench was inference-time scaling:
 * generate several candidate trajectories and use a CRITIC to pick the best,
 * rather than trusting a single greedy sample. Their critic was a trained
 * model, but they note even a cheap selector beats single-trajectory.
 *
 * This module provides:
 *   - a fast, dependency-free HEURISTIC critic (no LLM, no cost) that scores a
 *     candidate response on signals that correlate with quality, and
 *   - an optional LLM-judge critic for high-stakes turns, and
 *   - `selectBest` / `bestOfN` helpers to wire either scorer into a sampler.
 *
 * The heuristic is deliberately conservative and cheap so it can run on every
 * high-stakes turn without violating the no-paid-models budget constraint.
 */

import type { LLMProvider } from '../providers/types.js';

export interface CriticScore {
  /** Overall score in [0,1]; higher is better. */
  score: number;
  /** Per-signal breakdown for debugging/telemetry. */
  signals: Record<string, number>;
  reason: string;
}

const REFUSAL_PATTERNS = [
  /\bi (?:can(?:'|no)t|am unable to|cannot)\b/i,
  /\bi'?m (?:sorry|afraid)\b/i,
  /\bas an ai\b/i,
  /\bi don'?t have (?:access|the ability)\b/i,
];

const ERROR_LEAK_PATTERNS = [
  /\berror:/i,
  /\bundefined\b\s*$/i,
  /\[object Object\]/,
  /\btraceback \(most recent call last\)/i,
];

// Raw tool-call JSON that leaked into the visible answer instead of being executed.
const TOOL_JSON_LEAK = /\{\s*"(?:function|name)"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input)"\s*:/;

/**
 * Heuristic critic — scores a candidate response without any LLM call.
 *
 * @param response  the candidate assistant text
 * @param userMessage  the user's request (used for relevance signal)
 */
export function scoreResponseHeuristic(response: string, userMessage = ''): CriticScore {
  const text = response.trim();

  // An empty answer is useless regardless of any other signal — short-circuit
  // so it can never accrue credit for "not a refusal", "clean", etc.
  if (text.length === 0) {
    return { score: 0, signals: { nonEmpty: 0 }, reason: 'empty response' };
  }

  const signals: Record<string, number> = {};

  // 1. Non-empty: near-empty answers are nearly useless.
  signals.nonEmpty = text.length < 8 ? 0.2 : 1;

  // 2. Not a pure refusal: a response that is *only* a refusal scores low, but
  //    a refusal followed by substance (an alternative) is fine.
  const isRefusal = REFUSAL_PATTERNS.some((p) => p.test(text));
  signals.notRefusal = isRefusal && text.length < 160 ? 0.15 : isRefusal ? 0.7 : 1;

  // 3. No leaked errors / stack traces / raw object dumps.
  signals.clean = ERROR_LEAK_PATTERNS.some((p) => p.test(text)) ? 0.3 : 1;

  // 4. No leaked tool-call JSON (model emitted a tool call as prose).
  signals.noToolLeak = TOOL_JSON_LEAK.test(text) ? 0.2 : 1;

  // 5. Relevance: overlap between salient user terms and the response.
  signals.relevance = relevanceSignal(text, userMessage);

  // 6. Length sweet-spot: extremely short or runaway-long answers are penalized.
  const len = text.length;
  signals.length = len < 16 ? 0.4 : len > 16000 ? 0.6 : 1;

  // Weighted aggregate. Correctness-ish signals dominate; relevance/length nudge.
  const weights = { nonEmpty: 0.28, notRefusal: 0.18, clean: 0.18, noToolLeak: 0.16, relevance: 0.12, length: 0.08 };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (signals[k] ?? 0) * w;

  const weakest = Object.entries(signals).sort((a, b) => a[1] - b[1])[0];
  return {
    score: Math.max(0, Math.min(1, score)),
    signals,
    reason: `weakest signal: ${weakest[0]}=${weakest[1].toFixed(2)}`,
  };
}

function relevanceSignal(response: string, userMessage: string): number {
  const terms = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (terms.length === 0) return 1; // no salient terms to match — neutral
  const lower = response.toLowerCase();
  const unique = Array.from(new Set(terms));
  const hits = unique.filter((t) => lower.includes(t)).length;
  // Even partial overlap is fine; map to [0.5, 1] so relevance never alone tanks a good answer.
  return 0.5 + 0.5 * Math.min(1, hits / Math.min(unique.length, 6));
}

export interface Candidate {
  text: string;
}

export interface Selection<T extends Candidate> {
  best: T;
  bestIndex: number;
  scores: CriticScore[];
}

/**
 * Select the highest-scoring candidate using a synchronous scorer.
 * Ties resolve to the earliest candidate (greedy sample is index 0 by convention).
 */
export function selectBest<T extends Candidate>(
  candidates: T[],
  scorer: (c: T) => CriticScore
): Selection<T> {
  if (candidates.length === 0) throw new Error('selectBest: no candidates');
  const scores = candidates.map(scorer);
  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].score > scores[bestIndex].score) bestIndex = i;
  }
  return { best: candidates[bestIndex], bestIndex, scores };
}

/**
 * Optional LLM-judge critic for high-stakes turns. Asks a provider to rate a
 * candidate 0-10 against the user request; returns a normalized [0,1] score.
 * Falls back to the heuristic on any error so it can never harden into a
 * single point of failure.
 */
export async function scoreResponseLLM(
  response: string,
  userMessage: string,
  provider: LLMProvider
): Promise<CriticScore> {
  try {
    const res = await provider.complete({
      system:
        'You are a strict response critic. Given a user request and a candidate answer, ' +
        'reply with ONLY a single integer 0-10 rating how well the answer satisfies the ' +
        'request (10 = excellent, 0 = useless/wrong/refusal). No other text.',
      messages: [
        { role: 'user', content: `USER REQUEST:\n${userMessage}\n\nCANDIDATE ANSWER:\n${response}\n\nScore (0-10):` },
      ],
      maxTokens: 8,
      temperature: 0,
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const m = text.match(/\d+(?:\.\d+)?/);
    if (!m) return scoreResponseHeuristic(response, userMessage);
    const raw = Math.max(0, Math.min(10, parseFloat(m[0])));
    return { score: raw / 10, signals: { llm: raw / 10 }, reason: `llm-judge=${raw}/10` };
  } catch {
    return scoreResponseHeuristic(response, userMessage);
  }
}

/**
 * Best-of-N: call `generate` up to N times to produce candidates, then select
 * the best by `scorer`. `generate(i)` receives the attempt index so callers can
 * vary temperature per attempt. Candidates that throw or come back empty are
 * skipped; if every attempt fails, throws.
 */
export async function bestOfN(
  n: number,
  generate: (attempt: number) => Promise<string>,
  scorer: (text: string) => CriticScore = (t) => scoreResponseHeuristic(t)
): Promise<{ best: string; bestIndex: number; scores: CriticScore[]; candidates: string[] }> {
  const attempts = Math.max(1, n);
  const candidates: string[] = [];
  for (let i = 0; i < attempts; i++) {
    try {
      const text = await generate(i);
      if (text && text.trim()) candidates.push(text);
    } catch {
      // skip failed attempt
    }
  }
  if (candidates.length === 0) throw new Error('bestOfN: all attempts failed');
  const sel = selectBest(candidates.map((text) => ({ text })), (c) => scorer(c.text));
  return { best: sel.best.text, bestIndex: sel.bestIndex, scores: sel.scores, candidates };
}
