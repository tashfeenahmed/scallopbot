/**
 * The agent's built-in native tools and the loop hooks they need. The gateway
 * and the benchmark both register through here, so the bench always measures
 * the same tool set production runs.
 */
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentHooks } from '../agent/agent.js';
import { registerShellTools } from './shell/index.js';
import { registerTodoTool } from './todo/index.js';
import { registerWebTools } from './web/index.js';
import { persistLargeOutput } from './tool-output.js';
import { verifyOnStopNudge } from './verify/ledger.js';

export function registerAgentTools(registry: Pick<SkillRegistry, 'registerSkill' | 'getSkill'>): void {
  registerShellTools(registry);
  registerTodoTool(registry);
  registerWebTools(registry);
}

/** Hooks the core tools contribute: large-output persistence and the verify nudge. */
export function coreToolHooks(options: { workspace: string; contextWindowTokens?: number }): AgentHooks {
  return {
    postProcessToolResult: ({ sessionId, toolName, content }) =>
      persistLargeOutput(sessionId, toolName, content, { contextWindowTokens: options.contextWindowTokens }),
    verifyOnStop: (sessionId) => verifyOnStopNudge(sessionId, { workspace: options.workspace }),
  };
}
