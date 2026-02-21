/**
 * Granular Thinking Levels
 *
 * Replaces the boolean enableThinking flag with a granular level system.
 * Supports per-provider mapping and auto-downgrade on failure.
 */

export type ThinkLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const THINK_LEVELS: ThinkLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Normalize a raw think level string to a valid ThinkLevel.
 * Handles common aliases like "on", "true", "ultra", etc.
 */
export function normalizeThinkLevel(raw: string): ThinkLevel {
  const lower = raw.toLowerCase().trim();

  // Direct matches
  if (THINK_LEVELS.includes(lower as ThinkLevel)) {
    return lower as ThinkLevel;
  }

  // Aliases
  switch (lower) {
    case 'on':
    case 'true':
    case 'yes':
    case 'enabled':
      return 'low';
    case 'false':
    case 'no':
    case 'disabled':
    case 'none':
      return 'off';
    case 'ultra':
    case 'max':
    case 'maximum':
      return 'xhigh';
    case 'default':
    case 'auto':
      return 'low';
    default:
      return 'off';
  }
}

export interface ThinkingParams {
  enableThinking: boolean;
  thinkingBudgetTokens?: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Map a ThinkLevel to provider-specific parameters.
 *
 * Provider mappings:
 * | Level   | Anthropic (Claude)       | OpenAI                  | Moonshot (Kimi K2)       | Others |
 * |---------|--------------------------|-------------------------|--------------------------|--------|
 * | off     | enableThinking: false    | —                       | thinking: disabled       | —      |
 * | minimal | budget: 2048             | —                       | budget: 2048             | —      |
 * | low     | budget: 4096             | reasoning_effort: low   | budget: 4096             | —      |
 * | medium  | budget: 8192             | reasoning_effort: medium| budget: 8192             | —      |
 * | high    | budget: 16384            | reasoning_effort: high  | budget: 16384            | —      |
 * | xhigh   | budget: 32768            | reasoning_effort: high  | budget: 32768            | —      |
 */
export function mapThinkLevelToProvider(
  level: ThinkLevel,
  provider: string,
  _model: string
): ThinkingParams {
  if (level === 'off') {
    return { enableThinking: false };
  }

  const budgetMap: Record<Exclude<ThinkLevel, 'off'>, number> = {
    minimal: 2048,
    low: 4096,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
  };

  const budget = budgetMap[level];

  switch (provider) {
    case 'anthropic':
      return {
        enableThinking: true,
        thinkingBudgetTokens: budget,
      };

    case 'openai': {
      const effortMap: Record<Exclude<ThinkLevel, 'off'>, 'low' | 'medium' | 'high'> = {
        minimal: 'low',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'high',
      };
      return {
        enableThinking: true,
        thinkingBudgetTokens: budget,
        reasoningEffort: effortMap[level],
      };
    }

    case 'moonshot':
      return {
        enableThinking: true,
        thinkingBudgetTokens: budget,
        // Moonshot Kimi K2 requires temperature=1.0 in thinking mode
        temperature: 1.0,
      };

    default:
      // Generic providers: just set the flag and budget
      return {
        enableThinking: true,
        thinkingBudgetTokens: budget,
      };
  }
}

/**
 * Get the next lower thinking level for fallback on errors.
 * Returns null if already at 'off' (no further downgrade possible).
 */
export function pickFallbackLevel(current: ThinkLevel): ThinkLevel | null {
  const idx = THINK_LEVELS.indexOf(current);
  if (idx <= 0) return null; // already 'off' or not found
  return THINK_LEVELS[idx - 1];
}

/**
 * Convert a boolean enableThinking to a ThinkLevel (for backward compat).
 */
export function booleanToThinkLevel(enabled: boolean): ThinkLevel {
  return enabled ? 'low' : 'off';
}
