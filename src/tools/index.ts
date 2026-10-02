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
 * and review-on-stop (off with REVIEW_ON_STOP=false).
 */
export function coreToolHooks(options: { workspace: string; contextWindowTokens?: number; review?: boolean }): AgentHooks {
  const review = options.review ?? process.env.REVIEW_ON_STOP !== 'false';
  return {
    postProcessToolResult: ({ sessionId, toolName, content }) =>
      persistLargeOutput(sessionId, toolName, content, { contextWindowTokens: options.contextWindowTokens }),
    verifyOnStop: (sessionId) => verifyOnStopNudge(sessionId, { workspace: options.workspace }),
    ...(review ? {
      reviewOnStop: async ({ sessionId, ...input }) => {
        const findings = await reviewOnStop({ ...input, workspace: options.workspace, traceSessionId: sessionId });
        return findings ? reviewNote(findings) : null;
      },
    } : {}),
  };
}
