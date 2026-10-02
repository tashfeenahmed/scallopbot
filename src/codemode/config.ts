/**
 * AGENT_MODE switch and the hybrid fallback.
 *
 *   AGENT_MODE=tool    normal tools (default)
 *   AGENT_MODE=code    one `exec` tool + the kernel API prompt
 *   AGENT_MODE=hybrid  normal tools + `execute_code`
 *
 * CODE_MODE_MODELS_DENYLIST lists models known to use the kernel badly
 * (comma-separated; `*` wildcards; matched case-insensitively against the
 * model id, with or without a `provider/` prefix). A denylisted model in code
 * mode falls back to CODE_MODE_FALLBACK (default `tool`; `hybrid` allowed).
 */

export type AgentMode = 'tool' | 'code' | 'hybrid';

export interface CodeModeConfig {
  mode: AgentMode;
  denylist: string[];
  fallback: Exclude<AgentMode, 'code'>;
}

function parseMode(value: string | undefined, fallback: AgentMode): AgentMode {
  const v = value?.trim().toLowerCase();
  return v === 'tool' || v === 'code' || v === 'hybrid' ? v : fallback;
}

export function codeModeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CodeModeConfig {
  const fallback = parseMode(env.CODE_MODE_FALLBACK, 'tool');
  return {
    mode: parseMode(env.AGENT_MODE, 'tool'),
    denylist: (env.CODE_MODE_MODELS_DENYLIST ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
    fallback: fallback === 'code' ? 'tool' : fallback,
  };
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function isModelDenylisted(modelId: string, denylist: readonly string[]): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return denylist.some(entry => {
    const re = patternToRegExp(entry.trim());
    return re.test(id) || re.test(bare);
  });
}

/** Should this model run in code mode (`exec` only) right now? */
export function shouldUseCodeMode(modelId: string, config: CodeModeConfig = codeModeConfigFromEnv()): boolean {
  return config.mode === 'code' && !isModelDenylisted(modelId, config.denylist);
}

/** Effective mode for one model: code mode drops to the fallback for denylisted models. */
export function resolveAgentMode(modelId: string, config: CodeModeConfig = codeModeConfigFromEnv()): AgentMode {
  if (config.mode !== 'code') return config.mode;
  return isModelDenylisted(modelId, config.denylist) ? config.fallback : 'code';
}
