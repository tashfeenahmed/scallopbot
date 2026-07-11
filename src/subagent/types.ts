/**
 * Sub-Agent System Type Definitions
 *
 * Types for spawning focused, ephemeral sub-agents that handle
 * independent tasks with their own sessions and filtered tools.
 */

import type { ToolEvidenceReceipt } from '../memory/db.js';
import type { EvidenceExecutionContext } from '../security/evidence-grounding.js';

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

/**
 * Input for spawning a sub-agent (maps to spawn_agent tool parameters)
 */
export interface SpawnAgentInput {
  task: string;
  label?: string;
  skills?: string[];
  modelTier?: 'fast' | 'standard' | 'capable';
  timeoutSeconds?: number;
  waitForResult?: boolean;
  /** Recent chat transcript for sub-agent context (injected by scheduler) */
  recentChatContext?: string;
  /** Opaque scheduler-owned evidence binding; never authored by the model. */
  evidenceExecutionContext?: EvidenceExecutionContext;
}

/**
 * Tracks a single sub-agent execution lifecycle
 */
export interface SubAgentRun {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  task: string;
  label: string;
  status: SubAgentStatus;
  allowedSkills: string[];
  modelTier: 'fast' | 'standard' | 'capable';
  timeoutMs: number;
  result?: SubAgentResult;
  error?: string;
  /** Recent chat transcript for sub-agent context (injected by scheduler) */
  recentChatContext?: string;
  evidenceExecutionContext?: EvidenceExecutionContext;
  tokenUsage: { inputTokens: number; outputTokens: number };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/**
 * Result returned by a completed sub-agent
 */
export interface SubAgentResult {
  response: string;
  iterationsUsed: number;
  taskComplete: boolean;
  /** Durable, non-prose source used to cross the task completion boundary. */
  completionSource?: 'explicit_done' | 'verified_tool_evidence';
  /** Actual tracked LLM spend for this isolated child session. */
  costUsd: number;
  /** Runtime-issued, content-redacted receipts for tools that actually ran. */
  evidenceReceipts?: ToolEvidenceReceipt[];
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
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultModelTier: 'fast' | 'standard' | 'capable';
  maxIterations: number;
  /** Hard token budget — sub-agent aborts if cumulative input tokens exceed this */
  maxInputTokens: number;
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
  defaultTimeoutSeconds: 180,
  maxTimeoutSeconds: 300,
  defaultModelTier: 'fast',
  maxIterations: 10,
  maxInputTokens: 80_000,
  cleanupAfterSeconds: 3600,
  diagnosticRetentionSeconds: 30 * 24 * 60 * 60,
  allowMemoryWrites: false,
};
