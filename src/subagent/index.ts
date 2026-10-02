/**
 * Sub-Agent System
 *
 * Spawns focused, ephemeral sub-agents for parallel research,
 * data gathering, and independent task execution.
 */

export type {
  SubAgentStatus,
  SubAgentContextMode,
  SubAgentRole,
  SubAgentWorkspaceMode,
  SpawnAgentInput,
  SubAgentRun,
  SubAgentResult,
  AnnounceEntry,
  SubAgentConfig,
} from './types.js';

export { DEFAULT_SUBAGENT_CONFIG } from './types.js';
export { SubAgentRegistry } from './registry.js';
export { AnnounceQueue } from './announce-queue.js';
export { SubAgentExecutor } from './executor.js';
export { buildStructuredSubAgentResult } from './result.js';
export type { StructuredSubAgentResult, SubAgentArtifact, SubAgentResultStatus } from './result.js';
export {
  formatAgentResult,
  formatAgentExited,
  formatAgentProgress,
  formatAnnounceEntry,
  isHarnessMessage,
  resultCapChars,
  AGENT_RESULT_MAX_CHARS,
  SELF_REPORT_LABEL,
  SPAWN_ACK_INSTRUCTION,
} from './messages.js';
export { agentReportPath, writeAgentReport, renderAgentReport } from './report.js';
export { createSubAgentSkills } from './tools.js';
export { DEFAULT_SUBAGENT_SKILLS } from './executor.js';
export type { AnnounceKind } from './types.js';
export { gatherAdvice, withMoaAdvice, formatAdviceMessage, isMoaEnabled, selectAdvisors, MOA_ADVISOR_SYSTEM } from './moa.js';
export type { MoaAdvice, MoaOptions } from './moa.js';
