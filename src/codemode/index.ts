/**
 * Code mode (Phase 7): a persistent JS kernel per session with the tool API
 * exposed as async functions, behind AGENT_MODE=code|hybrid.
 *
 * Wiring (gateway + agent):
 *  1. After every tool is registered (native, media, sub-agent, MCP):
 *       const cm = codeModeConfigFromEnv();
 *       if (cm.mode !== 'tool') registerCodeModeTool(registry, {
 *         workspace, skillExecutor, logger,
 *         toolName: cm.mode === 'code' ? 'exec' : 'execute_code',
 *         onBashDone: (e) => <inject e.text into e.sessionId as a harness turn>,
 *       });
 *  2. Per turn: mode = resolveAgentMode(provider.model ?? '', cm).
 *     code   → tools = [exec]; stable prompt += buildCodeModePrompt(registry)
 *              (build once and cache; it is byte-stable) instead of the
 *              per-tool skill listing.
 *     hybrid → normal tools + execute_code (API is in its description).
 *     tool   → hide exec and execute_code.
 *  3. Compaction: add CODE_MODE_COMPACTION_NOTE to the summary prompt and
 *     re-inject `await listKernelVariables(sessionId)` (when non-empty).
 *  4. /stop: pass the turn's AbortSignal to the tool (ctx.signal) or call
 *     getDefaultKernelManager()?.interrupt(sessionId).
 */
export { transformCell, CellSyntaxError, type TransformResult } from './transform.js';
export {
  Kernel,
  DEFAULT_CELL_TIMEOUT_MS,
  KERNEL_API_NAMES,
  OUTPUT_CAP_CHARS,
  formatVariables,
  readSnapshotFile,
  type CellResult,
  type KernelOptions,
  type KernelSnapshot,
  type KernelVariable,
} from './kernel.js';
export {
  KernelApi,
  API_TOOL_MAP,
  createAwaitedBashShell,
  createProcessToolShell,
  createRegistryCallTool,
  registryCatalog,
  type BackgroundEvent,
  type CallTool,
  type ShellBackend,
  type ToolCallContext,
  type ToolCallResult,
  type ToolCatalog,
} from './api.js';
export {
  KernelManager,
  formatCellResult,
  getDefaultKernelManager,
  kernelSnapshotPath,
  kernelsDir,
  listKernelVariables,
  setDefaultKernelManager,
  type ExecRequest,
  type KernelManagerOptions,
} from './manager.js';
export {
  CODE_MODE_COMPACTION_NOTE,
  CODE_TOOL_NAME,
  EXECUTE_CODE_TOOL_NAME,
  buildCodeModePrompt,
  buildExecuteCodeDescription,
  type CodeModePromptOptions,
} from './prompt.js';
export { registerCodeModeTool, registerExecuteCodeTool, type CodeModeDeps, type RegisteredCodeTool } from './tool.js';
export {
  codeModeConfigFromEnv,
  isModelDenylisted,
  resolveAgentMode,
  shouldUseCodeMode,
  type AgentMode,
  type CodeModeConfig,
} from './config.js';
