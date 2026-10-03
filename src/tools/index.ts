/**
 * The agent's built-in native tools and the loop hooks they need. The gateway
 * and the benchmark both register through here, so the bench always measures
 * the same tool set production runs.
 */
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentHooks } from '../agent/agent.js';
import { registerShellTools } from './shell/index.js';
import { registerFileTools, type FileTools, type FileToolsDeps } from './files/index.js';
import { registerTodoTool } from './todo/index.js';
import { registerWebTools } from './web/index.js';
import { persistLargeOutput } from './tool-output.js';
import { verifyOnStopNudge } from './verify/ledger.js';
import { reviewOnStop, reviewNote } from './review/review.js';
import { checkOnStop } from './review/check.js';

/** Register every built-in native tool; returns the stateful file tools. */
export function registerAgentTools(
  registry: Pick<SkillRegistry, 'registerSkill' | 'getSkill'>,
  options: { files?: FileToolsDeps } = {},
): { fileTools: FileTools } {
  const fileTools = registerFileTools(registry, options.files);
  registerShellTools(registry);
  registerTodoTool(registry);
  registerWebTools(registry);
  return { fileTools };
}

/**
 * Hooks the core tools contribute: large-output persistence, the verify nudge
 * and the second look before a turn that changed files ends. REVIEW_ON_STOP:
 * `run` (default) = check-on-stop, a fresh-context reviewer that may run
 * probes on a throwaway copy; `read` = read-only review; `false`/`off` = none.
 * On ScallopBench v2 (kimi-k2.6, 108 task-runs) check-on-stop moved the pass
 * rate from 105 to 106 and hard tasks from 43/45 to 44/45.
 */
export function coreToolHooks(options: { workspace: string; contextWindowTokens?: number; review?: 'read' | 'run' | false }): AgentHooks {
  const setting = (process.env.REVIEW_ON_STOP ?? 'run').toLowerCase();
  const review = options.review ?? (setting === 'read' ? 'read' : setting === 'false' || setting === 'off' ? false : 'run');
  return {
    postProcessToolResult: ({ sessionId, toolName, content }) =>
      persistLargeOutput(sessionId, toolName, content, { contextWindowTokens: options.contextWindowTokens }),
    verifyOnStop: (sessionId) => verifyOnStopNudge(sessionId, { workspace: options.workspace }),
    ...(review ? {
      reviewOnStop: async ({ sessionId, ...input }) => {
        const run = review === 'run' ? checkOnStop : reviewOnStop;
        const findings = await run({ ...input, workspace: options.workspace, traceSessionId: sessionId });
        return findings ? reviewNote(findings) : null;
      },
    } : {}),
  };
}
