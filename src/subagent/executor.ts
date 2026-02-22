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
import type {
  SubAgentConfig,
  SubAgentResult,
  SpawnAgentInput,
  AnnounceEntry,
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
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'web_search',
  'agent_browser',
  'memory_search',
];

/**
 * Keyword-based skill auto-selection rules
 */
const SKILL_KEYWORD_MAP: Array<{ patterns: RegExp; skills: string[] }> = [
  { patterns: /search|research|find|look up|query/i, skills: ['web_search', 'agent_browser'] },
  { patterns: /file|read|code|write|edit|script/i, skills: ['read_file', 'edit_file', 'write_file', 'bash'] },
  { patterns: /memory|remember|recall|fact/i, skills: ['memory_search'] },
  { patterns: /browse|web|url|page|site/i, skills: ['agent_browser', 'web_search'] },
];

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
    const session = await this.sessionManager.createSession({
      isSubAgent: true,
      parentSessionId,
      label: input.label || 'sub-agent',
    });

    const run = this.registry.createRun(parentSessionId, input, session.id);

    // Fire and forget — result will be enqueued via lane serialization
    enqueueInLane(`subagent:${run.id}`, () => this.executeSubAgent(run, parentOnProgress)).catch((err) => {
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
    const session = await this.sessionManager.createSession({
      isSubAgent: true,
      parentSessionId,
      label: input.label || 'sub-agent',
    });

    const run = this.registry.createRun(parentSessionId, input, session.id);
    return this.executeSubAgent(run, parentOnProgress);
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
  ): Promise<SubAgentResult> {
    this.registry.updateStatus(run.id, 'running');

    // 1. Select provider via router
    const provider = await this.router.selectProvider(run.modelTier);
    if (!provider) {
      const error = `No provider available for tier "${run.modelTier}"`;
      this.registry.updateStatus(run.id, 'failed', undefined, error);
      this.announceFailure(run, error);
      throw new Error(error);
    }

    // 2. Wrap provider with cost tracker
    let activeProvider: LLMProvider = provider;
    if (this.costTracker) {
      activeProvider = this.costTracker.wrapProvider(provider, run.childSessionId);
    }

    // 3. Wrap provider with token budget enforcement
    activeProvider = this.createTokenBudgetProvider(activeProvider, run.id);

    // 4. Build enriched system prompt (async — fetches profile + memories)
    const systemPrompt = await this.buildSubAgentPrompt(run.task, run.recentChatContext);

    // 5. Create filtered skill registry
    const filteredRegistry = this.createFilteredSkillRegistry(run.allowedSkills, run.task);

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
    });

    // 8. Set up timeout via AbortController
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), run.timeoutMs);
    this.activeAbortControllers.set(run.id, controller);

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
        shouldStop
      );

      // Determine if task was completed based on response content
      const taskComplete = result.response.includes('[DONE]') || result.iterationsUsed < this.config.maxIterations;

      const subAgentResult: SubAgentResult = {
        response: result.response.replace(/\[DONE\]\s*$/, '').trim(),
        iterationsUsed: result.iterationsUsed,
        taskComplete,
      };

      // Update registry
      this.registry.updateStatus(run.id, 'completed', subAgentResult);
      this.registry.updateTokenUsage(run.id, result.tokenUsage);

      // Enqueue result for parent (async spawn only — for spawnAndWait, caller gets result directly)
      this.announceQueue.enqueue({
        runId: run.id,
        parentSessionId: run.parentSessionId,
        label: run.label,
        result: subAgentResult,
        tokenUsage: result.tokenUsage,
        timestamp: Date.now(),
      });

      this.logger.info(
        {
          runId: run.id,
          label: run.label,
          iterations: result.iterationsUsed,
          tokens: result.tokenUsage.inputTokens + result.tokenUsage.outputTokens,
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
      this.announceFailure(run, errorMsg);

      this.logger.warn({ runId: run.id, label: run.label, status, error: errorMsg }, 'Sub-agent failed');

      return {
        response: `Error: ${errorMsg}`,
        iterationsUsed: 0,
        taskComplete: false,
      };
    } finally {
      clearTimeout(timeout);
      this.activeAbortControllers.delete(run.id);
    }
  }

  /**
   * Build an enriched system prompt for sub-agents with user context and memory.
   */
  private async buildSubAgentPrompt(task: string, recentChatContext?: string): Promise<string> {
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
      const userProfile = this.scallopStore.getProfileManager().getStaticProfile('default');
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
          userId: 'default',
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
      } catch {
        // Memory search failure is non-fatal
      }
    }

    lines.push('## TASK');
    lines.push(task);
    lines.push('');
    lines.push('## RESEARCH WORKFLOW');
    lines.push('1. Check the RELEVANT MEMORIES above first — avoid re-researching known facts.');
    lines.push('2. Use **memory_search** to find additional stored knowledge before going to the web.');
    lines.push('3. Use **web_search** (via bash) for fresh information not found in memory.');
    lines.push('4. Use **agent_browser** only when you need to read a specific page in detail.');
    lines.push('5. Synthesize findings concisely.');
    lines.push('');
    lines.push('## RULES');
    lines.push(`1. Complete the task, then write a short user-facing summary of what you did and what the result was. This summary is sent directly to the user — don't just say "Done", describe the outcome.`);
    lines.push(`2. End your response with [DONE] when finished.`);
    lines.push(`3. You have a LIMITED iteration budget (${this.config.maxIterations} iterations). Be efficient.`);
    lines.push(`4. Do NOT send messages to the user, manage goals, set reminders, or spawn agents.`);
    lines.push(`5. Focus ONLY on the assigned task.`);
    lines.push('');
    lines.push(`Current date: ${new Date().toISOString().split('T')[0]}`);
    lines.push(`Workspace: ${this.workspace}`);

    return lines.join('\n');
  }

  /**
   * Create a filtered view of the SkillRegistry for sub-agents.
   * Returns a proxy that only exposes allowed skills.
   */
  private createFilteredSkillRegistry(requestedSkills: string[], task: string): SkillRegistry {
    const allowedNames = this.resolveAllowedSkills(requestedSkills, task);

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
          return (options?: Record<string, unknown>) => {
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
  private resolveAllowedSkills(requestedSkills: string[], task: string): Set<string> {
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
    return new Set(skillNames.filter((s) => existing.has(s)));
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
      },
      tokenUsage: run.tokenUsage,
      timestamp: Date.now(),
    });
  }
}
