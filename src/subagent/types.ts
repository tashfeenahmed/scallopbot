/**
 * Sub-Agent System Type Definitions
 *
 * Types for spawning focused, ephemeral sub-agents that handle
 * independent tasks with their own sessions and filtered tools.
 */

import type { EvidenceExecutionContext } from '../security/evidence-grounding.js';
import type { StructuredSubAgentResult } from './result.js';

export type SubAgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'timed_out'
  | 'lost';
export type SubAgentContextMode = 'isolated' | 'brief' | 'fork';
export type SubAgentRole = 'leaf' | 'orchestrator';
export type SubAgentWorkspaceMode = 'shared' | 'worktree';

/**
 * Input for spawning a sub-agent (maps to spawn_agent tool parameters)
 */
export interface SpawnAgentInput {
  task: string;
  label?: string;
  /** Stable, human-readable task identity used by the task ledger. */
  taskName?: string;
  /** Explicit task-specific context, separate from the instruction itself. */
  context?: string;
  /** Testable conditions the child must report individually. */
  acceptanceCriteria?: string[];
  skills?: string[];
  modelTier?: 'fast' | 'standard' | 'capable';
  contextMode?: SubAgentContextMode;
  role?: SubAgentRole;
  workspaceMode?: SubAgentWorkspaceMode;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  waitForResult?: boolean;
  /** Recent chat transcript for sub-agent context (injected by scheduler) */
  recentChatContext?: string;
  /** Opaque scheduler-owned evidence binding; never authored by the model. */
  evidenceExecutionContext?: EvidenceExecutionContext;
  /** Scheduler-owned lineage fields. Model-authored calls cannot override these. */
  parentRunId?: string;
  batchId?: string;
  batchIndex?: number;
  /** Internal workspace override for multi-stage implement/review/test workflows. */
  workspaceOverride?: string;
}

/**
 * Tracks a single sub-agent execution lifecycle
 */
export interface SubAgentRun {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  task: string;
  taskName?: string;
  context?: string;
  acceptanceCriteria?: string[];
  label: string;
  status: SubAgentStatus;
  allowedSkills: string[];
  modelTier: 'fast' | 'standard' | 'capable';
  timeoutMs: number;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  contextMode: SubAgentContextMode;
  role: SubAgentRole;
  workspaceMode: SubAgentWorkspaceMode;
  workspacePath?: string;
  parentRunId?: string;
  batchId?: string;
  batchIndex?: number;
  spawnDepth: number;
  result?: SubAgentResult;
  error?: string;
  /** Recent chat transcript for sub-agent context (injected by scheduler) */
  recentChatContext?: string;
  evidenceExecutionContext?: EvidenceExecutionContext;
  tokenUsage: { inputTokens: number; outputTokens: number };
  createdAt: number;
  startedAt?: number;
  lastProgressAt?: number;
  completedAt?: number;
}

/**
 * Result returned by a completed sub-agent
 */
export interface SubAgentResult extends StructuredSubAgentResult {
  response: string;
  iterationsUsed: number;
  taskComplete: boolean;
  /** Durable, non-prose source used to cross the task completion boundary. */
  completionSource?: 'explicit_done' | 'verified_tool_evidence';
  /** Actual tracked LLM spend for this isolated child session. */
  costUsd: number;
}

/**
 * Entry queued for the parent agent to receive on next iteration
 */
export interface AnnounceEntry {
  runId: string;
  parentSessionId: string;
  label: string;
  result: SubAgentResult;
  tokenUsage: { inputTokens: number; outputTokens: number };
  timestamp: number;
}

/**
 * Global configuration for the sub-agent system
 */
export interface SubAgentConfig {
  maxConcurrentPerSession: number;
  maxConcurrentGlobal: number;
  /** Maximum nested child depth. 0 disables child-created children. */
  maxSpawnDepth: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** Abort only after this much time without model/tool progress. */
  defaultIdleTimeoutSeconds: number;
  maxIdleTimeoutSeconds: number;
  defaultModelTier: 'fast' | 'standard' | 'capable';
  maxIterations: number;
  /** Hard token budget — sub-agent aborts if cumulative input tokens exceed this */
  maxInputTokens: number;
  maxCostUsdPerRun: number;
  maxSummaryChars: number;
  defaultContextMode: SubAgentContextMode;
  cleanupAfterSeconds: number;
  /** Retain compact, redacted run diagnostics after protocol payload cleanup. */
  diagnosticRetentionSeconds: number;
  allowMemoryWrites: boolean;
}

/**
 * Default sub-agent configuration
 */
export const DEFAULT_SUBAGENT_CONFIG: SubAgentConfig = {
  maxConcurrentPerSession: 3,
  maxConcurrentGlobal: 5,
  maxSpawnDepth: 1,
  /** No hard wall-clock timeout by default; progress-aware idle timeout governs. */
  defaultTimeoutSeconds: 0,
  maxTimeoutSeconds: 3600,
  defaultIdleTimeoutSeconds: 300,
  maxIdleTimeoutSeconds: 1800,
  defaultModelTier: 'fast',
  maxIterations: 10,
  maxInputTokens: 80_000,
  maxCostUsdPerRun: 2,
  maxSummaryChars: 12_000,
  defaultContextMode: 'brief',
  cleanupAfterSeconds: 3600,
  diagnosticRetentionSeconds: 30 * 24 * 60 * 60,
  allowMemoryWrites: false,
};
