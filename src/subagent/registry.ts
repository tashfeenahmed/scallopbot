/**
 * SubAgentRegistry — Tracks all sub-agent runs in memory with parent index.
 *
 * Provides O(1) concurrency checks, cancellation, and cleanup.
 * SQLite persistence is handled externally via the DB layer.
 */

import { nanoid } from 'nanoid';
import type { Logger } from 'pino';
import type {
  SubAgentConfig,
  SubAgentRun,
  SubAgentStatus,
  SubAgentResult,
  SpawnAgentInput,
} from './types.js';
import { DEFAULT_SUBAGENT_CONFIG } from './types.js';

export interface SubAgentRegistryOptions {
  config?: Partial<SubAgentConfig>;
  logger: Logger;
}

export class SubAgentRegistry {
  private runs: Map<string, SubAgentRun> = new Map();
  private parentIndex: Map<string, Set<string>> = new Map();
  private config: SubAgentConfig;
  private logger: Logger;

  constructor(options: SubAgentRegistryOptions) {
    this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...options.config };
    this.logger = options.logger.child({ module: 'subagent-registry' });
  }

  /**
   * Create a new sub-agent run record
   */
  createRun(parentSessionId: string, input: SpawnAgentInput, childSessionId: string): SubAgentRun {
    const id = nanoid();
    const timeoutSeconds = Math.min(
      input.timeoutSeconds ?? this.config.defaultTimeoutSeconds,
      this.config.maxTimeoutSeconds
    );

    const run: SubAgentRun = {
      id,
      parentSessionId,
      childSessionId,
      task: input.task,
      label: input.label || `sub-${id.slice(0, 6)}`,
      status: 'pending',
      allowedSkills: input.skills || [],
      modelTier: input.modelTier || this.config.defaultModelTier,
      timeoutMs: timeoutSeconds * 1000,
      recentChatContext: input.recentChatContext,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      createdAt: Date.now(),
    };

    this.runs.set(id, run);

    // Update parent index
    if (!this.parentIndex.has(parentSessionId)) {
      this.parentIndex.set(parentSessionId, new Set());
    }
    this.parentIndex.get(parentSessionId)!.add(id);

    this.logger.debug({ runId: id, label: run.label, parent: parentSessionId }, 'Sub-agent run created');
    return run;
  }

  /**
   * Get a run by ID
   */
  getRun(runId: string): SubAgentRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Update run status and optionally set result or error
   */
  updateStatus(
    runId: string,
    status: SubAgentStatus,
    result?: SubAgentResult,
    error?: string
  ): void {
    const run = this.runs.get(runId);
    if (!run) {
      this.logger.warn({ runId }, 'Attempted to update non-existent run');
      return;
    }

    run.status = status;

    if (status === 'running' && !run.startedAt) {
      run.startedAt = Date.now();
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out') {
      run.completedAt = Date.now();
    }

    if (result) {
      run.result = result;
    }

    if (error) {
      run.error = error;
    }

    this.logger.debug({ runId, status, label: run.label }, 'Sub-agent run status updated');
  }

  /**
   * Update token usage for a run
   */
  updateTokenUsage(runId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const run = this.runs.get(runId);
    if (run) {
      run.tokenUsage = usage;
    }
  }

  /**
   * Check whether a new sub-agent can be spawned for this parent session.
   * Returns { allowed, reason } — reason explains the rejection.
   */
  canSpawn(parentSessionId: string, sessionMetadata?: Record<string, unknown>): { allowed: boolean; reason?: string } {
    // Recursion guard: reject if parent is itself a sub-agent
    if (sessionMetadata?.isSubAgent) {
      return { allowed: false, reason: 'Sub-agents cannot spawn further sub-agents' };
    }

    // Per-session concurrency
    const activeForParent = this.getActiveRunsForParent(parentSessionId);
    if (activeForParent.length >= this.config.maxConcurrentPerSession) {
      return {
        allowed: false,
        reason: `Maximum concurrent sub-agents per session reached (${this.config.maxConcurrentPerSession})`,
      };
    }

    // Global concurrency
    const activeGlobal = this.getActiveRunsGlobal();
    if (activeGlobal.length >= this.config.maxConcurrentGlobal) {
      return {
        allowed: false,
        reason: `Maximum concurrent sub-agents globally reached (${this.config.maxConcurrentGlobal})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Get active (pending or running) runs for a specific parent session
   */
  getActiveRunsForParent(parentSessionId: string): SubAgentRun[] {
    const runIds = this.parentIndex.get(parentSessionId);
    if (!runIds) return [];

    const active: SubAgentRun[] = [];
    for (const id of runIds) {
      const run = this.runs.get(id);
      if (run && (run.status === 'pending' || run.status === 'running')) {
        active.push(run);
      }
    }
    return active;
  }

  /**
   * Get all active (pending or running) runs globally
   */
  getActiveRunsGlobal(): SubAgentRun[] {
    const active: SubAgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.status === 'pending' || run.status === 'running') {
        active.push(run);
      }
    }
    return active;
  }

  /**
   * Get all runs (any status) for a parent session
   */
  getRunsForParent(parentSessionId: string): SubAgentRun[] {
    const runIds = this.parentIndex.get(parentSessionId);
    if (!runIds) return [];

    const runs: SubAgentRun[] = [];
    for (const id of runIds) {
      const run = this.runs.get(id);
      if (run) runs.push(run);
    }
    return runs;
  }

  /**
   * Cancel all active runs for a parent session. Returns count cancelled.
   */
  cancelRunsForParent(parentSessionId: string): number {
    const active = this.getActiveRunsForParent(parentSessionId);
    let count = 0;
    for (const run of active) {
      this.updateStatus(run.id, 'cancelled');
      count++;
    }
    if (count > 0) {
      this.logger.info({ parentSessionId, cancelled: count }, 'Cancelled sub-agent runs for parent');
    }
    return count;
  }

  /**
   * Remove completed/failed/cancelled runs older than maxAgeMs. Returns count cleaned.
   */
  cleanupCompleted(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const [id, run] of this.runs) {
      if (
        (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'timed_out') &&
        (run.completedAt ?? run.createdAt) < cutoff
      ) {
        this.runs.delete(id);
        const parentSet = this.parentIndex.get(run.parentSessionId);
        if (parentSet) {
          parentSet.delete(id);
          if (parentSet.size === 0) {
            this.parentIndex.delete(run.parentSessionId);
          }
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug({ cleaned, remaining: this.runs.size }, 'Cleaned up old sub-agent runs');
    }
    return cleaned;
  }

  /**
   * Bulk-load runs (e.g., from SQLite on startup). Marks active runs as failed (orphaned).
   */
  loadFromPersistence(runs: SubAgentRun[]): number {
    let orphaned = 0;
    for (const run of runs) {
      // Mark orphaned active runs as failed (process restarted)
      if (run.status === 'pending' || run.status === 'running') {
        run.status = 'failed';
        run.error = 'Process restarted — orphaned sub-agent';
        run.completedAt = Date.now();
        orphaned++;
      }

      this.runs.set(run.id, run);
      if (!this.parentIndex.has(run.parentSessionId)) {
        this.parentIndex.set(run.parentSessionId, new Set());
      }
      this.parentIndex.get(run.parentSessionId)!.add(run.id);
    }

    if (orphaned > 0) {
      this.logger.warn({ orphaned, total: runs.length }, 'Recovered sub-agent runs from persistence');
    }
    return orphaned;
  }

  getConfig(): SubAgentConfig {
    return this.config;
  }
}
