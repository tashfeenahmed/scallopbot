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
import type { SubAgentRunRow } from '../memory/db.js';
import { redactSensitiveText } from '../security/redaction.js';

function safeDiagnosticText(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  const redacted = redactSensitiveText(value);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…[truncated]` : redacted;
}

export interface SubAgentPersistence {
  insertSubAgentRun(run: SubAgentRunRow): void;
  updateSubAgentRun(id: string, updates: Partial<SubAgentRunRow>): void;
}

export interface SubAgentRegistryOptions {
  config?: Partial<SubAgentConfig>;
  logger: Logger;
  /** Optional durable store. ScallopDatabase implements this interface. */
  persistence?: SubAgentPersistence;
}

export class SubAgentRegistry {
  private runs: Map<string, SubAgentRun> = new Map();
  private parentIndex: Map<string, Set<string>> = new Map();
  private config: SubAgentConfig;
  private logger: Logger;
  private persistence?: SubAgentPersistence;
  private spawnReservations = new Map<string, { parentSessionId: string; count: number }>();

  constructor(options: SubAgentRegistryOptions) {
    this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...options.config };
    this.logger = options.logger.child({ module: 'subagent-registry' });
    this.persistence = options.persistence;
  }

  /**
   * Create a new sub-agent run record
   */
  createRun(parentSessionId: string, input: SpawnAgentInput, childSessionId: string): SubAgentRun {
    const id = nanoid();
    const timeoutSeconds = Math.max(0, Math.min(
      input.timeoutSeconds ?? this.config.defaultTimeoutSeconds,
      this.config.maxTimeoutSeconds
    ));
    const idleTimeoutSeconds = Math.max(1, Math.min(
      input.idleTimeoutSeconds ?? this.config.defaultIdleTimeoutSeconds,
      this.config.maxIdleTimeoutSeconds,
    ));
    const parentRun = input.parentRunId ? this.runs.get(input.parentRunId) : undefined;
    const now = Date.now();

    const run: SubAgentRun = {
      id,
      parentSessionId,
      childSessionId,
      task: input.task,
      taskName: input.taskName,
      context: input.context,
      acceptanceCriteria: input.acceptanceCriteria,
      label: input.label || `sub-${id.slice(0, 6)}`,
      status: 'pending',
      allowedSkills: input.skills || [],
      modelTier: input.modelTier || this.config.defaultModelTier,
      timeoutMs: timeoutSeconds * 1000,
      idleTimeoutMs: idleTimeoutSeconds * 1000,
      hardTimeoutMs: timeoutSeconds * 1000,
      contextMode: ['isolated', 'brief', 'fork'].includes(String(input.contextMode))
        ? input.contextMode! : this.config.defaultContextMode,
      role: input.role === 'orchestrator' ? 'orchestrator' : 'leaf',
      workspaceMode: input.workspaceMode === 'worktree' ? 'worktree' : 'shared',
      workspacePath: input.workspaceOverride,
      parentRunId: input.parentRunId,
      batchId: input.batchId,
      batchIndex: input.batchIndex,
      spawnDepth: parentRun ? parentRun.spawnDepth + 1 : 0,
      recentChatContext: input.recentChatContext,
      evidenceExecutionContext: input.evidenceExecutionContext,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      lastProgressAt: now,
    };

    this.runs.set(id, run);

    // Update parent index
    if (!this.parentIndex.has(parentSessionId)) {
      this.parentIndex.set(parentSessionId, new Set());
    }
    this.parentIndex.get(parentSessionId)!.add(id);

    try {
      this.persistence?.insertSubAgentRun(this.toPersistenceRow(run));
    } catch (error) {
      this.runs.delete(id);
      const parentSet = this.parentIndex.get(parentSessionId);
      parentSet?.delete(id);
      if (parentSet?.size === 0) this.parentIndex.delete(parentSessionId);
      throw error;
    }

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
      run.lastProgressAt = run.startedAt;
    }

    if (['completed', 'failed', 'blocked', 'cancelled', 'timed_out', 'lost'].includes(status)) {
      run.completedAt = Date.now();
    }

    if (result) {
      run.result = result;
    }

    if (error) {
      run.error = error;
    }

    this.persistence?.updateSubAgentRun(runId, {
      status: run.status,
      resultResponse: safeDiagnosticText(run.result?.response, 2_000),
      resultIterations: run.result?.iterationsUsed,
      resultTaskComplete: run.result?.taskComplete,
      error: safeDiagnosticText(run.error, 500),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      lastProgressAt: run.lastProgressAt,
      resultJson: run.result ? safeDiagnosticText(JSON.stringify(run.result), 20_000) : undefined,
    });

    this.logger.debug({ runId, status, label: run.label }, 'Sub-agent run status updated');
  }

  /**
   * Update token usage for a run
   */
  updateTokenUsage(runId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const run = this.runs.get(runId);
    if (run) {
      run.tokenUsage = usage;
      this.persistence?.updateSubAgentRun(runId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    }
  }

  markProgress(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.lastProgressAt = Date.now();
    this.persistence?.updateSubAgentRun(runId, { lastProgressAt: run.lastProgressAt });
  }

  setWorkspacePath(runId: string, workspacePath: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.workspacePath = workspacePath;
    this.persistence?.updateSubAgentRun(runId, { workspacePath });
  }

  /**
   * Check whether a new sub-agent can be spawned for this parent session.
   * Returns { allowed, reason } — reason explains the rejection.
   */
  canSpawn(parentSessionId: string, sessionMetadata?: Record<string, unknown>, requestedCount = 1): { allowed: boolean; reason?: string } {
    if (sessionMetadata?.isSubAgent) {
      const depth = Number(sessionMetadata.subAgentSpawnDepth ?? 0);
      const role = sessionMetadata.subAgentRole;
      if (role !== 'orchestrator') {
        return { allowed: false, reason: 'Only orchestrator sub-agents may spawn children' };
      }
      if (depth >= this.config.maxSpawnDepth) {
        return { allowed: false, reason: `Maximum sub-agent spawn depth reached (${this.config.maxSpawnDepth})` };
      }
    }

    // Per-session concurrency
    const activeForParent = this.getActiveRunsForParent(parentSessionId);
    const reservedForParent = [...this.spawnReservations.values()]
      .filter(reservation => reservation.parentSessionId === parentSessionId)
      .reduce((sum, reservation) => sum + reservation.count, 0);
    if (activeForParent.length + reservedForParent + requestedCount > this.config.maxConcurrentPerSession) {
      return {
        allowed: false,
        reason: `Maximum concurrent sub-agents per session reached (${this.config.maxConcurrentPerSession})`,
      };
    }

    // Global concurrency
    const activeGlobal = this.getActiveRunsGlobal();
    const reservedGlobal = [...this.spawnReservations.values()].reduce((sum, reservation) => sum + reservation.count, 0);
    if (activeGlobal.length + reservedGlobal + requestedCount > this.config.maxConcurrentGlobal) {
      return {
        allowed: false,
        reason: `Maximum concurrent sub-agents globally reached (${this.config.maxConcurrentGlobal})`,
      };
    }

    return { allowed: true };
  }

  reserveSpawn(parentSessionId: string, sessionMetadata: Record<string, unknown> | undefined, count = 1): { token?: string; reason?: string } {
    if (!Number.isInteger(count) || count < 1) return { reason: 'Spawn count must be a positive integer' };
    const check = this.canSpawn(parentSessionId, sessionMetadata, count);
    if (!check.allowed) return { reason: check.reason };
    const token = nanoid();
    this.spawnReservations.set(token, { parentSessionId, count });
    return { token };
  }

  releaseSpawnReservation(token: string): void {
    this.spawnReservations.delete(token);
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

  getAllRuns(): SubAgentRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
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
        !['pending', 'running'].includes(run.status) &&
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
   * Bulk-load runs (e.g., from SQLite on startup). Interrupted work is marked
   * lost, never falsely failed/succeeded; the durable ledger remains inspectable.
   */
  loadFromPersistence(runs: SubAgentRun[]): number {
    let orphaned = 0;
    for (const run of runs) {
      // Provider streams cannot be resumed safely after process death.
      if (run.status === 'pending' || run.status === 'running') {
        run.status = 'lost';
        run.error = 'Process restarted while this sub-agent was active; no success was inferred';
        run.completedAt = Date.now();
        this.persistence?.updateSubAgentRun(run.id, {
          status: run.status,
          error: run.error,
          completedAt: run.completedAt,
        });
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

  private toPersistenceRow(run: SubAgentRun): SubAgentRunRow {
    return {
      id: run.id,
      parentSessionId: run.parentSessionId,
      childSessionId: run.childSessionId,
      task: safeDiagnosticText(run.task, 1_000) ?? '[empty task]',
      label: safeDiagnosticText(run.label, 120) ?? 'sub-agent',
      status: run.status,
      allowedSkills: run.allowedSkills.join(','),
      modelTier: run.modelTier,
      timeoutMs: run.timeoutMs,
      taskName: run.taskName ?? null,
      parentRunId: run.parentRunId ?? null,
      batchId: run.batchId ?? null,
      batchIndex: run.batchIndex ?? null,
      role: run.role,
      spawnDepth: run.spawnDepth,
      contextMode: run.contextMode,
      workspaceMode: run.workspaceMode,
      workspacePath: run.workspacePath ?? null,
      idleTimeoutMs: run.idleTimeoutMs,
      hardTimeoutMs: run.hardTimeoutMs,
      lastProgressAt: run.lastProgressAt ?? null,
      resultJson: run.result ? safeDiagnosticText(JSON.stringify(run.result), 20_000) : null,
      updatedAt: run.completedAt ?? run.startedAt ?? run.createdAt,
      resultResponse: safeDiagnosticText(run.result?.response, 2_000),
      resultIterations: run.result?.iterationsUsed ?? null,
      resultTaskComplete: run.result?.taskComplete ?? null,
      error: safeDiagnosticText(run.error, 500),
      inputTokens: run.tokenUsage.inputTokens,
      outputTokens: run.tokenUsage.outputTokens,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    };
  }
}
