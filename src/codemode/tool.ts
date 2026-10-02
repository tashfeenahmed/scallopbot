/**
 * The model-visible code tool: `exec {code}` (AGENT_MODE=code) or
 * `execute_code {code}` (hybrid: added next to the normal tools).
 */

import type { Logger } from 'pino';
import { defineSkill } from '../skills/sdk.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillExecutor } from '../skills/executor.js';
import {
  createRegistryCallTool,
  registryCatalog,
  type BackgroundEvent,
  type CallTool,
  type ShellBackend,
} from './api.js';
import { KernelManager, formatCellResult, setDefaultKernelManager } from './manager.js';
import { CODE_TOOL_NAME, EXECUTE_CODE_TOOL_NAME, buildExecuteCodeDescription } from './prompt.js';

export interface CodeModeDeps {
  workspace: string;
  /**
   * Registry the kernel API dispatches to and lists in the prompt. Defaults
   * to the registry the code tool is registered in. Pass the full registry
   * here when the agent itself sees a registry holding only `exec`.
   */
  toolRegistry?: SkillRegistry;
  /** Tool dispatcher; default calls the registry's native handlers / script executor. */
  callTool?: CallTool;
  /** Needed by the default callTool for script (SKILL.md) tools. */
  skillExecutor?: SkillExecutor | null;
  logger?: Logger;
  /** `exec` (code mode, default) or `execute_code` (hybrid). */
  toolName?: typeof CODE_TOOL_NAME | typeof EXECUTE_CODE_TOOL_NAME;
  cellTimeoutMs?: number;
  idleMs?: number;
  maxKernels?: number;
  snapshotDir?: string | null;
  shell?: (sessionId: string) => ShellBackend;
  /** A bash() job finished while the session was idle: inject `event.text` as a new turn. */
  onBashDone?: (event: BackgroundEvent) => void;
  /** Share one manager between `exec` and `execute_code` registrations. */
  manager?: KernelManager;
  /** Make this manager the one listKernelVariables() uses (default true). */
  setAsDefault?: boolean;
}

export interface RegisteredCodeTool {
  toolName: string;
  manager: KernelManager;
}

const EXEC_DESCRIPTION =
  'Run a JavaScript cell in your persistent Node.js kernel (top-level await; variables persist). The kernel API is listed in the system prompt. Returns printed output, stderr, the last expression value, and errors.';

export function registerCodeModeTool(registry: SkillRegistry, deps: CodeModeDeps): RegisteredCodeTool {
  const toolName = deps.toolName ?? CODE_TOOL_NAME;
  const tools = deps.toolRegistry ?? registry;
  const callTool = deps.callTool ?? createRegistryCallTool(tools, deps.skillExecutor);
  const manager = deps.manager ?? new KernelManager({
    workspace: deps.workspace,
    callTool,
    catalog: registryCatalog(tools),
    logger: deps.logger,
    cellTimeoutMs: deps.cellTimeoutMs,
    idleMs: deps.idleMs,
    maxKernels: deps.maxKernels,
    snapshotDir: deps.snapshotDir,
    shell: deps.shell,
    onBashDone: deps.onBashDone,
    hiddenTools: [CODE_TOOL_NAME, EXECUTE_CODE_TOOL_NAME],
  });
  if (deps.setAsDefault !== false) setDefaultKernelManager(manager);

  const mode = toolName === EXECUTE_CODE_TOOL_NAME ? 'execute_code' : 'exec';
  const description = mode === 'exec' ? EXEC_DESCRIPTION : buildExecuteCodeDescription(tools);

  const skill = defineSkill(toolName, description)
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to run as one cell' },
      },
      required: ['code'],
    })
    .onNativeExecute(async (ctx) => {
      const code = typeof ctx.args.code === 'string' ? ctx.args.code : '';
      if (!code.trim()) return { success: false, output: 'Missing required parameter: code' };
      try {
        const result = await manager.exec(ctx.sessionId, code, {
          userId: ctx.userId,
          userMessage: ctx.userMessage,
          signal: ctx.signal,
        });
        const output = formatCellResult(result, mode);
        return result.error && !result.interrupted
          ? { success: false, output, error: output }
          : { success: true, output };
      } catch (error) {
        const message = `kernel error: ${(error as Error).message}`;
        return { success: false, output: message, error: message };
      }
    })
    .build();
  registry.registerSkill(skill.skill);
  return { toolName, manager };
}

/** Hybrid mode: keep normal tools and add `execute_code` (same kernel per session). */
export function registerExecuteCodeTool(registry: SkillRegistry, deps: Omit<CodeModeDeps, 'toolName'>): RegisteredCodeTool {
  return registerCodeModeTool(registry, { ...deps, toolName: EXECUTE_CODE_TOOL_NAME });
}
