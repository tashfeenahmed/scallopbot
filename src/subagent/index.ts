/**
 * Sub-Agent System
 *
 * Spawns focused, ephemeral sub-agents for parallel research,
 * data gathering, and independent task execution.
 */

export type {
  SubAgentStatus,
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
