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

/**
 * Skills that sub-agents are never allowed to use
 */
const NEVER_ALLOWED_SKILLS = new Set([
  'spawn_agent',      // Recursion guard
  'check_agents',     // Only for parent
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
  }

  /**
   * Expose config for external consumers (e.g. scheduler)
   */
  getConfig(): SubAgentConfig {
    return this.config;
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
    const session = await this.sessionManager.createSession({
      isSubAgent: true,
      parentSessionId,
      label: input.label || 'sub-agent',
      ...(typeof parent?.metadata?.userId === 'string' ? { userId: parent.metadata.userId } : {}),
      ...(typeof parent?.metadata?.channelId === 'string' ? { channelId: parent.metadata.channelId } : {}),
    });

    const run = this.registry.createRun(parentSessionId, input, session.id);

    // Fire and forget — result will be enqueued via lane serialization
    enqueueInLane(`subagent:${run.id}`, () => this.executeSubAgent(run, parentOnProgress, true)).catch((err) => {
      this.logger.error({ runId: run.id, error: (err as Error).message }, 'Sub-agent execution failed unexpectedly');
    });

    return { runId: run.id, childSessionId: session.id };
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
    const session = await this.sessionManager.createSession({
      isSubAgent: true,
      parentSessionId,
      label: input.label || 'sub-agent',
      ...(typeof parent?.metadata?.userId === 'string' ? { userId: parent.metadata.userId } : {}),
      ...(typeof parent?.metadata?.channelId === 'string' ? { channelId: parent.metadata.channelId } : {}),
    });

    const run = this.registry.createRun(parentSessionId, input, session.id);
    return this.executeSubAgent(run, parentOnProgress, false);
  }

  /**
   * Cancel a specific run
   */
  cancel(runId: string): boolean {
    const controller = this.activeAbortControllers.get(runId);
    if (controller) {
      controller.abort();
      this.registry.updateStatus(runId, 'cancelled');
      this.activeAbortControllers.delete(runId);
      this.logger.info({ runId }, 'Sub-agent cancelled');
      return true;
    }
    return false;
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
    this.registry.updateStatus(run.id, 'running');

    // 1. Select provider via router
    const provider = await this.router.selectProvider(run.modelTier);
    if (!provider) {
      const error = `No provider available for tier "${run.modelTier}"`;
      this.registry.updateStatus(run.id, 'failed', undefined, error);
      if (announceResult) this.announceFailure(run, error);
      throw new Error(error);
    }

    // 2. Wrap provider with cost tracker
    let activeProvider: LLMProvider = provider;
    if (this.costTracker) {
      activeProvider = this.costTracker.wrapProvider(provider, run.childSessionId);
    }

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
    const agent = new Agent({
      provider: activeProvider,
      sessionManager: this.sessionManager,
      skillRegistry: filteredRegistry,
      skillExecutor: this.skillExecutor,
      // Read-only memory: pass store for reads but no factExtractor (no writes)
      scallopStore: this.config.allowMemoryWrites ? this.scallopStore : this.createReadOnlyMemoryProxy(),
      contextManager: subAgentContextManager,
      // Deliberately omitted:
      // - factExtractor (no fact extraction from sub-agent conversations)
      // - goalService (sub-agents don't manage goals)
      // - configManager (sub-agents don't need user config)
      // - mediaProcessor (sub-agents don't process media)
      workspace: this.workspace,
      logger: this.logger,
      maxIterations: this.config.maxIterations,
      systemPrompt,
      canonicalSingleUserIds: this.canonicalSingleUserIds,
    });

    // 8. Set up timeout via AbortController
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), run.timeoutMs);
    this.activeAbortControllers.set(run.id, controller);
    const initialCostUsd = this.costTracker?.getSessionSpend(run.childSessionId) ?? 0;

    const shouldStop = () => controller.signal.aborted;

    // 9. Progress forwarding
    const subProgress: ProgressCallback | undefined = parentOnProgress
      ? async (update) => {
          await parentOnProgress({
            ...update,
            message: `[${run.label}] ${update.message}`,
          });
        }
      : undefined;

    try {
      const result = await agent.processMessage(
        run.childSessionId,
        run.task,
        undefined,
        subProgress,
        shouldStop,
        undefined, // providerOverride
        controller.signal // abortSignal — terminates in-flight LLM HTTP call on timeout/cancel
      );

      // Completion is explicit loop state. Agent strips [DONE] from response text,
      // so inspecting the cleaned response here silently misclassified outcomes.
      const taskComplete = result.completionReason === 'explicit_done'
        || result.completionReason === 'natural_end';
      const costUsd = Math.max(
        0,
        (this.costTracker?.getSessionSpend(run.childSessionId) ?? initialCostUsd) - initialCostUsd,
      );

      const subAgentResult: SubAgentResult = {
        response: result.response.replace(/\[DONE\]\s*$/, '').trim(),
        iterationsUsed: result.iterationsUsed,
        taskComplete,
        costUsd,
      };

      // Update registry
      this.registry.updateStatus(run.id, 'completed', subAgentResult);
      this.registry.updateTokenUsage(run.id, result.tokenUsage);

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
      const isTimeout = controller.signal.aborted;
      const status = isTimeout ? 'timed_out' : 'failed';
      const errorMsg = isTimeout
        ? `Sub-agent timed out after ${run.timeoutMs / 1000}s`
        : (error as Error).message;

      this.registry.updateStatus(run.id, status, undefined, errorMsg);
      if (announceResult) this.announceFailure(run, errorMsg);

      this.logger.warn({ runId: run.id, label: run.label, status, error: errorMsg }, 'Sub-agent failed');

      return {
        response: `Error: ${errorMsg}`,
        iterationsUsed: 0,
        taskComplete: false,
        costUsd: Math.max(
          0,
          (this.costTracker?.getSessionSpend(run.childSessionId) ?? initialCostUsd) - initialCostUsd,
        ),
      };
    } finally {
      clearTimeout(timeout);
      this.activeAbortControllers.delete(run.id);
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
  ): Promise<string> {
    const lines = [
      'You are a focused sub-agent assigned a specific task.',
      '',
    ];

    // Inject agent identity if available
    if (this.scallopStore) {
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
    if (this.scallopStore) {
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
    if (recentChatContext) {
      lines.push('## RECENT CONVERSATION');
      lines.push('Recent exchanges with the user for context. Use this to make your response');
      lines.push('relevant to their current situation. Do NOT repeat or quote these messages.');
      lines.push(recentChatContext);
      lines.push('');
    }

    // Inject relevant memories
    if (this.scallopStore) {
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
    lines.push('');
    lines.push('## RESEARCH WORKFLOW');
    lines.push('1. Check the RELEVANT MEMORIES above first — avoid re-researching known facts.');
    if (allowedSkills.has('memory_search')) {
      lines.push('2. Use **memory_search** to find additional stored knowledge.');
    }
    if (allowedSkills.has('agent_browser')) {
      lines.push('3. Use **agent_browser** when fresh web information or a specific page is required.');
    }
    lines.push('4. Use only the tools exposed to this sub-agent; unavailable tools are intentionally restricted.');
    lines.push('5. Synthesize findings concisely.');
    lines.push('');
    lines.push('## RULES');
    lines.push(`1. Complete the task, then write a short user-facing summary of what you did and what the result was. This summary is sent directly to the user — don't just say "Done", describe the outcome.`);
    lines.push(`2. End your response with [DONE] when finished.`);
    lines.push(`3. You have a LIMITED iteration budget (${this.config.maxIterations} iterations). Be efficient.`);
    lines.push(`4. Do NOT send messages to the user, manage goals, set reminders, or spawn agents.`);
    lines.push(`5. Focus ONLY on the assigned task.`);
    lines.push(`6. NEVER fabricate data. If the task involves metrics, stats, account data, or any factual lookup, you MUST obtain the real values through your tools. If a tool fails or the data is unavailable, say exactly that ("I couldn't retrieve X because Y") — an honest failure report is valuable; invented numbers are harmful and destroy trust.`);
    lines.push('');
    lines.push(`Current date: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`Workspace: ${this.workspace}`);

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
      const autoSelected = new Set(DEFAULT_SUBAGENT_SKILLS);
      for (const rule of SKILL_KEYWORD_MAP) {
        if (rule.patterns.test(task)) {
          for (const skill of rule.skills) {
            autoSelected.add(skill);
          }
        }
      }
      skillNames = [...autoSelected].filter((s) => !NEVER_ALLOWED_SKILLS.has(s));
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
      isAvailable: () => provider.isAvailable(),
      complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
        if (cumulativeInputTokens >= maxInputTokens) {
          throw new Error(
            `Sub-agent token budget exceeded: ${cumulativeInputTokens}/${maxInputTokens} input tokens used`
          );
        }
        const response = await provider.complete(request);
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
   * Announce a failure to the parent via the announce queue
   */
  private announceFailure(run: SubAgentRun, errorMsg: string): void {
    this.announceQueue.enqueue({
      runId: run.id,
      parentSessionId: run.parentSessionId,
      label: run.label,
      result: {
        response: `Error: ${errorMsg}`,
        iterationsUsed: 0,
        taskComplete: false,
        costUsd: this.costTracker?.getSessionSpend(run.childSessionId) ?? 0,
      },
      tokenUsage: run.tokenUsage,
      timestamp: Date.now(),
    });
  }
}
