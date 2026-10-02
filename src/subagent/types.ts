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
  /** LLM calls made so far (live, for check_agents). */
  iterations?: number;
  /** Latest progress_note text from the child. */
  progressNote?: string;
  progressNoteAt?: number;
  /** Where the child's final report was written (fan-in through files). */
  reportPath?: string;
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

export type AnnounceKind = 'agent-result' | 'agent-exited' | 'agent-progress';

/**
 * Entry queued for the parent agent to receive on next iteration.
 * Format it with formatAnnounceEntry() from ./messages.js.
 */
export interface AnnounceEntry {
  runId: string;
  parentSessionId: string;
  label: string;
  result: SubAgentResult;
  tokenUsage: { inputTokens: number; outputTokens: number };
  timestamp: number;
  /** Defaults to 'agent-result' when absent (legacy entries). */
  kind?: AnnounceKind;
  /** Full report text (uncapped; the formatter applies the cap). */
  report?: string;
  /** Report file the parent can read_file for the full text. */
  reportPath?: string;
  /** agent-exited: why the child stopped without a final answer. */
  exitReason?: string;
  /** agent-exited: the child's last assistant text (tail is shown). */
  lastText?: string;
  /** agent-progress: the note text. */
  progressNote?: string;
}

/**
 * Global configuration for the sub-agent system
 */
export interface SubAgentConfig {
  maxConcurrentPerSession: number;
  maxConcurrentGlobal: number;
  /**
   * Maximum sub-agent nesting below a top-level session. 1 = children only,
   * 2 (default) = children may spawn grandchildren, grandchildren cannot spawn.
   */
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
  /** Minimum gap between a child's progress_note calls. */
  progressNoteIntervalSeconds: number;
  /** Forward progress notes to the parent as [agent-progress: name] (never wakes it). */
  forwardProgressNotes: boolean;
}

/**
 * Default sub-agent configuration
 */
export const DEFAULT_SUBAGENT_CONFIG: SubAgentConfig = {
  maxConcurrentPerSession: 8,
  maxConcurrentGlobal: 24,
  maxSpawnDepth: 2,
  /** No hard wall-clock timeout by default; progress-aware idle timeout governs. */
  defaultTimeoutSeconds: 0,
  maxTimeoutSeconds: 3600,
  defaultIdleTimeoutSeconds: 300,
  maxIdleTimeoutSeconds: 1800,
  defaultModelTier: 'standard',
  maxIterations: 60,
  /** Cumulative across every call of a run; the $ cap is the real guard. */
  maxInputTokens: 4_000_000,
  maxCostUsdPerRun: 2,
  maxSummaryChars: 24_000,
  defaultContextMode: 'brief',
  cleanupAfterSeconds: 3600,
  diagnosticRetentionSeconds: 30 * 24 * 60 * 60,
  allowMemoryWrites: false,
  progressNoteIntervalSeconds: 30,
  forwardProgressNotes: true,
};
