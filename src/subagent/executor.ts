/**
 * SubAgentExecutor — Core engine for creating and running sub-agent instances.
 *
 * Creates child Agent instances with:
 * - Filtered skill registries (no recursion, no user comms)
 * - Read-only memory proxy
 * - Minimal system prompts (no SOUL.md, no goals, no affect)
 * - Timeout via AbortController
 * - Progress forwarding to parent
 */

import type { Logger } from 'pino';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../providers/types.js';
import type { SessionManager } from '../agent/session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { Router } from '../routing/router.js';
import type { CostTracker } from '../routing/cost.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import { ContextManager } from '../routing/context.js';
import type { ProgressCallback } from '../agent/agent.js';
import type { Skill } from '../skills/types.js';
import { Agent } from '../agent/agent.js';
import { SubAgentRegistry } from './registry.js';
import { AnnounceQueue } from './announce-queue.js';
import { enqueueInLane } from '../agent/command-queue.js';
import { resolveStateUserId } from '../utils/state-user-id.js';
import type {
  SubAgentConfig,
  SubAgentResult,
  SpawnAgentInput,
  SubAgentRun,
} from './types.js';
import { DEFAULT_SUBAGENT_CONFIG } from './types.js';
import type { ToolEvidenceReceipt } from '../memory/db.js';
import { InterruptQueue } from '../agent/interrupt-queue.js';
import { buildStructuredSubAgentResult, structuredResultPrompt } from './result.js';
import { createSubAgentWorktree, finalizeSubAgentWorktree, type SubAgentWorktree } from './worktree.js';
import { nanoid } from 'nanoid';
import type { EvolutionRecorder } from '../evolution/signals.js';

/**
 * Skills that sub-agents are never allowed to use
 */
const NEVER_ALLOWED_SKILLS = new Set([
  'send_message',     // No direct user communication
  'send_file',        // No direct user communication
  'voice_reply',      // No direct user communication
  'manage_skills',    // No installing/uninstalling skills
]);

/**
 * Default skills always available to sub-agents (if they exist in the registry)
 */
const DEFAULT_SUBAGENT_SKILLS = [
  'read_file',
  'memory_search',
];

/** Honest failure prose must never cross the task-completion boundary. */
const FINAL_FAILURE_SIGNAL = /\b(?:could not|couldn't|cannot|can't|was unable|unable to|failed to|failure|unavailable|not available|did not complete|not completed|access denied|permission denied|timed out|blocked by|error:)\b/i;

/**
 * Keyword-based skill auto-selection rules
 */
const SKILL_KEYWORD_MAP: Array<{ patterns: RegExp; skills: string[] }> = [
  { patterns: /file|read|code|write|edit|script/i, skills: ['read_file'] },
  { patterns: /memory|remember|recall|fact/i, skills: ['memory_search'] },
];

export interface SubAgentSkillPolicyContext {
  parentSessionId: string;
  childSessionId: string;
  runId: string;
}

export interface SubAgentExecutorOptions {
  registry: SubAgentRegistry;
  announceQueue: AnnounceQueue;
  sessionManager: SessionManager;
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  router: Router;
  costTracker?: CostTracker;
  scallopStore?: ScallopMemoryStore;
  contextManager?: ContextManager;
  workspace: string;
  logger: Logger;
  config?: Partial<SubAgentConfig>;
  /** Parent-session policy check. Resolver errors deny rather than bypass. */
  skillPolicyResolver?: (
    skillName: string,
    context: SubAgentSkillPolicyContext,
  ) => boolean | Promise<boolean>;
  /** Explicit aliases for this deployment's single canonical state owner. */
  canonicalSingleUserIds?: readonly string[];
  /** Durable completion outbox. ScallopDatabase implements this interface. */
  deliveryOutbox?: {
    enqueueSubAgentDelivery(input: {
      runId: string;
      parentSessionId: string;
      userId?: string | null;
      payloadJson: string;
    }): boolean;
  };
  /** Feed successful reusable child workflows into the existing gated skill-evolution loop. */
  evolutionRecorder?: EvolutionRecorder;
}

export class SubAgentExecutor {
  private registry: SubAgentRegistry;
  private announceQueue: AnnounceQueue;
  private sessionManager: SessionManager;
  private skillRegistry: SkillRegistry;
  private skillExecutor: SkillExecutor;
  private router: Router;
  private costTracker: CostTracker | undefined;
  private scallopStore: ScallopMemoryStore | undefined;
  private contextManager: ContextManager | undefined;
  private workspace: string;
  private logger: Logger;
  private config: SubAgentConfig;
  private skillPolicyResolver: SubAgentExecutorOptions['skillPolicyResolver'];
  private canonicalSingleUserIds: readonly string[];
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private cancelRequested = new Set<string>();
  private interruptQueues: Map<string, InterruptQueue> = new Map();
  private deliveryOutbox?: SubAgentExecutorOptions['deliveryOutbox'];
  private evolutionRecorder?: EvolutionRecorder;
  private budgetFailures = new Map<string, string>();

  constructor(options: SubAgentExecutorOptions) {
    this.registry = options.registry;
    this.announceQueue = options.announceQueue;
    this.sessionManager = options.sessionManager;
    this.skillRegistry = options.skillRegistry;
    this.skillExecutor = options.skillExecutor;
    this.router = options.router;
    this.costTracker = options.costTracker;
    this.scallopStore = options.scallopStore;
    this.contextManager = options.contextManager;
    this.workspace = options.workspace;
    this.logger = options.logger.child({ module: 'subagent-executor' });
    this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...options.config };
    this.skillPolicyResolver = options.skillPolicyResolver;
    this.canonicalSingleUserIds = [...(options.canonicalSingleUserIds ?? [])];
    this.deliveryOutbox = options.deliveryOutbox;
    this.evolutionRecorder = options.evolutionRecorder;
  }

  /**
   * Expose config for external consumers (e.g. scheduler)
   */
  getConfig(): SubAgentConfig {
    return this.config;
  }

  /**
   * Deterministic capability preflight for unattended work. Documentation-only
   * skills require bash to be explicitly granted too; otherwise they cannot be
   * executed by the filtered child registry.
   */
  preflightSkills(requestedSkills: readonly string[]): {
    available: string[];
    missing: string[];
    documentationOnly: string[];
  } {
    const requested = [...new Set(requestedSkills.filter(Boolean))]
      .filter(name => !NEVER_ALLOWED_SKILLS.has(name));
    const executable = new Set(this.skillRegistry.getExecutableSkills().map(skill => skill.name));
    const documentation = new Set(this.skillRegistry.getDocumentationSkills().map(skill => skill.name));
    const available: string[] = [];
    const missing: string[] = [];
    const documentationOnly: string[] = [];

    for (const name of requested) {
      if (executable.has(name)) {
        available.push(name);
      } else if (documentation.has(name)) {
        documentationOnly.push(name);
        if (requested.includes('bash') && executable.has('bash')) available.push(name);
        else missing.push(`${name} (requires bash)`);
      } else {
        missing.push(name);
      }
    }
    return { available, missing, documentationOnly };
  }

  /**
   * Async spawn: starts sub-agent, enqueues result when done.
   * Returns immediately with { runId, childSessionId }.
   */
  async spawn(
    parentSessionId: string,
    input: SpawnAgentInput,
    parentOnProgress?: ProgressCallback,
  ): Promise<{ runId: string; childSessionId: string }> {
    const parent = await this.sessionManager.getSession(parentSessionId);
    const reservation = this.registry.reserveSpawn(parentSessionId, parent?.metadata, 1);
    if (!reservation.token) throw new Error(reservation.reason || 'Sub-agent capacity unavailable');
    let run: SubAgentRun;
    try {
      run = (await this.prepareRun(parentSessionId, input)).run;
    } finally {
      this.registry.releaseSpawnReservation(reservation.token);
    }

    // Fire and forget — result will be enqueued via lane serialization
    enqueueInLane(`subagent:${run.id}`, () => this.executeSubAgent(run, parentOnProgress, true)).catch((err) => {
      this.logger.error({ runId: run.id, error: (err as Error).message }, 'Sub-agent execution failed unexpectedly');
    });

    return { runId: run.id, childSessionId: run.childSessionId };
  }

  /**
   * Sync spawn: blocks until sub-agent finishes. Returns result directly.
   */
  async spawnAndWait(
    parentSessionId: string,
    input: SpawnAgentInput,
    parentOnProgress?: ProgressCallback,
  ): Promise<SubAgentResult> {
    const parent = await this.sessionManager.getSession(parentSessionId);
    const reservation = this.registry.reserveSpawn(parentSessionId, parent?.metadata, 1);
    if (!reservation.token) throw new Error(reservation.reason || 'Sub-agent capacity unavailable');
    let run: SubAgentRun;
    try {
      run = (await this.prepareRun(parentSessionId, input)).run;
    } finally {
      this.registry.releaseSpawnReservation(reservation.token);
    }
    return this.executeSubAgent(run, parentOnProgress, false);
  }

  /** Atomically preflight a fan-out before starting any child. */
  async spawnBatch(
    parentSessionId: string,
    inputs: SpawnAgentInput[],
    parentOnProgress?: ProgressCallback,
  ): Promise<Array<{ runId: string; childSessionId: string }>> {
    if (inputs.length === 0) return [];
    const parent = await this.sessionManager.getSession(parentSessionId);
    const reservation = this.registry.reserveSpawn(parentSessionId, parent?.metadata, inputs.length);
    if (!reservation.token) throw new Error(reservation.reason);
    const batchId = nanoid();
    const prepared: SubAgentRun[] = [];
    try {
      for (let index = 0; index < inputs.length; index++) {
        const input = { ...inputs[index], batchId, batchIndex: index };
        prepared.push((await this.prepareRun(parentSessionId, input)).run);
      }
    } catch (error) {
      for (const run of prepared) {
        this.registry.updateStatus(run.id, 'cancelled', undefined, 'Atomic batch preparation rolled back');
        await this.sessionManager.archiveSession(run.childSessionId, 'batch_preflight_rollback', 'subagent_executor');
      }
      throw error;
    } finally {
      this.registry.releaseSpawnReservation(reservation.token);
    }
    for (const run of prepared) {
      enqueueInLane(`subagent:${run.id}`, () => this.executeSubAgent(run, parentOnProgress, true)).catch(error => {
        this.logger.error({ runId: run.id, error: (error as Error).message }, 'Batch child failed unexpectedly');
      });
    }
    return prepared.map(run => ({ runId: run.id, childSessionId: run.childSessionId }));
  }

  /** Isolated implement -> independent review/test -> conflict-checked patch. */
  async runCodingWorkflow(
    parentSessionId: string,
    input: SpawnAgentInput,
    parentOnProgress?: ProgressCallback,
  ): Promise<SubAgentResult> {
    const workflowId = `workflow-${nanoid()}`;
    const worktree = await createSubAgentWorktree(this.workspace, workflowId);
    let finalized = false;
    try {
      const implementer = await this.spawnAndWait(parentSessionId, {
        ...input,
        label: input.label ? `${input.label}-implement` : 'implementer',
        role: 'leaf',
        workspaceMode: 'worktree',
        workspaceOverride: worktree.path,
        acceptanceCriteria: input.acceptanceCriteria,
      }, parentOnProgress);
      const reviewer = await this.spawnAndWait(parentSessionId, {
        task: [
          'Independently review and test the implementation in this workspace.',
          'Inspect the full Git diff, run the relevant tests, and report concrete defects or missing acceptance criteria.',
          'Do not modify files. Do not approve based only on the implementer summary.',
          `Original task: ${input.task}`,
          `Implementer report: ${implementer.summary}`,
        ].join('\n'),
        label: input.label ? `${input.label}-review` : 'reviewer',
        skills: input.skills,
        modelTier: input.modelTier,
        contextMode: 'isolated',
        workspaceMode: 'worktree',
        workspaceOverride: worktree.path,
        acceptanceCriteria: [
          ...(input.acceptanceCriteria ?? []),
          'Relevant tests pass',
          'No unresolved defects remain in the reviewed diff',
        ],
      }, parentOnProgress);
      const patch = await finalizeSubAgentWorktree(worktree, workflowId);
      finalized = true;
      const succeeded = implementer.status === 'succeeded'
        && reviewer.status === 'succeeded'
        && patch.conflicts.length === 0;
      const structured = buildStructuredSubAgentResult({
        response: succeeded
          ? `Implementation and independent review passed. ${reviewer.summary}`
          : `Coding workflow needs attention. ${reviewer.summary}`,
        runtimeStatus: succeeded ? 'succeeded' : 'blocked',
        acceptanceCriteria: input.acceptanceCriteria,
        evidenceReceipts: [...implementer.evidenceReceipts, ...reviewer.evidenceReceipts],
        changedFiles: patch.changedFiles,
        additionalArtifacts: patch.artifacts,
        additionalBlockers: [
          ...patch.conflicts,
          ...(implementer.status === 'succeeded' ? [] : implementer.blockers),
          ...(reviewer.status === 'succeeded' ? [] : reviewer.blockers),
        ],
        verifiedAcceptancePassed: succeeded,
      });
      return {
        ...structured,
        response: structured.summary,
        iterationsUsed: implementer.iterationsUsed + reviewer.iterationsUsed,
        taskComplete: structured.acceptancePassed,
        completionSource: structured.acceptancePassed ? 'verified_tool_evidence' : undefined,
        costUsd: implementer.costUsd + reviewer.costUsd,
      };
    } finally {
      if (!finalized) {
        try { await finalizeSubAgentWorktree(worktree, workflowId); } catch { /* best effort */ }
      }
    }
  }

  steer(runId: string, message: string): boolean {
    const run = this.registry.getRun(runId);
    const queue = this.interruptQueues.get(runId);
    if (!run || run.status !== 'running' || !queue || !message.trim()) return false;
    queue.enqueue({ sessionId: run.childSessionId, text: `[Parent steering update] ${message.trim()}`, timestamp: Date.now() });
    this.registry.markProgress(runId);
    return true;
  }

  followUp(parentSessionId: string, runId: string, message: string, waitForResult = false) {
    const prior = this.registry.getRun(runId);
    if (!prior || prior.parentSessionId !== parentSessionId) throw new Error('Unknown sub-agent run');
    return waitForResult
      ? this.spawnAndWait(parentSessionId, { task: message, context: prior.result?.summary, label: `${prior.label}-followup`, skills: prior.allowedSkills })
      : this.spawn(parentSessionId, { task: message, context: prior.result?.summary, label: `${prior.label}-followup`, skills: prior.allowedSkills });
  }

  async getRunLog(runId: string, maxMessages = 20): Promise<Array<{ role: string; content: string }>> {
    const run = this.registry.getRun(runId);
    if (!run) return [];
    const session = await this.sessionManager.getSession(run.childSessionId);
    return (session?.messages ?? []).slice(-Math.max(1, Math.min(100, maxMessages))).map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '[structured content]',
    }));
  }

  private async prepareRun(parentSessionId: string, input: SpawnAgentInput): Promise<{ run: SubAgentRun }> {
    const parent = await this.sessionManager.getSession(parentSessionId);
    const parentRunId = typeof parent?.metadata?.subAgentRunId === 'string'
      ? parent.metadata.subAgentRunId
      : input.parentRunId;
    const normalized = { ...input, parentRunId };
    const session = await this.sessionManager.createSession({
      isSubAgent: true,
      parentSessionId,
      label: input.label || 'sub-agent',
      subAgentRole: input.role ?? 'leaf',
      subAgentSpawnDepth: Number(parent?.metadata?.subAgentSpawnDepth ?? -1) + 1,
      ...(parentRunId ? { parentRunId } : {}),
      ...(typeof parent?.metadata?.userId === 'string' ? { userId: parent.metadata.userId } : {}),
      ...(typeof parent?.metadata?.channelId === 'string' ? { channelId: parent.metadata.channelId } : {}),
    });
    let run: SubAgentRun;
    try {
      run = this.registry.createRun(parentSessionId, normalized, session.id);
    } catch (error) {
      await this.sessionManager.archiveSession(session.id, 'subagent_prepare_failed', 'subagent_executor');
      throw error;
    }
    session.metadata = { ...session.metadata, subAgentRunId: run.id };
    if (run.contextMode === 'fork' && parent) {
      const messages = parent.messages
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-20);
      for (const message of messages) {
        await this.sessionManager.addMessage(session.id, message);
      }
    }
    return { run };
  }

  /**
   * Cancel a specific run
   */
  cancel(runId: string): boolean {
    const run = this.registry.getRun(runId);
    if (!run || !['pending', 'running'].includes(run.status)) return false;
    this.cancelRequested.add(runId);
    const controller = this.activeAbortControllers.get(runId);
    controller?.abort();
    this.registry.updateStatus(runId, 'cancelled');
    this.logger.info({ runId }, 'Sub-agent cancellation requested');
    return true;
  }

  /**
   * Cancel all active runs for a parent session
   */
  cancelForParent(parentSessionId: string): number {
    const active = this.registry.getActiveRunsForParent(parentSessionId);
    let count = 0;
    for (const run of active) {
      if (this.cancel(run.id)) count++;
    }
    // Also cancel any the registry knows about but we don't have controllers for
    count += this.registry.cancelRunsForParent(parentSessionId);
    return count;
  }

  /**
   * Core execution flow for a sub-agent
   */
  private async executeSubAgent(
    run: SubAgentRun,
    parentOnProgress?: ProgressCallback,
    announceResult: boolean = true,
  ): Promise<SubAgentResult> {
    if (this.cancelRequested.has(run.id) || run.status === 'cancelled') {
      const failure = this.failureResult('Sub-agent cancelled by parent', 'cancelled');
      if (announceResult) {
        this.announceFailure(run, failure.response);
        await this.enqueueDurableDelivery(run, failure);
      }
      this.cancelRequested.delete(run.id);
      return failure;
    }
    this.registry.updateStatus(run.id, 'running');
    let worktree: SubAgentWorktree | undefined;
    let executionWorkspace = run.workspacePath || this.workspace;
    if (run.workspaceMode === 'worktree' && !run.workspacePath) {
      try {
        worktree = await createSubAgentWorktree(this.workspace, run.id);
        executionWorkspace = worktree.path;
        this.registry.setWorkspacePath(run.id, worktree.path);
      } catch (error) {
        const message = `Could not create isolated worktree: ${(error as Error).message}`;
        this.registry.updateStatus(run.id, 'blocked', undefined, message);
        if (announceResult) this.announceFailure(run, message);
        const failure = this.failureResult(message, 'blocked');
        if (announceResult) await this.enqueueDurableDelivery(run, failure);
        return failure;
      }
    }

    // 1. Select provider via router
    const provider = await this.router.selectProvider(run.modelTier);
    if (!provider) {
      const error = `No provider available for tier "${run.modelTier}"`;
      this.registry.updateStatus(run.id, 'failed', undefined, error);
      if (announceResult) this.announceFailure(run, error);
      const failure = this.failureResult(error);
      if (announceResult) await this.enqueueDurableDelivery(run, failure);
      if (worktree) {
        try { await finalizeSubAgentWorktree(worktree, run.id); } catch { /* best-effort cleanup */ }
      }
      return failure;
    }

    // 2. Provider accounting is applied by Agent so fallback providers are
    // charged exactly once too.
    let activeProvider: LLMProvider = provider;

    // 3. Wrap provider with token budget enforcement
    activeProvider = this.createTokenBudgetProvider(activeProvider, run.id);

    // 4. Resolve parent policy before exposing either schemas or prompt docs.
    const allowedSkills = await this.resolveAllowedSkills(run.allowedSkills, run.task, run);

    // 5. Build enriched prompt and filtered registry from the same allowlist.
    const childSession = await this.sessionManager.getSession(run.childSessionId);
    const stateUserId = resolveStateUserId(
      typeof childSession?.metadata?.userId === 'string' ? childSession.metadata.userId : undefined,
      this.canonicalSingleUserIds,
    );
    const systemPrompt = await this.buildSubAgentPrompt(
      run.task,
      run.recentChatContext,
      allowedSkills,
      stateUserId,
      run,
      executionWorkspace,
    );
    const filteredRegistry = this.createFilteredSkillRegistry(allowedSkills);

    // 6. Create dedicated ContextManager with tight limits for sub-agents
    const subAgentContextManager = new ContextManager({
      hotWindowSize: 20,
      maxContextTokens: 50_000,
      compressionThreshold: 0.6,
      maxToolOutputBytes: 10_240,
    });

    // 7. Create Agent instance with sub-agent restrictions
    const childInterruptQueue = new InterruptQueue({ maxQueueSize: 20, logger: this.logger });
    this.interruptQueues.set(run.id, childInterruptQueue);
    const agent = new Agent({
      provider: activeProvider,
      router: this.router,
      costTracker: this.costTracker,
      sessionManager: this.sessionManager,
      skillRegistry: filteredRegistry,
      skillExecutor: this.skillExecutor,
      // Read-only memory: pass store for reads but no factExtractor (no writes)
      scallopStore: run.contextMode === 'isolated'
        ? undefined
        : this.config.allowMemoryWrites ? this.scallopStore : this.createReadOnlyMemoryProxy(),
      contextManager: subAgentContextManager,
      // Deliberately omitted:
      // - factExtractor (no fact extraction from sub-agent conversations)
      // - goalService (sub-agents don't manage goals)
      // - configManager (sub-agents don't need user config)
      // - mediaProcessor (sub-agents don't process media)
      workspace: executionWorkspace,
      logger: this.logger,
      maxIterations: this.config.maxIterations,
      interruptQueue: childInterruptQueue,
      subAgentExecutor: run.role === 'orchestrator' ? this : undefined,
      foregroundCallTimeoutMs: Math.min(300_000, Math.max(25_000, run.idleTimeoutMs)),
      turnTimeoutMs: Math.min(900_000, Math.max(55_000, run.idleTimeoutMs)),
      subAgentMode: true,
      systemPrompt,
      canonicalSingleUserIds: this.canonicalSingleUserIds,
      evidenceExecutionContext: run.evidenceExecutionContext,
    });

    // 8. Progress-aware liveness. A hard timeout is optional; productive work
    // is never killed merely because it crossed an arbitrary short wall time.
    const controller = new AbortController();
    let abortReason: 'idle' | 'hard' | undefined;
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      const current = this.registry.getRun(run.id);
      const lastProgressAt = current?.lastProgressAt ?? startedAt;
      if (Date.now() - lastProgressAt > run.idleTimeoutMs) {
        abortReason = 'idle';
        controller.abort();
      } else if (run.hardTimeoutMs > 0 && Date.now() - startedAt > run.hardTimeoutMs) {
        abortReason = 'hard';
        controller.abort();
      }
    }, Math.min(1_000, Math.max(100, Math.floor(run.idleTimeoutMs / 10))));
    this.activeAbortControllers.set(run.id, controller);
    if (this.cancelRequested.has(run.id)) controller.abort();
    const initialCostUsd = this.costTracker?.getSessionSpend(run.childSessionId) ?? 0;

    const shouldStop = () => controller.signal.aborted;

    // 9. Progress forwarding
    const evidenceReceipts: ToolEvidenceReceipt[] = [];
    const subProgress: ProgressCallback = async (update) => {
      this.registry.markProgress(run.id);
      if ((update.type === 'tool_complete' || update.type === 'tool_error') && update.toolName && update.evidence) {
        evidenceReceipts.push({
          toolName: update.toolName,
          success: update.evidence.verified,
          completedAt: Date.now(),
          outputDigest: update.evidence.outputDigest,
          outputBytes: update.evidence.outputBytes,
          claimDigests: update.evidence.claimDigests,
          claimLedgerTruncated: update.evidence.claimLedgerTruncated,
          authority: update.evidence.authority,
          sourceDigest: update.evidence.sourceDigest,
          toolRequestDigest: update.evidence.toolRequestDigest,
          taskRequestDigest: update.evidence.taskRequestDigest,
          accountScopeDigest: update.evidence.accountScopeDigest,
        });
      }
      if (parentOnProgress) {
        await parentOnProgress({
          ...update,
          message: `[${run.label}] ${update.message}`,
        });
      }
    };

    try {
      const result = await agent.processMessage(
        run.childSessionId,
        run.task,
        undefined,
        subProgress,
        shouldStop,
        activeProvider, // lock the budget wrapper while retaining router fallback
        controller.signal // abortSignal — terminates in-flight LLM HTTP call on timeout/cancel
      );
      const budgetFailure = this.budgetFailures.get(run.id);
      if (budgetFailure) throw new Error(budgetFailure);

      let cleanedResponse = result.response.replace(/\[DONE\]\s*$/, '').trim();
      const hasFailureSignal = FINAL_FAILURE_SIGNAL.test(cleanedResponse);
      const finalToolReceipt = evidenceReceipts.at(-1);
      const hasVerifiedToolCompletion = Boolean(
        finalToolReceipt?.success && finalToolReceipt.outputBytes > 0,
      );
      // A natural end only means the model stopped talking. It does not prove
      // the assigned work succeeded. Completion requires the explicit loop
      // contract, or a non-empty runtime tool result, and never failure prose.
      const toolBoundaryVerified = evidenceReceipts.length === 0 || hasVerifiedToolCompletion;
      const completionSource = !hasFailureSignal
        && toolBoundaryVerified
        && result.completionReason === 'explicit_done'
        ? 'explicit_done' as const
        : !hasFailureSignal && result.completionReason === 'natural_end' && hasVerifiedToolCompletion
          ? 'verified_tool_evidence' as const
          : undefined;
      const taskComplete = completionSource !== undefined;
      const costUsd = Math.max(
        0,
        (this.costTracker?.getSessionSpend(run.childSessionId) ?? initialCostUsd) - initialCostUsd,
      );

      let worktreeResult: Awaited<ReturnType<typeof finalizeSubAgentWorktree>> | undefined;
      if (worktree) {
        worktreeResult = await finalizeSubAgentWorktree(worktree, run.id);
        worktree = undefined;
      }
      const structured = buildStructuredSubAgentResult({
        response: cleanedResponse,
        runtimeStatus: taskComplete ? 'succeeded' : 'blocked',
        acceptanceCriteria: run.acceptanceCriteria,
        evidenceReceipts,
        changedFiles: worktreeResult?.changedFiles,
        additionalArtifacts: worktreeResult?.artifacts,
        additionalBlockers: worktreeResult?.conflicts,
      });
      cleanedResponse = structured.summary.slice(0, this.config.maxSummaryChars);
      const subAgentResult: SubAgentResult = {
        ...structured,
        response: cleanedResponse,
        iterationsUsed: result.iterationsUsed,
        taskComplete: taskComplete && structured.acceptancePassed,
        completionSource: structured.acceptancePassed ? completionSource : undefined,
        costUsd,
        evidenceReceipts,
      };

      // Update registry
      const registryStatus = subAgentResult.status === 'succeeded' ? 'completed'
        : subAgentResult.status === 'blocked' ? 'blocked' : 'failed';
      this.registry.updateStatus(run.id, registryStatus, subAgentResult);
      this.registry.updateTokenUsage(run.id, result.tokenUsage);
      if (subAgentResult.status === 'succeeded' && this.evolutionRecorder) {
        this.evolutionRecorder.recordTurn({
          userId: stateUserId,
          sessionId: run.childSessionId,
          userMessage: run.task,
          finalResponse: subAgentResult.summary,
          toolCallCount: evidenceReceipts.length,
          failedSkills: [],
          complexityTier: run.modelTier,
        });
      }

      // Enqueue result for parent (async spawn only — for spawnAndWait, caller gets result directly)
      if (announceResult) {
        this.announceQueue.enqueue({
          runId: run.id,
          parentSessionId: run.parentSessionId,
          label: run.label,
          result: subAgentResult,
          tokenUsage: result.tokenUsage,
          timestamp: Date.now(),
        });
        await this.enqueueDurableDelivery(run, subAgentResult);
      }

      this.logger.info(
        {
          runId: run.id,
          label: run.label,
          iterations: result.iterationsUsed,
          tokens: result.tokenUsage.inputTokens + result.tokenUsage.outputTokens,
          costUsd,
          completionReason: result.completionReason,
          taskComplete,
        },
        'Sub-agent completed'
      );

      return subAgentResult;
    } catch (error) {
      const wasCancelled = this.registry.getRun(run.id)?.status === 'cancelled';
      const isTimeout = controller.signal.aborted && !wasCancelled;
      const status = wasCancelled ? 'cancelled' : isTimeout ? 'timed_out' : 'failed';
      const errorMsg = wasCancelled
        ? 'Sub-agent cancelled by parent'
        : abortReason === 'idle'
        ? `Sub-agent stopped after ${run.idleTimeoutMs / 1000}s without progress`
        : abortReason === 'hard'
          ? `Sub-agent reached the configured ${run.hardTimeoutMs / 1000}s hard limit`
        : (error as Error).message;

      this.registry.updateStatus(run.id, status, undefined, errorMsg);
      if (announceResult) this.announceFailure(run, errorMsg);

      this.logger.warn({ runId: run.id, label: run.label, status, error: errorMsg }, 'Sub-agent failed');

      const failure = this.failureResult(errorMsg, status, evidenceReceipts, Math.max(
          0,
          (this.costTracker?.getSessionSpend(run.childSessionId) ?? initialCostUsd) - initialCostUsd,
        ));
      if (announceResult) await this.enqueueDurableDelivery(run, failure);
      return failure;
    } finally {
      clearInterval(watchdog);
      this.activeAbortControllers.delete(run.id);
      this.cancelRequested.delete(run.id);
      this.budgetFailures.delete(run.id);
      this.interruptQueues.delete(run.id);
      if (worktree) {
        try { await finalizeSubAgentWorktree(worktree, run.id); } catch { /* best-effort cleanup */ }
      }
    }
  }

  /**
   * Build an enriched system prompt for sub-agents with user context and memory.
   */
  private async buildSubAgentPrompt(
    task: string,
    recentChatContext?: string,
    allowedSkills: ReadonlySet<string> = new Set(),
    userId: string = 'default',
    run?: SubAgentRun,
    workspace = this.workspace,
  ): Promise<string> {
    const lines = [
      'You are a focused sub-agent assigned a specific task.',
      '',
    ];

    // Inject agent identity if available
    if (this.scallopStore && run?.contextMode !== 'isolated') {
      const agentProfile = this.scallopStore.getProfileManager().getStaticProfile('agent');
      if (agentProfile && Object.keys(agentProfile).length > 0) {
        const name = agentProfile['name'] || agentProfile['agent_name'];
        const personality = agentProfile['personality'];
        if (name) lines.push(`Your name is ${name}.`);
        if (personality) lines.push(`Personality: ${personality}`);
        lines.push('');
      }
    }

    // Inject user profile context
    if (this.scallopStore && run?.contextMode !== 'isolated') {
      const userProfile = this.scallopStore.getProfileManager().getStaticProfile(userId);
      if (userProfile && Object.keys(userProfile).length > 0) {
        lines.push('## USER CONTEXT');
        for (const [key, value] of Object.entries(userProfile)) {
          lines.push(`- ${key}: ${value}`);
        }
        lines.push('');
      }
    }

    // Inject recent chat context (for proactive/scheduled sub-agents)
    if (recentChatContext && run?.contextMode !== 'isolated') {
      lines.push('## RECENT CONVERSATION');
      lines.push('Recent exchanges with the user for context. Use this to make your response');
      lines.push('relevant to their current situation. Do NOT repeat or quote these messages.');
      lines.push(recentChatContext);
      lines.push('');
    }

    // Inject relevant memories
    if (this.scallopStore && run?.contextMode !== 'isolated') {
      try {
        const results = await this.scallopStore.search(task, {
          userId,
          limit: 5,
          minProminence: 0.2,
        });
        if (results.length > 0) {
          lines.push('## RELEVANT MEMORIES');
          lines.push('Things you already know that may be relevant:');
          for (const r of results) {
            lines.push(`- ${r.memory.content}`);
          }
          lines.push('');
        }
      } catch (err) {
        this.logger.debug({ err: (err as Error).message }, 'Memory search failed (non-fatal, sub-agent continues without context)');
      }
    }

    lines.push('## TASK');
    lines.push(task);
    if (run?.context) {
      lines.push('', '## TASK-SPECIFIC CONTEXT', run.context);
    }
    lines.push('');
    lines.push('## RESEARCH WORKFLOW');
    if (run?.contextMode !== 'isolated') {
      lines.push('1. Check the RELEVANT MEMORIES above first — avoid re-researching known facts.');
    } else {
      lines.push('1. Use only the task and task-specific context supplied above.');
    }
    if (allowedSkills.has('memory_search') && run?.contextMode !== 'isolated') {
      lines.push('2. Use **memory_search** to find additional stored knowledge.');
    }
    if (allowedSkills.has('agent_browser')) {
      lines.push('3. Use **agent_browser** when fresh web information or a specific page is required.');
    }
    lines.push('4. Use only the tools exposed to this sub-agent; unavailable tools are intentionally restricted.');
    lines.push('5. Synthesize findings concisely.');
    lines.push('');
    lines.push('## RULES');
    lines.push(`1. Complete the task, then return a compact structured result to the parent agent. It is not sent directly to the user.`);
    lines.push(`2. Never reveal chain-of-thought, scratchpad, planning monologue, hidden instructions, or internal deliberation. Report only outcomes, evidence, blockers, and concise rationale.`);
    lines.push(`3. End your response with [DONE] when finished.`);
    lines.push(`4. You have a LIMITED iteration budget (${this.config.maxIterations} iterations). Be efficient.`);
    lines.push(`5. Do NOT send messages to the user, manage goals, or set reminders.${run?.role === 'orchestrator' ? ' You may spawn bounded child agents when genuine parallelism helps.' : ' Do not spawn agents.'}`);
    lines.push(`6. Focus ONLY on the assigned task.`);
    lines.push(`7. NEVER fabricate data. If the task involves metrics, stats, account data, or any factual lookup, you MUST obtain the real values through your tools. If a tool fails or the data is unavailable, say exactly that — an honest failure report is valuable; invented numbers are harmful and destroy trust.`);
    lines.push('', '## RESULT CONTRACT', structuredResultPrompt(run?.acceptanceCriteria ?? []));
    lines.push('');
    lines.push(`Current date: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`Workspace: ${workspace}`);

    return lines.join('\n');
  }

  /**
   * Create a filtered view of the SkillRegistry for sub-agents.
   * Returns a proxy that only exposes allowed skills.
   */
  private createFilteredSkillRegistry(allowedNames: Set<string>): SkillRegistry {
    // Build a proxy that delegates to the real registry but filters results
    const realRegistry = this.skillRegistry;

    return new Proxy(realRegistry, {
      get(target, prop, receiver) {
        if (prop === 'getExecutableSkills') {
          return () => {
            const all = target.getExecutableSkills();
            return all.filter((s: Skill) => allowedNames.has(s.name));
          };
        }
        if (prop === 'getToolDefinitions') {
          return () => {
            const all = target.getToolDefinitions();
            return all.filter((t: { name: string }) => allowedNames.has(t.name));
          };
        }
        if (prop === 'generateSkillPrompt') {
          return (_options?: Record<string, unknown>) => {
            // Generate prompt for allowed executable skills
            const allSkills = target.getExecutableSkills();
            const filtered = allSkills.filter((s: Skill) => allowedNames.has(s.name));

            // Also include documentation/bash-based skills (e.g. web_search)
            const docSkills = target.getDocumentationSkills();
            const filteredDocs = docSkills.filter((s: Skill) => allowedNames.has(s.name));

            if (filtered.length === 0 && filteredDocs.length === 0) return '';

            const lines: string[] = [];

            if (filtered.length > 0) {
              lines.push('# Available Skills', '', 'You can invoke the following skills directly:', '');
              for (const skill of filtered) {
                lines.push(`- **${skill.name}**: ${skill.description}`);
              }
            }

            if (filteredDocs.length > 0) {
              if (filtered.length > 0) lines.push('');
              lines.push('# Bash-Based Skills', '');
              lines.push('These skills are invoked via the bash tool. The description shows usage. For advanced options, read the SKILL.md at the path shown.');
              for (const skill of filteredDocs) {
                lines.push(`- **${skill.name}**: ${skill.description}`);
                lines.push(`  Docs: ${skill.path}`);
              }
            }

            return lines.join('\n');
          };
        }
        if (prop === 'getSkill') {
          return (name: string) => {
            if (!allowedNames.has(name)) return undefined;
            return target.getSkill(name);
          };
        }
        if (prop === 'hasSkill') {
          return (name: string) => {
            return allowedNames.has(name) && target.hasSkill(name);
          };
        }
        if (prop === 'isSkillAvailable') {
          return (name: string) => {
            return allowedNames.has(name) && target.isSkillAvailable(name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SkillRegistry;
  }

  /**
   * Resolve which skills a sub-agent is allowed to use
   */
  private async resolveAllowedSkills(
    requestedSkills: string[],
    task: string,
    run: SubAgentRun,
  ): Promise<Set<string>> {
    let skillNames: string[];

    if (requestedSkills.length > 0) {
      // User specified skills — use those, minus never-allowed
      skillNames = requestedSkills.filter((s) => !NEVER_ALLOWED_SKILLS.has(s));
    } else {
      // Auto-select based on task keywords
      const autoSelected = new Set(run.contextMode === 'isolated' ? ['read_file'] : DEFAULT_SUBAGENT_SKILLS);
      for (const rule of SKILL_KEYWORD_MAP) {
        if (rule.patterns.test(task)) {
          for (const skill of rule.skills) {
            autoSelected.add(skill);
          }
        }
      }
      skillNames = [...autoSelected].filter((s) => !NEVER_ALLOWED_SKILLS.has(s));
    }
    if (run.role === 'orchestrator') {
      skillNames.push('spawn_agent', 'check_agents');
    }

    // Only include skills that actually exist in the registry (executable or documentation)
    const executableNames = this.skillRegistry.getExecutableSkills().map((s) => s.name);
    const docNames = this.skillRegistry.getDocumentationSkills().map((s) => s.name);
    const existing = new Set([...executableNames, ...docNames]);
    const candidates = [...new Set(skillNames.filter((s) => existing.has(s)))];
    if (!this.skillPolicyResolver) return new Set(candidates);

    const allowed = new Set<string>();
    for (const skillName of candidates) {
      try {
        if (await this.skillPolicyResolver(skillName, {
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          runId: run.id,
        })) {
          allowed.add(skillName);
        } else {
          this.logger.warn({ runId: run.id, skillName }, 'Sub-agent skill denied by parent policy');
        }
      } catch (error) {
        this.logger.warn(
          { runId: run.id, skillName, error: (error as Error).message },
          'Sub-agent skill policy check failed closed',
        );
      }
    }
    return allowed;
  }

  /**
   * Create a read-only proxy for ScallopMemoryStore.
   * Allows search/get methods, blocks add/update/delete.
   */
  private createReadOnlyMemoryProxy(): ScallopMemoryStore | undefined {
    if (!this.scallopStore) return undefined;

    const store = this.scallopStore;
    const logger = this.logger;

    return new Proxy(store, {
      get(target, prop, receiver) {
        // Block write operations
        const writeOps = new Set(['add', 'update', 'delete', 'archive', 'addRelation']);
        if (typeof prop === 'string' && writeOps.has(prop)) {
          return (..._args: unknown[]) => {
            logger.debug({ operation: prop }, 'Sub-agent memory write blocked (read-only mode)');
            // Return harmless no-op values
            if (prop === 'add') return null;
            if (prop === 'update' || prop === 'delete' || prop === 'archive') return false;
            return undefined;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ScallopMemoryStore;
  }

  /**
   * Wrap an LLM provider with token budget enforcement.
   * Tracks cumulative input tokens and throws when the budget is exceeded.
   */
  private createTokenBudgetProvider(provider: LLMProvider, runId: string): LLMProvider {
    const maxInputTokens = this.config.maxInputTokens;
    const logger = this.logger;
    let cumulativeInputTokens = 0;

    return {
      name: provider.name,
      model: provider.model,
      isAvailable: () => provider.isAvailable(),
      complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
        const run = this.registry.getRun(runId);
        if (run && this.costTracker && this.costTracker.getSessionSpend(run.childSessionId) >= this.config.maxCostUsdPerRun) {
          const message = `Sub-agent cost budget reached ($${this.config.maxCostUsdPerRun.toFixed(2)})`;
          this.budgetFailures.set(runId, message);
          throw Object.assign(new Error(message), { code: 'LOCAL_BUDGET_EXCEEDED' });
        }
        if (cumulativeInputTokens >= maxInputTokens) {
          const message = `Sub-agent token budget exceeded: ${cumulativeInputTokens}/${maxInputTokens} input tokens used`;
          this.budgetFailures.set(runId, message);
          throw Object.assign(new Error(message), { code: 'LOCAL_BUDGET_EXCEEDED' });
        }
        const response = await provider.complete(request);
        this.registry.markProgress(runId);
        cumulativeInputTokens += response.usage.inputTokens;
        if (cumulativeInputTokens >= maxInputTokens) {
          logger.warn(
            { runId, cumulativeInputTokens, maxInputTokens },
            'Sub-agent token budget reached — will abort on next call'
          );
        }
        return response;
      },
      stream: provider.stream
        ? (request: CompletionRequest) => provider.stream!(request)
        : undefined,
    };
  }

  /**
   * Build a complete honest result for every non-success terminal path.
   */
  private failureResult(
    errorMsg: string,
    status: 'failed' | 'blocked' | 'cancelled' | 'timed_out' = 'failed',
    evidenceReceipts: ToolEvidenceReceipt[] = [],
    costUsd = 0,
  ): SubAgentResult {
    const structured = buildStructuredSubAgentResult({
      response: errorMsg,
      runtimeStatus: status,
      evidenceReceipts,
      additionalBlockers: [errorMsg],
    });
    return {
      ...structured,
      response: structured.summary,
      iterationsUsed: 0,
      taskComplete: false,
      costUsd,
    };
  }

  private async enqueueDurableDelivery(run: SubAgentRun, result: SubAgentResult): Promise<void> {
    if (!this.deliveryOutbox) return;
    const parent = await this.sessionManager.getSession(run.parentSessionId);
    this.deliveryOutbox.enqueueSubAgentDelivery({
      runId: run.id,
      parentSessionId: run.parentSessionId,
      userId: typeof parent?.metadata?.userId === 'string' ? parent.metadata.userId : null,
      payloadJson: JSON.stringify({ runId: run.id, label: run.label, result }),
    });
  }

  /**
   * Announce a failure to the parent via the announce queue
   */
  private announceFailure(run: SubAgentRun, errorMsg: string): void {
    this.announceQueue.enqueue({
      runId: run.id,
      parentSessionId: run.parentSessionId,
      label: run.label,
      result: this.failureResult(
        errorMsg,
        run.status === 'timed_out' ? 'timed_out' : run.status === 'cancelled' ? 'cancelled' : run.status === 'blocked' ? 'blocked' : 'failed',
        [],
        this.costTracker?.getSessionSpend(run.childSessionId) ?? 0,
      ),
      tokenUsage: run.tokenUsage,
      timestamp: Date.now(),
    });
  }
}
