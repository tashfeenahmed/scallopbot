/**
 * Per-family reasoning-effort ladder.
 *
 * `effortFor(modelId, tier, purpose)` picks how hard a model should think for
 * a piece of work, then clamps that to what the model family actually
 * supports. Clamping only ever rounds DOWN to the nearest supported level;
 * it rises only to a model's own floor when the model cannot think less
 * (o-series has no "off"), and that case is flagged with `atFloor`.
 *
 * Desired level (before clamping):
 *
 * | purpose                      | fast | standard | capable |
 * |------------------------------|------|----------|---------|
 * | chat, tool_call, review, subagent | low  | low      | medium  |
 * | coding, planning, goal       | low  | medium   | high    |
 * | background, compaction       | off  | off      | off     |
 *
 * So Kimi thinks "low" for chat and goes to medium/high on the capable tier;
 * GPT-5.x gets reasoning_effort low/medium/high the same way.
 *
 * Wiring (not done here): in the agent loop, replace the
 * `mapThinkLevelToProvider(...)` call with
 *   const effort = effortFor(activeProvider.model ?? '', complexity.suggestedModelTier, purpose, { ceiling: this.thinkLevel });
 * and set `enableThinking: effort.enableThinking`,
 * `thinkingBudgetTokens: effort.thinkingBudgetTokens`, plus a new optional
 * `CompletionRequest.reasoningEffort = effort.reasoningEffort` that the
 * OpenAI provider sends as `reasoning_effort` (instead of today's fixed
 * 'high' when thinking is on), OpenRouter as `reasoning.effort`, and xAI as
 * `reasoning_effort`. Moonshot and Anthropic keep using the thinking flag and
 * budget. When `level` is null the family has no knob: send nothing.
 */

import type { ModelTier } from '../routing/complexity.js';

export type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const EFFORT_ORDER: readonly EffortLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export type EffortPurpose =
  | 'chat'
  | 'tool_call'
  | 'review'
  | 'subagent'
  | 'coding'
  | 'planning'
  | 'goal'
  | 'background'
  | 'compaction';

export type ModelFamily =
  | 'kimi'
  | 'gpt5'
  | 'gpt5-legacy'
  | 'o-series'
  | 'anthropic'
  | 'gemini'
  | 'grok'
  | 'toggle'
  | 'unknown';

/** The value sent as `reasoning_effort` / `reasoning.effort`. */
export type ReasoningEffortParam = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface EffortDecision {
  family: ModelFamily;
  /** What the ladder asked for before clamping. */
  desired: EffortLevel;
  /** What the model gets; null = the family has no effort knob (send nothing). */
  level: EffortLevel | null;
  enableThinking: boolean;
  /** For reasoning_effort-style APIs (GPT-5.x, o-series, Gemini/Grok via OpenRouter). */
  reasoningEffort?: ReasoningEffortParam;
  /** For budget-style APIs (Anthropic extended thinking, Kimi). */
  thinkingBudgetTokens?: number;
  /** True when the supported set forced a different level than desired. */
  clamped: boolean;
  /** True when the model's lowest level is above what was desired. */
  atFloor: boolean;
}

export interface EffortOptions {
  /** Operator ceiling (e.g. the configured THINK_LEVEL). Never exceeded. */
  ceiling?: EffortLevel;
}

const rank = (level: EffortLevel): number => EFFORT_ORDER.indexOf(level);
const minLevel = (a: EffortLevel, b: EffortLevel): EffortLevel => (rank(a) <= rank(b) ? a : b);
const stepUp = (level: EffortLevel, cap: EffortLevel): EffortLevel =>
  minLevel(EFFORT_ORDER[Math.min(rank(level) + 1, EFFORT_ORDER.length - 1)], cap);

const PURPOSE_BASE: Record<EffortPurpose, EffortLevel> = {
  chat: 'low',
  tool_call: 'low',
  review: 'low',
  subagent: 'low',
  coding: 'medium',
  planning: 'medium',
  goal: 'medium',
  background: 'off',
  compaction: 'off',
};

/** The ladder before any family clamping. */
export function desiredEffort(tier: ModelTier, purpose: EffortPurpose): EffortLevel {
  const base = PURPOSE_BASE[purpose];
  if (base === 'off') return 'off';
  if (tier === 'fast') return minLevel(base, 'low');
  if (tier === 'capable') return stepUp(base, 'high');
  return base;
}

const SUPPORTED: Record<ModelFamily, readonly EffortLevel[]> = {
  kimi: ['off', 'low', 'medium', 'high'],
  // GPT-5.1 and later accept reasoning_effort "none".
  gpt5: ['off', 'low', 'medium', 'high'],
  // gpt-5 / gpt-5-mini / gpt-5-nano: lowest is "minimal".
  'gpt5-legacy': ['minimal', 'low', 'medium', 'high'],
  'o-series': ['low', 'medium', 'high'],
  anthropic: ['off', 'low', 'medium', 'high', 'xhigh'],
  gemini: ['low', 'medium', 'high'],
  grok: ['low', 'high'],
  // Qwen/DeepSeek/GLM style: thinking is on or off, no levels.
  toggle: ['off', 'high'],
  unknown: [],
};

/** Budget tokens for budget-style families (same scale as thinking.ts). */
const BUDGET: Record<Exclude<EffortLevel, 'off'>, number> = {
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

export function modelFamily(modelId: string): ModelFamily {
  const id = modelId.toLowerCase().replace(/^[\w.-]+\//, '');
  if (/kimi|moonshot/.test(id)) return 'kimi';
  const gpt5 = id.match(/^gpt-5(?:\.(\d+))?/);
  if (gpt5) return gpt5[1] && Number(gpt5[1]) >= 1 ? 'gpt5' : 'gpt5-legacy';
  if (/^o\d/.test(id)) return 'o-series';
  if (/claude/.test(id)) return 'anthropic';
  if (/gemini/.test(id)) return 'gemini';
  if (/grok/.test(id)) return 'grok';
  if (/qwen|deepseek|glm|qwq/.test(id)) return 'toggle';
  return 'unknown';
}

/** Highest supported level <= desired; the lowest supported one if none is. */
export function clampEffort(
  desired: EffortLevel,
  supported: readonly EffortLevel[],
): { level: EffortLevel; atFloor: boolean } | null {
  if (supported.length === 0) return null;
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  const below = sorted.filter(l => rank(l) <= rank(desired));
  if (below.length > 0) return { level: below[below.length - 1], atFloor: false };
  return { level: sorted[0], atFloor: true };
}

function toReasoningParam(family: ModelFamily, level: EffortLevel): ReasoningEffortParam {
  if (level === 'off') return family === 'gpt5' ? 'none' : 'minimal';
  return level;
}

export function effortFor(
  modelId: string,
  tier: ModelTier,
  purpose: EffortPurpose,
  options: EffortOptions = {},
): EffortDecision {
  const family = modelFamily(modelId);
  let desired = desiredEffort(tier, purpose);
  if (options.ceiling) desired = minLevel(desired, options.ceiling);

  const clamped = clampEffort(desired, SUPPORTED[family]);
  if (!clamped) {
    return { family, desired, level: null, enableThinking: false, clamped: false, atFloor: false };
  }
  const { level, atFloor } = clamped;
  const decision: EffortDecision = {
    family,
    desired,
    level,
    enableThinking: level !== 'off',
    clamped: level !== desired,
    atFloor,
  };

  switch (family) {
    case 'kimi':
    case 'anthropic':
      if (level !== 'off') decision.thinkingBudgetTokens = BUDGET[level];
      break;
    case 'toggle':
      break;
    default:
      decision.reasoningEffort = toReasoningParam(family, level);
  }
  return decision;
}
