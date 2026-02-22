import * as fs from 'fs/promises';
import * as path from 'path';
import type { Logger } from 'pino';
import type {
  LLMProvider,
  ContentBlock,
  ToolUseContent,
  TokenUsage,
  CompletionRequest,
  CompletionResponse,
} from '../providers/types.js';
import type { SessionManager } from './session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { Router } from '../routing/router.js';
import type { CostTracker } from '../routing/cost.js';
import type { LLMFactExtractor } from '../memory/fact-extractor.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { ContextManager } from '../routing/context.js';
import type { MediaProcessor } from '../media/index.js';
import type { Attachment } from '../channels/types.js';
import { analyzeComplexity } from '../routing/complexity.js';
import type { GoalService } from '../goals/index.js';
import type { BotConfigManager } from '../channels/bot-config.js';
import type { AnnounceQueue } from '../subagent/announce-queue.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import type { BoardService } from '../board/board-service.js';
import type { InterruptQueue } from './interrupt-queue.js';
import { type ThinkLevel, booleanToThinkLevel, mapThinkLevelToProvider, pickFallbackLevel } from './thinking.js';
import { ToolLoopDetector, type LoopDetection } from './tool-loop-detector.js';
import { triggerHook, type HookEvent } from '../hooks/hooks.js';
import { applyToolPolicyPipeline, type ToolPolicy } from '../skills/tool-policy.js';
import { enqueueInLane } from './command-queue.js';
import { progressiveCompact } from '../routing/compaction.js';

export interface AgentOptions {
  provider: LLMProvider;
  sessionManager: SessionManager;
  skillRegistry?: SkillRegistry;
  skillExecutor?: SkillExecutor;
  router?: Router;
  costTracker?: CostTracker;
  scallopStore?: ScallopMemoryStore;
  factExtractor?: LLMFactExtractor;
  contextManager?: ContextManager;
  mediaProcessor?: MediaProcessor;
  goalService?: GoalService;
  configManager?: BotConfigManager;
  workspace: string;
  logger: Logger;
  maxIterations: number;
  systemPrompt?: string;
  /** Enable extended thinking for supported providers (e.g., Kimi K2.5) */
  enableThinking?: boolean;
  /** Granular thinking level (overrides enableThinking if set) */
  thinkLevel?: ThinkLevel;
  /** Global tool policy for filtering available tools */
  toolPolicy?: ToolPolicy;
  /** Announce queue for receiving sub-agent results (main agent only) */
  announceQueue?: AnnounceQueue;
  /** Sub-agent executor for cancellation propagation (main agent only) */
  subAgentExecutor?: SubAgentExecutor;
  /** Board service for task board context injection */
  boardService?: BoardService;
  /** Interrupt queue for mid-loop user message injection */
  interruptQueue?: InterruptQueue;
}

export interface AgentResult {
  response: string;
  tokenUsage: TokenUsage;
  iterationsUsed: number;
}

/**
 * Progress callback for streaming updates during agent execution
 */
export type ProgressCallback = (update: ProgressUpdate) => Promise<void>;

/**
 * Callback to check if processing should stop (user requested /stop)
 */
export type ShouldStopCallback = () => boolean;

export interface ProgressUpdate {
  type: 'thinking' | 'planning' | 'tool_start' | 'tool_complete' | 'tool_error' | 'memory' | 'status';
  message: string;
  toolName?: string;
  iteration?: number;
  /** For memory events */
  count?: number;
  action?: string;
  items?: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
}

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI assistant with direct system access via skills. Get things done - don't describe, DO.

## HOW TO WORK
1. Act immediately - use skills, don't ask permission
2. Fix blockers yourself - missing deps? Install them (npm/pip/brew)
3. Try alternatives - if one approach fails, try another before asking
4. When in doubt, search the web for latest ways to achieve things using bash.
5. Loop until done. After each action: "Is this complete?" YES → [DONE]. NO → continue.
5. Never [DONE] mid-response. Only at the very end.
6. Never fabricate API keys or credentials.

BAD: "I can't run prettier - it's not installed."
GOOD: *npm install -D prettier* "Installed. Formatting now..."

## RESEARCH & LONG TASKS
- **You have a LIMITED number of iterations** (see ITERATION BUDGET below). Plan your research wisely — don't waste iterations on repeated or low-value searches.
- **Send progress updates.** On long tasks, call send_message every 5-10 tool calls to tell the user what you're up to. Don't go silent — the user is waiting and needs to know you're still working and making progress.
- **"Good enough" wins.** If you find results that partially answer the question, present them. Don't keep searching for perfection — note caveats instead.
- **Never repeat searches.** Before each web-search, check if you already searched something similar. Rephrase or skip.
- **Browser failures = move on.** If agent-browser gets blocked or returns empty content twice in a row, stop browsing and work with what web-search gave you.
- **Synthesize, don't hoard.** Your job is to deliver answers, not collect data. Once you have enough info to give a useful response, wrap it up with [DONE].

## CAPABILITIES
You have skills for: **web search** (via bash), **web browsing** (via bash), **file operations**, **memory**, **communication**, **scheduling**, and **goal tracking**. See the full skill list at the end of this prompt.

## MEMORY
- USER PROFILE (location, name, timezone) is always available — use it automatically
- Facts shown in "MEMORIES FROM THE PAST" section
- Personal refs ("my flatmate", "my project") → memory_search first
- Current info (news, weather, sports) → bash with web-search, then browse pages for detail

## COMMUNICATION
Text like messaging a friend. Short, punchy, 1-3 sentences. **Bold** and bullet lists, no markdown headings.
Progress updates before each skill. Results: answer first, details after. Multi-step: use send_message along the way.

BAD: "wget failed."
GOOD: "wget failed, trying curl..." *curl -O* "Downloaded."

**Conversational:**
BAD: "Based on meteorological data, precipitation probability is 80%."
GOOD: "Yeah it's gonna rain - 80% chance. Bring an umbrella!"

BAD: "I have successfully completed the file creation process."
GOOD: "Done! File's saved." [DONE]

## FOLLOW-UPS
If you tell the user you'll "check back", "follow up", or "check on this later", you MUST schedule it using the **board** skill right then — don't rely on remembering. Use \`action: "add", kind: "task", trigger_time: "in X min"\` with a goal describing what to check. If you don't schedule it, it won't happen.

You're on the user's server. Be autonomous, persistent, helpful.`;

export class Agent {
  private provider: LLMProvider;
  private sessionManager: SessionManager;
  private skillRegistry: SkillRegistry | null;
  private skillExecutor: SkillExecutor | null;
  private router: Router | null;
  private costTracker: CostTracker | null;
  private scallopStore: ScallopMemoryStore | null;
  private factExtractor: LLMFactExtractor | null;
  private contextManager: ContextManager | null;
  private mediaProcessor: MediaProcessor | null;
  private goalService: GoalService | null;
  private configManager: BotConfigManager | null;
  private workspace: string;
  private logger: Logger;
  private maxIterations: number;
  private baseSystemPrompt: string;
  /** Stores recent assistant response per session for contextual fact extraction */
  private lastAssistantResponses: Map<string, string> = new Map();
  /** Enable extended thinking for supported providers */
  private enableThinking: boolean;
  /** Granular thinking level */
  private thinkLevel: ThinkLevel;
  /** Global tool policy */
  private toolPolicy: ToolPolicy | undefined;
  /** Announce queue for receiving sub-agent results */
  private announceQueue: AnnounceQueue | null;
  /** Sub-agent executor for cancellation propagation */
  private subAgentExecutor: SubAgentExecutor | null;
  /** Board service for task board context injection */
  private boardService: BoardService | null;
  /** Interrupt queue for mid-loop user message injection */
  private interruptQueue: InterruptQueue | null;

  /** Enhanced tool loop detector */
  private toolLoopDetector = new ToolLoopDetector();

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.sessionManager = options.sessionManager;
    this.skillRegistry = options.skillRegistry || null;
    this.skillExecutor = options.skillExecutor || null;
    this.router = options.router || null;
    this.costTracker = options.costTracker || null;
    this.scallopStore = options.scallopStore || null;
    this.factExtractor = options.factExtractor || null;
    this.contextManager = options.contextManager || null;
    this.mediaProcessor = options.mediaProcessor || null;
    this.goalService = options.goalService || null;
    this.configManager = options.configManager || null;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.maxIterations = options.maxIterations;
    this.baseSystemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.enableThinking = options.enableThinking ?? false;
    this.thinkLevel = options.thinkLevel ?? booleanToThinkLevel(this.enableThinking);
    this.toolPolicy = options.toolPolicy;
    this.announceQueue = options.announceQueue || null;
    this.subAgentExecutor = options.subAgentExecutor || null;
    this.boardService = options.boardService || null;
    this.interruptQueue = options.interruptQueue || null;

    this.logger.info({ enableThinking: this.enableThinking }, 'Agent thinking mode configured');
  }

  /**
   * Process a message with optional attachments
   * @param onProgress - Optional callback for streaming progress updates
   * @param shouldStop - Optional callback to check if user requested stop
   */
  async processMessage(
    sessionId: string,
    userMessage: string,
    attachments?: Attachment[],
    onProgress?: ProgressCallback,
    shouldStop?: ShouldStopCallback,
    providerOverride?: LLMProvider
  ): Promise<AgentResult> {
    // Session lane serialization: ensure sequential processing per session
    return enqueueInLane(`session:${sessionId}`, async () => {
      return this._processMessageInner(sessionId, userMessage, attachments, onProgress, shouldStop, providerOverride);
    }, { warnAfterMs: 5000 });
  }

  /**
   * Inner processMessage implementation (called within session lane).
   */
  private async _processMessageInner(
    sessionId: string,
    userMessage: string,
    attachments?: Attachment[],
    onProgress?: ProgressCallback,
    shouldStop?: ShouldStopCallback,
    providerOverride?: LLMProvider
  ): Promise<AgentResult> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Emit agent:start and message:received hooks
    triggerHook({
      type: 'agent',
      action: 'start',
      sessionId,
      context: { userMessage: userMessage.slice(0, 200) },
      timestamp: new Date(),
    }).catch(() => {}); // Fire and forget

    triggerHook({
      type: 'message',
      action: 'received',
      sessionId,
      context: { messageLength: userMessage.length },
      timestamp: new Date(),
    }).catch(() => {});

    // Single-user bot: use canonical 'default' userId for all memory operations.
    // This keeps memories unified across channels (Telegram, WebSocket, etc.).
    // Channel routing for proactive delivery is handled by the scheduler.
    const resolvedUserId = 'default';

    // Check budget before processing
    if (this.costTracker) {
      const budgetCheck = this.costTracker.canMakeRequest();
      if (!budgetCheck.allowed) {
        this.logger.warn({ sessionId, reason: budgetCheck.reason }, 'Request blocked by budget');
        return {
          response: `I cannot process this request: ${budgetCheck.reason}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          iterationsUsed: 0,
        };
      }
    }

    // Process media (URLs in text and attachments) if media processor available
    let processedContent: ContentBlock[] | string = userMessage;
    let hasImageAttachments = false;
    if (this.mediaProcessor) {
      try {
        const { content, processedMedia, errors } = await this.mediaProcessor.processMessage(
          userMessage,
          attachments || []
        );

        // If we processed any media, use content blocks
        if (processedMedia.length > 0) {
          processedContent = content;
          hasImageAttachments = processedMedia.some((m) => m.type === 'image');
          this.logger.debug(
            { mediaCount: processedMedia.length, types: processedMedia.map((m) => m.type) },
            'Media processed'
          );
        }

        // Log any media processing errors
        for (const error of errors) {
          this.logger.warn({ error }, 'Media processing error');
        }
      } catch (error) {
        this.logger.error({ error: (error as Error).message }, 'Media processing failed');
        // Continue with text-only message
      }
    }

    // Analyze message complexity for provider selection
    const complexity = analyzeComplexity(userMessage);
    this.logger.debug(
      { complexity: complexity.tier, suggestedTier: complexity.suggestedModelTier },
      'Complexity analysis'
    );

    // Select provider: explicit override > router > default
    let activeProvider: LLMProvider = this.provider;
    if (providerOverride) {
      activeProvider = providerOverride;
      this.logger.debug({ provider: activeProvider.name }, 'Provider set by user override');
    } else if (this.router) {
      const selectedProvider = await this.router.selectProvider(complexity.suggestedModelTier);
      if (selectedProvider) {
        activeProvider = selectedProvider;
        this.logger.debug({ provider: activeProvider.name }, 'Provider selected by router');
      }
    }

    // Add user message to session (store original text, content blocks used for LLM only)
    await this.sessionManager.addMessage(sessionId, {
      role: 'user',
      content: typeof processedContent === 'string' ? processedContent : processedContent,
    });

    // Queue LLM-based fact extraction (async, non-blocking)
    // Skip sub-agent results — they're bot output, not user facts, and would
    // re-extract triggers for events already being processed (causing runaway loops).
    // Skip image messages here — they get a post-response extraction pass instead,
    // which includes the assistant's description of the image content.
    const isSubAgentResult = typeof userMessage === 'string' && userMessage.startsWith('[Sub-agent "');
    if (this.factExtractor && !isSubAgentResult && !hasImageAttachments) {
      this.factExtractor.queueForExtraction(
        userMessage,
        resolvedUserId,
        this.lastAssistantResponses.get(sessionId) || undefined
      ).catch((error) => {
        this.logger.warn({ error: (error as Error).message }, 'Async fact extraction failed');
      });
    }

    // Per-message affect classification (sync, non-blocking)
    // Only classify user messages — bot messages would contaminate affect signal
    if (this.scallopStore) {
      try {
        const { classifyAffect } = await import('../memory/affect.js');
        const { updateAffectEMA, getSmoothedAffect, createInitialAffectState } = await import('../memory/affect-smoothing.js');

        const rawAffect = classifyAffect(userMessage);
        const profileManager = this.scallopStore.getProfileManager();
        const existingPatterns = profileManager.getBehavioralPatterns(resolvedUserId);
        const currentState = existingPatterns?.affectState ?? createInitialAffectState();
        const newState = updateAffectEMA(currentState, rawAffect, Date.now());
        const smoothed = getSmoothedAffect(newState);

        // Persist affect EMA state and smoothed affect
        profileManager.updateBehavioralPatterns(resolvedUserId, {
          affectState: newState,
          smoothedAffect: smoothed,
        });

        // Update dynamic profile currentMood with emotion label (backward compat)
        profileManager.setCurrentMood(resolvedUserId, smoothed.emotion);

        this.logger.debug(
          { emotion: smoothed.emotion, valence: smoothed.valence.toFixed(2), arousal: smoothed.arousal.toFixed(2), goalSignal: smoothed.goalSignal },
          'Affect classified'
        );
      } catch (error) {
        this.logger.warn({ error: (error as Error).message }, 'Affect classification failed');
      }
    }

    // Build system prompt with memory context
    const { prompt: systemPrompt, memoryStats, memoryItems } = await this.buildSystemPrompt(userMessage, sessionId, resolvedUserId);

    // Report memory usage if we found any memories
    if (onProgress && (memoryStats.factsFound > 0 || memoryStats.conversationsFound > 0)) {
      await onProgress({
        type: 'memory',
        action: 'search',
        message: `Found ${memoryStats.factsFound} facts, ${memoryStats.conversationsFound} conversations`,
        count: memoryStats.factsFound + memoryStats.conversationsFound,
        items: memoryItems,
      });
    }

    // Wrap provider with cost tracker so each LLM call records its own usage
    if (this.costTracker) {
      activeProvider = this.costTracker.wrapProvider(activeProvider, sessionId);
    }

    // Track usage across iterations
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    let finalResponse = '';

    // Agent loop
    while (iterations < this.maxIterations) {
      iterations++;

      // Check if user requested stop
      if (shouldStop && shouldStop()) {
        this.logger.info({ sessionId, iteration: iterations }, 'User requested stop');
        // Cancel any running sub-agents for this session
        if (this.subAgentExecutor) {
          this.subAgentExecutor.cancelForParent(sessionId);
        }
        this.interruptQueue?.clear(sessionId);
        finalResponse = 'Stopped by user request.';
        break;
      }

      // Drain completed sub-agent results
      if (this.announceQueue?.hasPending(sessionId)) {
        const entries = this.announceQueue.drain(sessionId);
        for (const entry of entries) {
          const truncated = entry.result.response.length > 2000
            ? entry.result.response.substring(0, 2000) + `\n...(truncated, ${entry.result.response.length} chars total)`
            : entry.result.response;

          const announceMsg = [
            `[Sub-agent "${entry.label}" completed — ${entry.result.iterationsUsed} iterations, ${entry.tokenUsage.inputTokens + entry.tokenUsage.outputTokens} tokens]`,
            '',
            truncated,
          ].join('\n');

          await this.sessionManager.addMessage(sessionId, {
            role: 'user',
            content: announceMsg,
          });
        }
        this.logger.debug({ sessionId, drained: entries.length }, 'Sub-agent results injected into context');
      }

      // Drain user interrupts (messages sent while agent is processing)
      if (this.interruptQueue?.hasPending(sessionId)) {
        const interrupts = this.interruptQueue.drain(sessionId);
        for (const interrupt of interrupts) {
          await this.sessionManager.addMessage(sessionId, { role: 'user', content: interrupt.text });
          // Queue async fact extraction (non-blocking)
          if (this.factExtractor) {
            this.factExtractor.queueForExtraction(
              interrupt.text,
              resolvedUserId,
              this.lastAssistantResponses.get(sessionId) || undefined
            ).catch((error) => {
              this.logger.warn({ error: (error as Error).message }, 'Async fact extraction failed for interrupt');
            });
          }
        }
        this.logger.debug({ sessionId, drained: interrupts.length }, 'User interrupts injected into context');
      }

      // Refresh tool definitions each iteration so hot-loaded skills appear immediately
      // Apply tool policy pipeline to filter available tools
      let tools = this.skillRegistry
        ? this.skillRegistry.getToolDefinitions()
        : [];
      if (tools.length > 0) {
        const channelId = session?.metadata?.channelId as string | undefined;
        tools = applyToolPolicyPipeline(tools, [
          { label: 'global', policy: this.toolPolicy },
          { label: `channel:${channelId || 'unknown'}` },
        ]);
      }

      // Check budget before each iteration
      if (this.costTracker) {
        const budgetCheck = this.costTracker.canMakeRequest();
        if (!budgetCheck.allowed) {
          this.logger.warn({ sessionId, iteration: iterations }, 'Budget exceeded mid-conversation');
          finalResponse = `I had to stop processing: ${budgetCheck.reason}`;
          break;
        }
      }

      // Get current messages from session
      const currentSession = await this.sessionManager.getSession(sessionId);
      const rawMessages = currentSession?.messages || [];

      // Process messages through context manager (compression, deduplication)
      let messages = this.contextManager
        ? this.contextManager.buildContextMessages(rawMessages)
        : rawMessages;

      // Proactive overflow prevention: prune before sending to avoid wasting a round-trip
      if (this.contextManager) {
        const estimatedTokens = this.contextManager.estimateTokens(messages);
        const maxTokenLimit = this.contextManager.getMaxContextTokens();
        if (estimatedTokens > maxTokenLimit * 0.85) {
          this.logger.info(
            { estimatedTokens, maxTokenLimit, usage: (estimatedTokens / maxTokenLimit * 100).toFixed(1) + '%' },
            'Proactive overflow prevention: pruning tool outputs'
          );
          messages = this.pruneToolOutputs(messages, 6);
        }
      }

      // Map granular thinking level to provider-specific params
      const providerSupportsThinking = activeProvider.name === 'moonshot' || activeProvider.name === 'openai';
      const effectiveThinkLevel = providerSupportsThinking ? this.thinkLevel : 'off';
      const thinkParams = mapThinkLevelToProvider(effectiveThinkLevel, activeProvider.name, '');

      // Build completion request
      // Reasoning models (GPT-5.2, o3, etc.) need higher token limit since
      // reasoning tokens count against max_completion_tokens
      const maxTokens = thinkParams.enableThinking && activeProvider.name === 'openai' ? 16384 : 4096;
      const request: CompletionRequest = {
        messages,
        system: systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens,
        enableThinking: thinkParams.enableThinking,
        thinkingBudgetTokens: thinkParams.thinkingBudgetTokens,
      };

      this.logger.info({ iteration: iterations, messageCount: messages.length, provider: activeProvider.name }, 'Agent iteration starting');

      // Call LLM with error recovery (fallback and emergency compression)
      let response;
      try {
        response = await this.executeWithRecovery(
          activeProvider,
          request,
          sessionId,
          complexity.suggestedModelTier
        );
      } catch (error) {
        this.logger.error({
          iteration: iterations,
          error: (error as Error).message,
          provider: activeProvider.name
        }, 'LLM call failed after recovery attempts');
        throw error;
      }
      // Track token usage
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      // Process response content
      const textContent = this.extractTextContent(response.content);
      const toolUses = this.extractToolUses(response.content);

      // Check for explicit task completion marker
      const taskComplete = this.isTaskComplete(textContent);

      this.logger.info({
        iteration: iterations,
        stopReason: response.stopReason,
        hasText: !!textContent,
        textLength: textContent?.length || 0,
        toolUseCount: toolUses.length,
        toolNames: toolUses.map(t => t.name),
        taskComplete,
      }, 'LLM response received');

      // Send reasoning/thinking content to debug panel (from models with extended thinking)
      const thinkingContent = this.extractThinkingContent(response.content);
      if (thinkingContent && onProgress) {
        try {
          await onProgress({
            type: 'thinking',
            message: thinkingContent,
            iteration: iterations,
          });
        } catch (e) {
          this.logger.warn({ error: (e as Error).message }, 'Thinking progress callback failed');
        }
      }

      // If task is explicitly complete OR no tool use with end_turn, we're done
      if (taskComplete || (response.stopReason === 'end_turn' && toolUses.length === 0)) {
        // Before breaking, check if user sent new messages during this LLM call
        if (this.interruptQueue?.hasPending(sessionId)) {
          // Save assistant response, but DON'T break — continue loop to drain interrupts
          await this.sessionManager.addMessage(sessionId, {
            role: 'assistant',
            content: response.content,
          });
          this.logger.info({ sessionId }, 'Pending user interrupts detected at exit — continuing loop');
          continue;
        }

        // No interrupts — normal exit
        // Strip [DONE] marker from response if present
        finalResponse = taskComplete
          ? this.stripDoneMarker(textContent)
          : textContent || '';

        // Add assistant response to session
        await this.sessionManager.addMessage(sessionId, {
          role: 'assistant',
          content: response.content,
        });

        break;
      }

      // Send assistant's planning text to user before executing tools
      if (textContent && onProgress) {
        // Clean the text content - remove any JSON tool call patterns that some models output
        const cleanedText = this.cleanProgressMessage(textContent);
        if (cleanedText) {
          try {
            await onProgress({
              type: 'planning',
              message: cleanedText,
              iteration: iterations,
            });
          } catch (e) {
            this.logger.warn({ error: (e as Error).message }, 'Progress callback failed');
          }
        }
      }

      // Add assistant message with tool use
      await this.sessionManager.addMessage(sessionId, {
        role: 'assistant',
        content: response.content,
      });

      // Execute tools and gather results
      this.logger.info({ toolCount: toolUses.length, tools: toolUses.map(t => t.name) }, 'Executing tools');
      const userId = currentSession?.metadata?.userId;
      const toolResults = await this.executeTools(toolUses, sessionId, userId, onProgress, shouldStop);
      this.logger.info({
        resultCount: toolResults.length,
        results: toolResults.map(r => ({
          type: r.type,
          isError: 'is_error' in r ? r.is_error : false,
          contentLength: 'content' in r ? String(r.content).length : 0,
        }))
      }, 'Tool execution complete');

      // Add tool results as user message
      await this.sessionManager.addMessage(sessionId, {
        role: 'user',
        content: toolResults,
      });
      this.logger.info({ iteration: iterations }, 'Tool results added to session, continuing loop');

      // Enhanced tool loop detection via ToolLoopDetector
      for (const t of toolUses) {
        this.toolLoopDetector.recordToolCall(sessionId, t.name, t.input, t.id);
      }
      // Record outcomes from tool results
      for (const result of toolResults) {
        if (result.type === 'tool_result') {
          const tr = result as { tool_use_id: string; content: string };
          this.toolLoopDetector.recordToolOutcome(sessionId, tr.tool_use_id, tr.content);
        }
      }

      const loopDetection = this.toolLoopDetector.detect(sessionId);
      if (loopDetection) {
        this.logger.warn(
          { sessionId, kind: loopDetection.kind, severity: loopDetection.severity, tool: loopDetection.toolName, count: loopDetection.count },
          'Tool loop detected'
        );

        // Emit hook
        triggerHook({
          type: 'tool',
          action: 'loop_detected',
          sessionId,
          context: { kind: loopDetection.kind, severity: loopDetection.severity, toolName: loopDetection.toolName, count: loopDetection.count },
          timestamp: new Date(),
        }).catch(() => {});

        await this.sessionManager.addMessage(sessionId, {
          role: 'user',
          content: `[System: ${loopDetection.message}]`,
        });

        // On block severity, force exit the loop
        if (loopDetection.severity === 'block') {
          finalResponse = `I got stuck in a loop and had to stop. ${loopDetection.message}`;
          break;
        }
      }

      // Check if user requested stop after tool execution (don't wait for next iteration's LLM call)
      if (shouldStop && shouldStop()) {
        this.logger.info({ sessionId, iteration: iterations }, 'User requested stop after tool execution');
        // Cancel any running sub-agents for this session
        if (this.subAgentExecutor) {
          this.subAgentExecutor.cancelForParent(sessionId);
        }
        this.interruptQueue?.clear(sessionId);
        finalResponse = 'Stopped by user request.';
        break;
      }

      // If this is the last iteration, add a warning
      if (iterations >= this.maxIterations) {
        finalResponse = `I've reached the maximum iterations (${this.maxIterations}). Here's what I've done so far: ${textContent || 'Multiple tool operations completed.'}`;
      }
    }

    // Clean up tool loop detector for this session
    this.toolLoopDetector.clearSession(sessionId);

    // Emit agent:complete hook
    triggerHook({
      type: 'agent',
      action: 'complete',
      sessionId,
      context: { iterations, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      timestamp: new Date(),
    }).catch(() => {});

    // Record token usage
    const tokenUsage = { inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    await this.sessionManager.recordTokenUsage(sessionId, tokenUsage);

    // Log cost summary (recording now happens per-call via wrapProvider)
    if (this.costTracker) {
      const budget = this.costTracker.getBudgetStatus();
      this.logger.debug(
        { dailySpend: budget.dailySpend.toFixed(4), monthlySpend: budget.monthlySpend.toFixed(4) },
        'Cost recorded'
      );
    }

    // NOTE: Assistant trigger extraction removed — it duplicated user-set reminders.
    // User message triggers are already extracted via extractFacts() (Path A).

    this.logger.info(
      { sessionId, iterations, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: activeProvider.name },
      'Message processed'
    );

    // Store response per session for context in next fact extraction (for "that's my office" type references)
    // Cap map size to prevent unbounded growth over long server uptime
    if (this.lastAssistantResponses.size >= 50) {
      const oldest = this.lastAssistantResponses.keys().next().value;
      if (oldest !== undefined) this.lastAssistantResponses.delete(oldest);
    }
    this.lastAssistantResponses.set(sessionId, finalResponse);

    // Post-response fact extraction for image messages.
    // When the user sends an image, the pre-response extraction only sees the text
    // (e.g. "is this wicker synthetic?") without the visual details. The LLM's response
    // contains the product/image details it extracted from the image. Re-run extraction
    // with the full exchange so triggers and facts capture those details.
    if (hasImageAttachments && this.factExtractor && finalResponse) {
      const imageContext = `User sent a message with an image attachment. The assistant's response (which could see the image) was:\n${finalResponse.slice(0, 2000)}`;
      this.factExtractor.queueForExtraction(
        userMessage,
        resolvedUserId,
        imageContext
      ).catch((error) => {
        this.logger.warn({ error: (error as Error).message }, 'Post-image fact extraction failed');
      });
    }

    // Emit message:sent hook
    triggerHook({
      type: 'message',
      action: 'sent',
      sessionId,
      context: { responseLength: finalResponse.length, iterations },
      timestamp: new Date(),
    }).catch(() => {});

    return {
      response: finalResponse,
      tokenUsage,
      iterationsUsed: iterations,
    };
  }

  private async buildSystemPrompt(userMessage: string, sessionId: string, userId: string = 'default'): Promise<{
    prompt: string;
    memoryStats: { factsFound: number; conversationsFound: number };
    memoryItems: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
  }> {
    let prompt = this.baseSystemPrompt;

    // Add iteration budget so the LLM knows its limits
    const iterationBudget = Math.floor(this.maxIterations / 2);
    prompt += `\n\n## ITERATION BUDGET\nYou have **${iterationBudget} iterations** to complete this task. Each tool call costs one iteration. After that, your response will be cut off. Plan accordingly — gather info quickly, then synthesize and respond with [DONE].`;

    // Resolve user timezone from config
    const session = await this.sessionManager.getSession(sessionId);
    const rawUserId = session?.metadata?.userId as string | undefined;
    let userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone; // server fallback
    if (this.configManager && rawUserId) {
      // Strip channel prefix (e.g. "telegram:12345" → "12345")
      const cleanUserId = rawUserId.includes(':') ? rawUserId.split(':')[1] : rawUserId;
      userTimezone = this.configManager.getUserTimezone(cleanUserId);
    }

    // Add date, time, and workspace context
    const now = new Date();
    const tzOptions = { timeZone: userTimezone };
    prompt += `\n\nCurrent date and time: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...tzOptions })} at ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOptions })}`;
    prompt += `\nTimezone: ${userTimezone}`;
    prompt += `\nWorkspace: ${this.workspace}`;

    // Add channel context from session metadata (reuse session fetched above)
    const channelId = session?.metadata?.channelId as string | undefined;
    const channelName = channelId === 'telegram' ? 'Telegram' : channelId === 'api' ? 'the web interface' : channelId || 'unknown';
    prompt += `\n\n## CHANNEL\nYou are chatting with the user via **${channelName}**.`;

    // Add file sending instructions
    prompt += `\n\n## FILE SENDING
For **text content** (posts, emails, summaries, replies, drafts), type it directly in the chat — NEVER write it to a .txt or .md file just to send it.
Only use write_file + send_file for **binary/generated files** (PDFs, images, archives, diagrams). Save them under the **output/** subdirectory (e.g., output/report.pdf), not the workspace root. Never just tell the user a file path — call send_file to deliver it.
- For text updates along the way, use **send_message**`;

    // Add skills prompt if registry is available
    if (this.skillRegistry) {
      const skillPrompt = this.skillRegistry.generateSkillPrompt();
      if (skillPrompt) {
        prompt += `\n\n${skillPrompt}`;
      }
    }

    // Add skill management instructions
    prompt += `\n\n## SKILL MANAGEMENT
You can search for and install new skills from ClawHub (clawhub.ai) using the manage_skills tool.
- To find skills: manage_skills with action="search", query="<what you need>"
- To install: manage_skills with action="install", slug="owner/skill-name"
- To uninstall: manage_skills with action="uninstall", slug="skill-name"
- To list installed: manage_skills with action="list"
- To set an API key: manage_skills with action="set_key", key_name="WEATHER_API_KEY", key_value="sk-..."
- To remove a key: manage_skills with action="remove_key", key_name="WEATHER_API_KEY"
After installing a skill, it becomes available immediately — no restart needed.
Keys take effect immediately and persist across restarts. After setting a key, skills that require it become available.
When a user provides an API key, always store it via set_key so it persists.
Only install skills when the user asks, or when you determine a skill would help accomplish the user's request and they confirm.`;

    // Load SOUL.md if present
    const soulPath = path.join(this.workspace, 'SOUL.md');
    try {
      const soulContent = await fs.readFile(soulPath, 'utf-8');
      prompt += `\n\n## Behavioral Guidelines (from SOUL.md)\n${soulContent}`;
    } catch {
      // SOUL.md not found, that's fine
    }

    // Build memory, goal, and board context in parallel
    const memoryPromise = this.scallopStore
      ? this.buildMemoryContext(userMessage, sessionId, userId)
      : Promise.resolve({ context: '', stats: { factsFound: 0, conversationsFound: 0 }, items: [] as { type: 'fact' | 'conversation'; content: string; subject?: string }[] });

    const goalPromise = this.goalService
      ? this.goalService.getGoalContext(userId, userMessage).catch((error: Error) => {
          this.logger.warn({ error: error.message }, 'Failed to build goal context');
          return null;
        })
      : Promise.resolve(null);

    const boardPromise = Promise.resolve(
      this.boardService
        ? (() => { try { return this.boardService!.getBoardContext(userId, userMessage, { excludeGoalLinked: !!this.goalService }); } catch (error) { this.logger.warn({ error: (error as Error).message }, 'Failed to build board context'); return null; } })()
        : null
    );

    const [memoryResult, goalContext, boardContext] = await Promise.all([
      memoryPromise,
      goalPromise,
      boardPromise,
    ]);

    const memoryStats = memoryResult.stats;
    const memoryItems = memoryResult.items;
    if (memoryResult.context) {
      prompt += memoryResult.context;
      this.logger.debug({ memoryContextLength: memoryResult.context.length, preview: memoryResult.context.substring(0, 300) }, 'Memory context added to prompt');
    }
    if (goalContext) {
      prompt += goalContext;
      this.logger.debug({ goalContextLength: goalContext.length }, 'Goal context added to prompt');
    }
    if (boardContext) {
      prompt += boardContext;
      this.logger.debug({ boardContextLength: boardContext.length }, 'Board context added to prompt');
    }

    return { prompt, memoryStats, memoryItems };
  }

  /**
   * Build memory context for system prompt using ScallopMemoryStore (SQLite)
   */
  private async buildMemoryContext(userMessage: string, _sessionId: string, userId: string = 'default'): Promise<{
    context: string;
    stats: { factsFound: number; conversationsFound: number };
    items: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
  }> {
    // Dynamic memory budget: use ~15% of remaining context space
    // Estimate current prompt size (base prompt + skills + profile ~ 4K chars typical)
    // 128K tokens ≈ 512K chars; 15% of remaining ≈ up to 16K for memory
    const estimatedPromptChars = 16000; // conservative base prompt estimate
    const totalContextChars = 512000; // ~128K tokens
    const remainingChars = totalContextChars - estimatedPromptChars;
    const MAX_MEMORY_CHARS = Math.max(2000, Math.min(16000, Math.floor(remainingChars * 0.15)));
    let context = '';
    const items: { type: 'fact' | 'conversation'; content: string; subject?: string }[] = [];

    if (!this.scallopStore) {
      return { context: '', stats: { factsFound: 0, conversationsFound: 0 }, items: [] };
    }

    try {
      // Tier 1: Ambient profiles — always injected, never searched, never decays
      const profileManager = this.scallopStore.getProfileManager();

      // Agent identity profile
      const agentProfile = profileManager.getStaticProfile('agent');
      if (Object.keys(agentProfile).length > 0) {
        let agentText = '';
        for (const [key, value] of Object.entries(agentProfile)) {
          agentText += `- ${key}: ${value}\n`;
        }
        context += `\n\n## YOUR IDENTITY\nThis is who you are. Embody this personality in all responses:\n${agentText}`;
      }

      // User profile
      const staticProfile = profileManager.getStaticProfile('default');
      if (Object.keys(staticProfile).length > 0) {
        let profileText = '';
        for (const [key, value] of Object.entries(staticProfile)) {
          profileText += `- ${key}: ${value}\n`;
        }
        context += `\n\n## USER PROFILE\nUse this automatically for all relevant queries (weather → use location, time → use timezone, etc.):\n${profileText}`;
      }

      // Behavioral patterns (all signals via formatProfileContext)
      try {
        const profileContext = profileManager.formatProfileContext(userId);
        const behavioralText = profileContext.behavioralPatterns;
        // formatProfileContext returns a string starting with '\nBehavioral Patterns:'
        // Extract the content lines (skip the header, use our own section header)
        const behavioralLines = behavioralText
          .split('\n')
          .filter(line => line.startsWith('  - ') && !line.includes('Current affect:') && !line.includes('Mood signal:'))
          .map(line => line.trim())
          .join('\n');
        if (behavioralLines) {
          context += `\n\n## USER BEHAVIORAL PATTERNS\n${behavioralLines}`;
        }

        // Dedicated affect observation block (observation only, not instruction)
        const behavioral = profileManager.getBehavioralPatterns(userId);
        if (behavioral?.smoothedAffect) {
          const sa = behavioral.smoothedAffect;
          let affectBlock = `\n\n## USER AFFECT CONTEXT`;
          affectBlock += `\nObservation about the user's current emotional state — not an instruction to change your tone.`;
          affectBlock += `\n- Emotion: ${sa.emotion}`;
          affectBlock += `\n- Valence: ${sa.valence.toFixed(2)} (negative \u2190 0 \u2192 positive)`;
          affectBlock += `\n- Arousal: ${sa.arousal.toFixed(2)} (calm \u2190 0 \u2192 activated)`;
          if (sa.goalSignal !== 'stable') {
            affectBlock += `\n- Mood trend: ${sa.goalSignal}`;
          }
          context += affectBlock;
        }
      } catch {
        // Behavioral patterns not available, that's fine
      }

      // Tier 2: Memory retrieval — three-phase approach modelling human memory:
      //  Phase 0 (short-term): Recently stored facts — always available (last 6h)
      //  Phase 1 (long-term):  High-prominence facts — core identity/knowledge
      //  Phase 2 (search):     Query-relevant facts — associative retrieval

      // Filter: only exclude memories with an explicit eventDate that has passed
      const EVENT_EXPIRY_MS = 24 * 60 * 60 * 1000;
      const isPastEvent = (mem: { eventDate: number | null }): boolean => {
        return !!(mem.eventDate && mem.eventDate < Date.now() - EVENT_EXPIRY_MS);
      };

      // Phase 0: Short-term memory buffer — things the user just told us
      const SHORT_TERM_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
      const recentFacts = this.scallopStore.getRecentMemories(userId, SHORT_TERM_WINDOW_MS);

      // Phase 1: Long-term prominent facts
      const userFacts = this.scallopStore.getByUser(userId, {
        minProminence: 0.3,
        isLatest: true,
        limit: 20,
      });

      // Phase 2: Query-relevant facts via hybrid search (now includes recency boost)
      const relevantResults = await this.scallopStore.search(userMessage, {
        userId,
        minProminence: 0.1,
        limit: 10,
      });

      // Combine: recent first (short-term), then search-relevant, then prominent
      const seenIds = new Set<string>();
      const allFactTexts: { content: string; subject?: string }[] = [];

      // Phase 0: Recent facts — highest priority (user just said these)
      for (const fact of recentFacts) {
        if (!seenIds.has(fact.id) && !isPastEvent(fact)) {
          seenIds.add(fact.id);
          const subject = fact.metadata?.subject as string | undefined;
          allFactTexts.push({ content: fact.content, subject });
        }
      }
      // Phase 2: Search-relevant facts
      for (const result of relevantResults) {
        if (!seenIds.has(result.memory.id) && !isPastEvent(result.memory)) {
          seenIds.add(result.memory.id);
          const subject = result.memory.metadata?.subject as string | undefined;
          allFactTexts.push({ content: result.memory.content, subject });
        }
      }
      // Phase 1: Long-term prominent facts (fill remaining space)
      for (const fact of userFacts) {
        if (!seenIds.has(fact.id) && !isPastEvent(fact)) {
          seenIds.add(fact.id);
          const subject = fact.metadata?.subject as string | undefined;
          allFactTexts.push({ content: fact.content, subject });
        }
      }

      if (allFactTexts.length > 0) {
        let memoriesText = '';
        let charCount = 0;

        for (const fact of allFactTexts) {
          const subjectPrefix = fact.subject && fact.subject !== 'user' ? `[About ${fact.subject}] ` : '';
          const memoryLine = `- ${subjectPrefix}${fact.content}\n`;
          if (charCount + memoryLine.length > MAX_MEMORY_CHARS) break;
          memoriesText += memoryLine;
          charCount += memoryLine.length;

          items.push({
            type: 'fact',
            content: fact.content,
            subject: fact.subject !== 'user' ? fact.subject : undefined,
          });
        }

        if (memoriesText) {
          context += `\n\n## MEMORIES FROM THE PAST\nThese are facts you've learned about the user and people they've mentioned:\n${memoriesText}`;
        }
      }

      // Tier 3: Session summaries for past-conversation references
      let conversationsFound = 0;
      const sessionPatterns = /\b(what did we (discuss|talk about)|last time|yesterday|previous (session|conversation)|before|earlier)\b/i;
      if (sessionPatterns.test(userMessage)) {
        try {
          const sessionResults = await this.scallopStore!.searchSessions(userMessage, {
            userId,
            limit: 3,
          });
          if (sessionResults.length > 0) {
            let sessionText = '';
            for (const result of sessionResults) {
              const date = new Date(result.summary.createdAt).toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
              });
              const topics = result.summary.topics.length > 0 ? ` [${result.summary.topics.join(', ')}]` : '';
              const line = `- ${date}${topics}: ${result.summary.summary}\n`;
              if (sessionText.length + line.length > 2000) break;
              sessionText += line;
              conversationsFound++;
              items.push({
                type: 'conversation',
                content: result.summary.summary,
              });
            }
            if (sessionText) {
              context += `\n\n## PAST CONVERSATIONS\n${sessionText}`;
            }
          }
        } catch (err) {
          this.logger.debug({ error: (err as Error).message }, 'Session summary search failed');
        }
      }

      return {
        context,
        stats: { factsFound: items.filter((i) => i.type === 'fact').length, conversationsFound },
        items,
      };
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, 'Failed to build memory context');
      return { context: '', stats: { factsFound: 0, conversationsFound: 0 }, items: [] };
    }
  }

  private extractThinkingContent(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: 'thinking'; thinking: string } => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('\n');
  }

  private extractTextContent(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private extractToolUses(content: ContentBlock[]): ToolUseContent[] {
    // First try to get proper tool_use blocks
    const toolUses = content.filter((block): block is ToolUseContent => block.type === 'tool_use');
    if (toolUses.length > 0) {
      return toolUses;
    }

    // Fallback: Some models (like moonshot-v1-128k) output tool calls as JSON in text
    // Try to parse tool calls from text content
    const textBlocks = content.filter((block): block is { type: 'text'; text: string } => block.type === 'text');
    for (const block of textBlocks) {
      const parsed = this.parseToolCallFromText(block.text);
      if (parsed) {
        return [parsed];
      }
    }

    return [];
  }

  /**
   * Try to parse a tool call from text content (fallback for models that don't use proper tool_calls)
   */
  private parseToolCallFromText(text: string): ToolUseContent | null {
    // Find JSON objects in text using brace counting (handles nested objects)
    const jsonObjects = this.extractJsonObjects(text);

    for (const jsonStr of jsonObjects) {
      try {
        const obj = JSON.parse(jsonStr);
        if (typeof obj !== 'object' || obj === null) continue;

        // Match { function: "...", arguments: {...} }
        if (typeof obj.function === 'string' && typeof obj.arguments === 'object') {
          return {
            type: 'tool_use',
            id: `fallback-${Date.now()}`,
            name: obj.function,
            input: obj.arguments,
          };
        }

        // Match { name: "...", input: {...} }
        if (typeof obj.name === 'string' && typeof obj.input === 'object') {
          return {
            type: 'tool_use',
            id: `fallback-${Date.now()}`,
            name: obj.name,
            input: obj.input,
          };
        }
      } catch {
        // Invalid JSON, try next
      }
    }

    return null;
  }

  /**
   * Extract JSON objects from text using brace counting to handle nested objects
   */
  private extractJsonObjects(text: string): string[] {
    const results: string[] = [];
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return results;
  }

  /**
   * Check if task is explicitly marked as complete via [DONE] marker
   * The LLM can signal task completion by ending its response with [DONE]
   */
  private isTaskComplete(textContent: string): boolean {
    if (!textContent) return false;
    // Check for [DONE] at the end of the response (case insensitive, allow trailing whitespace)
    return /\[done\]\s*$/i.test(textContent.trim());
  }

  /**
   * Strip the [DONE] marker from the response text
   */
  private stripDoneMarker(text: string): string {
    return text.replace(/\[done\]\s*$/i, '').trim();
  }

  /**
   * Clean progress message by removing JSON tool call patterns
   * Some models output tool calls as JSON text instead of proper tool_calls
   */
  private cleanProgressMessage(text: string): string {
    // Remove JSON blocks that look like tool calls
    const cleaned = text
      // Remove JSON objects with function/arguments keys
      .replace(/\{[\s\S]*?"function"[\s\S]*?"arguments"[\s\S]*?\}/g, '')
      // Remove JSON objects with name/input keys
      .replace(/\{[\s\S]*?"name"[\s\S]*?"input"[\s\S]*?\}/g, '')
      // Remove standalone JSON objects
      .replace(/```json[\s\S]*?```/g, '')
      .replace(/```[\s\S]*?\{[\s\S]*?\}[\s\S]*?```/g, '')
      // Clean up extra whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  /**
   * Check if an error is a rate limit or transient server error worth retrying.
   */
  private isRateLimitError(error: Error & { status?: number; code?: string }): boolean {
    if (error.status === 429 || error.status === 529) return true;
    const msg = error.message.toLowerCase();
    return msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('overloaded');
  }

  /**
   * Extract retry delay from error headers or use exponential backoff.
   */
  private getRetryDelay(error: Error & { headers?: Record<string, string> }, attempt: number): number {
    // Check for Retry-After header
    const headers = (error as { headers?: Record<string, string> }).headers;
    if (headers) {
      const retryAfterMs = headers['retry-after-ms'];
      if (retryAfterMs) return Math.min(parseInt(retryAfterMs, 10), 30000);

      const retryAfter = headers['retry-after'];
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (!isNaN(secs)) return Math.min(secs * 1000, 30000);
      }
    }

    // Exponential backoff: 2s * 2^attempt with 20% jitter, capped at 30s
    const base = 2000 * Math.pow(2, attempt);
    const jitter = base * 0.2 * Math.random();
    return Math.min(base + jitter, 30000);
  }

  /**
   * Execute LLM call with error recovery:
   * 1. Rate limit retry with exponential backoff
   * 2. Graduated context compaction on overflow (prune → emergency compress)
   * 3. Provider fallback via router
   */
  private async executeWithRecovery(
    provider: LLMProvider,
    request: CompletionRequest,
    sessionId: string,
    tier: 'fast' | 'standard' | 'capable'
  ): Promise<CompletionResponse> {
    const MAX_RETRIES = 3;

    // Layer 0: Rate limit retry with exponential backoff
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await provider.complete(request);
      } catch (error) {
        const err = error as Error & { status?: number; headers?: Record<string, string> };

        // Rate limit — retry with backoff
        if (this.isRateLimitError(err) && attempt < MAX_RETRIES) {
          const delay = this.getRetryDelay(err, attempt);
          this.logger.warn(
            { attempt: attempt + 1, maxRetries: MAX_RETRIES, delayMs: delay, provider: provider.name },
            'Rate limited, retrying with backoff'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Not a rate limit — fall through to other recovery strategies
        // Layer 1: Graduated context compaction on overflow
        if (this.isContextOverflowError(err)) {
          this.logger.warn({ error: err.message }, 'Context overflow detected, attempting graduated compaction');

          if (this.contextManager && request.messages.length > 6) {
            // Layer 1a: Prune old tool outputs (keep last 6 messages intact)
            const prunedMessages = this.pruneToolOutputs(request.messages, 6);
            const prunedRequest = { ...request, messages: prunedMessages };
            this.logger.info(
              { originalMessages: request.messages.length, afterPrune: prunedMessages.length },
              'Graduated compaction: pruned old tool outputs'
            );

            try {
              return await provider.complete(prunedRequest);
            } catch (pruneError) {
              this.logger.warn({ error: (pruneError as Error).message }, 'Pruned request still overflowed, trying emergency compression');
            }

            // Layer 1b: Progressive compaction — summarize older messages, keep recent 6
            try {
              const compactionResult = await progressiveCompact(
                request.messages,
                provider,
                this.contextManager?.getMaxContextTokens() || 128000,
                { preserveLastN: 6 }
              );
              if (compactionResult.summary) {
                this.logger.info(
                  { originalMessages: request.messages.length, compactedMessages: compactionResult.compactedMessages.length },
                  'Progressive compaction applied'
                );
                // Emit compaction hook
                triggerHook({
                  type: 'agent',
                  action: 'compaction',
                  sessionId,
                  context: { messagesBefore: request.messages.length, messagesAfter: compactionResult.compactedMessages.length },
                  timestamp: new Date(),
                }).catch(() => {});
                try {
                  return await provider.complete({ ...request, messages: compactionResult.compactedMessages });
                } catch (compactError) {
                  this.logger.warn({ error: (compactError as Error).message }, 'Progressive compaction still overflowed');
                }
              }
            } catch (compactErr) {
              this.logger.warn({ error: (compactErr as Error).message }, 'Progressive compaction failed, trying emergency compress');
            }

            // Layer 1c: Emergency compress — keep only last 3 messages
            const compressed = request.messages.slice(-3);
            const compressedRequest = { ...request, messages: compressed };
            this.logger.info({ compressedMessages: 3 }, 'Emergency compression applied');

            try {
              return await provider.complete(compressedRequest);
            } catch (retryError) {
              this.logger.error({ error: (retryError as Error).message }, 'Retry after emergency compression failed');
            }
          }
        }

        // Layer 2: Try fallback providers via router
        if (this.router) {
          this.logger.warn({ provider: provider.name, error: err.message }, 'Provider failed, trying fallback');

          try {
            const result = await this.router.executeWithFallback(request, tier);
            this.logger.info({ fallbackProvider: result.provider, attempted: result.attemptedProviders }, 'Fallback succeeded');
            return result.response;
          } catch (fallbackError) {
            this.logger.error({ error: (fallbackError as Error).message }, 'All fallback providers failed');
            throw fallbackError;
          }
        }

        // No recovery possible
        throw error;
      }
    }

    // Should not reach here, but TypeScript needs this
    throw new Error('Exhausted retry attempts');
  }

  /**
   * Prune old tool outputs from messages to reduce context size.
   * Keeps the last `keepLast` messages intact, replaces tool_result content
   * in older messages with a short placeholder.
   */
  private pruneToolOutputs(messages: import('../providers/types.js').Message[], keepLast: number = 6): import('../providers/types.js').Message[] {
    if (messages.length <= keepLast) return messages;

    const pruneUpTo = messages.length - keepLast;
    return messages.map((msg, idx) => {
      if (idx >= pruneUpTo) return msg; // Keep recent messages intact
      if (typeof msg.content === 'string') return msg;

      const prunedContent = (msg.content as ContentBlock[]).map(block => {
        if (block.type === 'tool_result') {
          const content = (block as { content: string }).content;
          if (content.length > 200) {
            return {
              ...block,
              content: `[pruned: ${content.length} chars]`,
            };
          }
        }
        return block;
      });

      return { ...msg, content: prunedContent as ContentBlock[] };
    });
  }

  /**
   * Check if error is a context overflow error
   */
  private isContextOverflowError(error: Error & { status?: number }): boolean {
    const message = error.message.toLowerCase();

    // Match specific context/token overflow phrases, not generic words
    const contextOverflowPatterns = [
      'context length',
      'context window',
      'token limit',
      'too many tokens',
      'maximum context',
      'input too long',
      'request too large',
      'content too large',
      'prompt is too long',
      'exceeds.*context',
      'exceeds.*token',
    ];

    return contextOverflowPatterns.some(pattern =>
      pattern.includes('.*') ? new RegExp(pattern).test(message) : message.includes(pattern)
    );
  }

  /** Read-only tools that can safely run in parallel */
  private static readonly PARALLEL_SAFE_TOOLS = new Set([
    'read_file', 'ls', 'glob', 'grep', 'codesearch', 'web_search',
    'memory_search', 'question', 'webfetch', 'goals',
  ]);

  /**
   * Execute a single tool call and return its result.
   */
  private async executeSingleTool(
    toolUse: ToolUseContent,
    sessionId: string,
    userId?: string,
    onProgress?: ProgressCallback
  ): Promise<ContentBlock> {
    // Emit tool:before_call hook
    triggerHook({
      type: 'tool',
      action: 'before_call',
      sessionId,
      context: { toolName: toolUse.name, input: toolUse.input },
      timestamp: new Date(),
    }).catch(() => {});

    // Resolve skill — with auto-repair for hallucinated names
    let skill = this.skillRegistry?.getSkill(toolUse.name) || null;

    // Tool call repair: try case-insensitive match
    if (!skill && this.skillRegistry) {
      const allNames = this.skillRegistry.getToolDefinitions().map(t => t.name);
      const lowerName = toolUse.name.toLowerCase();
      const match = allNames.find(n => n.toLowerCase() === lowerName);
      if (match) {
        this.logger.info({ requested: toolUse.name, resolved: match }, 'Tool name auto-repaired');
        skill = this.skillRegistry.getSkill(match) || null;
      }
    }

    // Documentation-only skills cannot be invoked as tools
    if (skill && !skill.hasScripts) {
      this.logger.warn({ skillName: toolUse.name }, 'LLM tried to invoke documentation-only skill as tool');
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: "${toolUse.name}" is a documentation-only skill and cannot be invoked as a tool. Use the bash skill to run CLI commands instead. Refer to the skill guide in your instructions for available commands.`,
        is_error: true,
      };
    }

    if (skill && (skill.handler || this.skillExecutor)) {
      this.logger.debug({ skillName: toolUse.name, input: toolUse.input, native: !!skill.handler }, 'Executing skill');

      if (onProgress) {
        await onProgress({
          type: 'tool_start',
          message: JSON.stringify(toolUse.input),
          toolName: toolUse.name,
        });
      }

      try {
        let resultContent: string;
        let resultSuccess: boolean;

        if (skill.handler) {
          const result = await skill.handler({
            args: toolUse.input as Record<string, unknown>,
            workspace: this.workspace,
            sessionId,
            userId,
          });
          resultSuccess = result.success;
          resultContent = result.success
            ? (result.output || 'Success')
            : `Error: ${result.error || result.output}`;
        } else {
          const result = await this.skillExecutor!.execute(skill, {
            skillName: toolUse.name,
            args: toolUse.input,
            cwd: this.workspace,
            userId,
            sessionId,
          });
          let skillOutput = result.output || '';
          let skillError = result.error || '';
          try {
            const parsed = JSON.parse(skillOutput);
            if (parsed && typeof parsed === 'object') {
              skillOutput = parsed.output || parsed.error || skillOutput;
              if (parsed.error) skillError = parsed.error;
            }
          } catch {
            // Not JSON, use raw output
          }
          resultSuccess = result.success;
          resultContent = result.success
            ? (skillOutput || 'Success')
            : `Error: ${skillError || skillOutput || 'Command failed with no error output'}`;
        }

        if (onProgress) {
          await onProgress({
            type: 'tool_complete',
            message: resultContent.slice(0, 2000),
            toolName: toolUse.name,
          });
        }

        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: resultContent,
          is_error: !resultSuccess,
        };

      } catch (error) {
        const err = error as Error;
        this.logger.error({ skillName: toolUse.name, error: err.message }, 'Skill execution failed');

        if (onProgress) {
          await onProgress({
            type: 'tool_error',
            message: err.message,
            toolName: toolUse.name,
          });
        }

        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error executing skill: ${err.message}`,
          is_error: true,
        };
      }
    }

    // Skill not found — provide helpful error with available tool names
    this.logger.warn({ name: toolUse.name }, 'Unknown skill requested');
    const availableTools = this.skillRegistry
      ? this.skillRegistry.getToolDefinitions().map(t => t.name).join(', ')
      : '(none)';

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: Unknown tool "${toolUse.name}". Available tools: ${availableTools}`,
      is_error: true,
    };
  }

  private async executeTools(
    toolUses: ToolUseContent[],
    sessionId: string,
    userId?: string,
    onProgress?: ProgressCallback,
    shouldStop?: ShouldStopCallback
  ): Promise<ContentBlock[]> {
    // Check for early stop
    if (shouldStop && shouldStop()) {
      return toolUses.map(t => ({
        type: 'tool_result' as const,
        tool_use_id: t.id,
        content: 'Execution stopped by user request.',
        is_error: true,
      }));
    }

    // Partition tools: read-only can run in parallel, others run sequentially
    const parallelBatch: ToolUseContent[] = [];
    const sequentialQueue: ToolUseContent[] = [];

    // Only parallelize when there are multiple tools and all read-only ones are together
    for (const toolUse of toolUses) {
      if (Agent.PARALLEL_SAFE_TOOLS.has(toolUse.name)) {
        parallelBatch.push(toolUse);
      } else {
        sequentialQueue.push(toolUse);
      }
    }

    const results: ContentBlock[] = [];

    // Execute parallel batch first (if any)
    if (parallelBatch.length > 1) {
      this.logger.info({ count: parallelBatch.length, tools: parallelBatch.map(t => t.name) }, 'Executing tools in parallel');
      const parallelResults = await Promise.all(
        parallelBatch.map(toolUse => this.executeSingleTool(toolUse, sessionId, userId, onProgress))
      );
      results.push(...parallelResults);
    } else if (parallelBatch.length === 1) {
      // Single tool — no need for Promise.all overhead
      results.push(await this.executeSingleTool(parallelBatch[0], sessionId, userId, onProgress));
    }

    // Execute sequential tools one by one
    for (const toolUse of sequentialQueue) {
      if (shouldStop && shouldStop()) {
        // Fill remaining with stop messages
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Execution stopped by user request.',
          is_error: true,
        });
        continue;
      }

      results.push(await this.executeSingleTool(toolUse, sessionId, userId, onProgress));
    }

    return results;
  }
}
