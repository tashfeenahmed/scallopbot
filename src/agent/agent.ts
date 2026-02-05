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
import type { HotCollector } from '../memory/memory.js';
import type { LLMFactExtractor } from '../memory/fact-extractor.js';
import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { ContextManager } from '../routing/context.js';
import type { MediaProcessor } from '../media/index.js';
import type { Attachment } from '../channels/types.js';
import { analyzeComplexity } from '../routing/complexity.js';

export interface AgentOptions {
  provider: LLMProvider;
  sessionManager: SessionManager;
  skillRegistry?: SkillRegistry;
  skillExecutor?: SkillExecutor;
  router?: Router;
  costTracker?: CostTracker;
  hotCollector?: HotCollector;
  scallopStore?: ScallopMemoryStore;
  factExtractor?: LLMFactExtractor;
  contextManager?: ContextManager;
  mediaProcessor?: MediaProcessor;
  workspace: string;
  logger: Logger;
  maxIterations: number;
  systemPrompt?: string;
  /** Enable extended thinking for supported providers (e.g., Kimi K2.5) */
  enableThinking?: boolean;
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
  type: 'thinking' | 'tool_start' | 'tool_complete' | 'tool_error' | 'memory' | 'status';
  message: string;
  toolName?: string;
  iteration?: number;
  /** For memory events */
  count?: number;
  action?: string;
  items?: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
}

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI assistant with direct system access via skills. Get things done - don't describe, DO.

## SKILLS
Your capabilities come from skills listed at the end of this prompt. Use them immediately to accomplish tasks.

## HOW TO WORK
1. Act immediately - don't ask permission, use skills
2. Install what you need - missing deps? Install them (npm/pip/brew)
3. Try alternatives - curl vs wget, npx vs global, browser vs fetch
4. Fix blockers yourself - missing node_modules? npm install first
5. Ask only when truly stuck - after trying 2-3 approaches, explain what failed
6. Use [DONE] when task is complete

## MEMORY
- Conversations auto-remembered. Don't create files to store info.
- USER PROFILE (location, name, timezone) is always available — use it to personalize ALL actions (weather → user's location, time → user's timezone)
- Facts shown in "MEMORIES FROM THE PAST" section.
- Personal refs ("my flatmate", "my project") → memory_search FIRST
- New info (news, weather) → use profile context + web_search

## TASK COMPLETION
Loop until done. After each action: "Is this complete?"
- YES → end with [DONE]
- NO → continue working

Never [DONE] mid-response. Only at the very end.

## COMMUNICATION
Text like messaging a friend. Short, punchy.
- 1-3 sentences max
- Progress updates before each skill: "Checking..." "On it..."
- Results: answer first, details after
- Errors: "Hmm, that didn't work. Trying..."
- Multi-step: use send_message for updates along the way

Formatting: No markdown headings. Use **bold**, bullet lists (not tables for Telegram).

## REMINDERS
Use reminder skill with time formats:
- Intervals: "5 minutes", "1 hour"
- Absolute: "at 10am", "tomorrow at 9am"
- Recurring: "every day at 10am", "every Monday at 3pm"
Actions in reminders execute automatically when triggered.

## EXAMPLES

**Proactive (good) vs passive (bad):**
BAD: "I can't run prettier - it's not installed."
GOOD: *npm install -D prettier* "Installed. Formatting now..."

BAD: "wget failed."
GOOD: "wget failed, trying curl..." *curl -O* "Downloaded."

**Conversational:**
BAD: "Based on meteorological data, precipitation probability is 80%."
GOOD: "Yeah it's gonna rain - 80% chance. Bring an umbrella!"

BAD: "I have successfully completed the file creation process."
GOOD: "Done! File's saved." [DONE]

You're on the user's server. Be autonomous, persistent, helpful.`;

export class Agent {
  private provider: LLMProvider;
  private sessionManager: SessionManager;
  private skillRegistry: SkillRegistry | null;
  private skillExecutor: SkillExecutor | null;
  private router: Router | null;
  private costTracker: CostTracker | null;
  private hotCollector: HotCollector | null;
  private scallopStore: ScallopMemoryStore | null;
  private factExtractor: LLMFactExtractor | null;
  private contextManager: ContextManager | null;
  private mediaProcessor: MediaProcessor | null;
  private workspace: string;
  private logger: Logger;
  private maxIterations: number;
  private baseSystemPrompt: string;
  /** Stores recent assistant response for contextual fact extraction */
  private lastAssistantResponse: string = '';
  /** Enable extended thinking for supported providers */
  private enableThinking: boolean;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.sessionManager = options.sessionManager;
    this.skillRegistry = options.skillRegistry || null;
    this.skillExecutor = options.skillExecutor || null;
    this.router = options.router || null;
    this.costTracker = options.costTracker || null;
    this.hotCollector = options.hotCollector || null;
    this.scallopStore = options.scallopStore || null;
    this.factExtractor = options.factExtractor || null;
    this.contextManager = options.contextManager || null;
    this.mediaProcessor = options.mediaProcessor || null;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.maxIterations = options.maxIterations;
    this.baseSystemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.enableThinking = options.enableThinking ?? false;

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
    shouldStop?: ShouldStopCallback
  ): Promise<AgentResult> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

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
    if (this.mediaProcessor) {
      try {
        const { content, processedMedia, errors } = await this.mediaProcessor.processMessage(
          userMessage,
          attachments || []
        );

        // If we processed any media, use content blocks
        if (processedMedia.length > 0) {
          processedContent = content;
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

    // Select provider based on complexity (use router if available, else default)
    let activeProvider: LLMProvider = this.provider;
    if (this.router) {
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

    // Collect user message in memory
    if (this.hotCollector) {
      this.hotCollector.collect({
        content: userMessage,
        sessionId,
        source: 'user',
        tags: ['conversation', 'user-message'],
      });
    }

    // Queue LLM-based fact extraction (async, non-blocking)
    // Pass the last assistant response as context for references like "that's my office"
    if (this.factExtractor) {
      const userId = 'default'; // Single-user agent: all memories under canonical userId
      this.factExtractor.queueForExtraction(
        userMessage,
        userId,
        this.lastAssistantResponse || undefined
      ).catch((error) => {
        this.logger.warn({ error: (error as Error).message }, 'Async fact extraction failed');
      });
    }

    // Build system prompt with memory context
    const { prompt: systemPrompt, memoryStats, memoryItems } = await this.buildSystemPrompt(userMessage, sessionId);

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

    // Get tool definitions from skills (all tools are now skills)
    const tools = this.skillRegistry
      ? this.skillRegistry.getToolDefinitions()
      : [];

    // Track usage across iterations
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    let finalResponse = '';
    let lastModel = '';

    // Agent loop
    while (iterations < this.maxIterations) {
      iterations++;

      // Check if user requested stop
      if (shouldStop && shouldStop()) {
        this.logger.info({ sessionId, iteration: iterations }, 'User requested stop');
        finalResponse = 'Stopped by user request.';
        break;
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
      const messages = this.contextManager
        ? this.contextManager.buildContextMessages(rawMessages)
        : rawMessages;

      // Build completion request
      const request: CompletionRequest = {
        messages,
        system: systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens: 4096,
        enableThinking: this.enableThinking,
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
      lastModel = response.model;

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
        // Strip [DONE] marker from response if present
        finalResponse = taskComplete
          ? this.stripDoneMarker(textContent) || 'I completed the task.'
          : textContent || 'I completed the task.';

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
              type: 'thinking',
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

      // Check if user requested stop after tool execution (don't wait for next iteration's LLM call)
      if (shouldStop && shouldStop()) {
        this.logger.info({ sessionId, iteration: iterations }, 'User requested stop after tool execution');
        finalResponse = 'Stopped by user request.';
        break;
      }

      // If this is the last iteration, add a warning
      if (iterations >= this.maxIterations) {
        finalResponse = `I've reached the maximum iterations (${this.maxIterations}). Here's what I've done so far: ${textContent || 'Multiple tool operations completed.'}`;
      }
    }

    // Record token usage
    const tokenUsage = { inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    await this.sessionManager.recordTokenUsage(sessionId, tokenUsage);

    // Record usage in cost tracker
    if (this.costTracker && lastModel) {
      this.costTracker.recordUsage({
        model: lastModel,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        provider: activeProvider.name,
        sessionId,
      });
      const budget = this.costTracker.getBudgetStatus();
      this.logger.debug(
        { dailySpend: budget.dailySpend.toFixed(4), monthlySpend: budget.monthlySpend.toFixed(4) },
        'Cost recorded'
      );
    }

    // Collect assistant response in memory
    if (this.hotCollector && finalResponse) {
      this.hotCollector.collect({
        content: finalResponse,
        sessionId,
        source: 'assistant',
        tags: ['conversation', 'assistant-response'],
      });
    }

    // Flush memories to persistent storage
    if (this.hotCollector) {
      this.hotCollector.flush(sessionId);
      this.logger.debug({ sessionId }, 'Memories flushed to store');
    }

    this.logger.info(
      { sessionId, iterations, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: activeProvider.name },
      'Message processed'
    );

    // Store response for context in next fact extraction (for "that's my office" type references)
    this.lastAssistantResponse = finalResponse;

    return {
      response: finalResponse,
      tokenUsage,
      iterationsUsed: iterations,
    };
  }

  private async buildSystemPrompt(userMessage: string, sessionId: string): Promise<{
    prompt: string;
    memoryStats: { factsFound: number; conversationsFound: number };
    memoryItems: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
  }> {
    let prompt = this.baseSystemPrompt;

    // Add date and workspace context
    prompt += `\n\nToday's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
    prompt += `\nWorkspace: ${this.workspace}`;

    // Add channel context from session metadata
    const session = await this.sessionManager.getSession(sessionId);
    const channelId = session?.metadata?.channelId as string | undefined;
    const channelName = channelId === 'telegram' ? 'Telegram' : channelId === 'api' ? 'the web interface' : channelId || 'unknown';
    prompt += `\n\n## CHANNEL\nYou are chatting with the user via **${channelName}**.`;

    // Add file sending instructions
    prompt += `\n\n## FILE SENDING
ALWAYS use **send_file** after creating any file (PDFs, images, documents, scripts, plans, etc.). Never just tell the user the file path — they can't access your filesystem. You MUST call send_file to deliver it.
- Works on Telegram (sends as document attachment) and web (sends as download link)
- Do NOT paste file contents into chat — use send_file to deliver the actual file
- For text updates along the way, use **send_message**`;

    // Add skills prompt if registry is available
    if (this.skillRegistry) {
      const skillPrompt = this.skillRegistry.generateSkillPrompt();
      if (skillPrompt) {
        prompt += `\n\n${skillPrompt}`;
      }
    }

    // Load SOUL.md if present
    const soulPath = path.join(this.workspace, 'SOUL.md');
    try {
      const soulContent = await fs.readFile(soulPath, 'utf-8');
      prompt += `\n\n## Behavioral Guidelines (from SOUL.md)\n${soulContent}`;
    } catch {
      // SOUL.md not found, that's fine
    }

    // Add memory context from ScallopMemoryStore (SQLite)
    let memoryStats = { factsFound: 0, conversationsFound: 0 };
    let memoryItems: { type: 'fact' | 'conversation'; content: string; subject?: string }[] = [];
    if (this.scallopStore) {
      const { context: memoryContext, stats, items } = await this.buildMemoryContext(userMessage, sessionId);
      memoryStats = stats;
      memoryItems = items;
      if (memoryContext) {
        prompt += memoryContext;
        this.logger.debug({ memoryContextLength: memoryContext.length, preview: memoryContext.substring(0, 300) }, 'Memory context added to prompt');
      }
    }

    return { prompt, memoryStats, memoryItems };
  }

  /**
   * Build memory context for system prompt using ScallopMemoryStore (SQLite)
   */
  private async buildMemoryContext(userMessage: string, _sessionId: string): Promise<{
    context: string;
    stats: { factsFound: number; conversationsFound: number };
    items: { type: 'fact' | 'conversation'; content: string; subject?: string }[];
  }> {
    const MAX_MEMORY_CHARS = 2000;
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

      // Tier 2: Query-relevant facts via search
      // Phase 1: Get key user facts (high prominence, no query needed)
      const userFacts = this.scallopStore.getByUser('default', {
        minProminence: 0.3,
        isLatest: true,
        limit: 20,
      });

      // Phase 2: Get query-relevant facts via hybrid search
      const relevantResults = await this.scallopStore.search(userMessage, {
        userId: 'default',
        minProminence: 0.1,
        limit: 10,
      });

      // Combine, deduplicating by ID
      const seenIds = new Set<string>();
      const allFactTexts: { content: string; subject?: string }[] = [];

      for (const fact of userFacts) {
        if (!seenIds.has(fact.id)) {
          seenIds.add(fact.id);
          const subject = fact.metadata?.subject as string | undefined;
          allFactTexts.push({ content: fact.content, subject });
        }
      }
      for (const result of relevantResults) {
        if (!seenIds.has(result.memory.id)) {
          seenIds.add(result.memory.id);
          const subject = result.memory.metadata?.subject as string | undefined;
          allFactTexts.push({ content: result.memory.content, subject });
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

      return {
        context,
        stats: { factsFound: items.filter((i) => i.type === 'fact').length, conversationsFound: 0 },
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
    try {
      // Look for JSON with function/arguments pattern
      const functionMatch = text.match(/\{\s*"function"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]+\})\s*\}/);
      if (functionMatch) {
        const name = functionMatch[1];
        const input = JSON.parse(functionMatch[2]);
        return {
          type: 'tool_use',
          id: `fallback-${Date.now()}`,
          name,
          input,
        };
      }

      // Look for JSON with name/input pattern
      const nameMatch = text.match(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"input"\s*:\s*(\{[^}]+\})\s*\}/);
      if (nameMatch) {
        const name = nameMatch[1];
        const input = JSON.parse(nameMatch[2]);
        return {
          type: 'tool_use',
          id: `fallback-${Date.now()}`,
          name,
          input,
        };
      }
    } catch {
      // Parsing failed, return null
    }
    return null;
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
   * Execute LLM call with error recovery
   * - On context overflow: emergency compress and retry
   * - On provider error: try fallback providers via router
   */
  private async executeWithRecovery(
    provider: LLMProvider,
    request: CompletionRequest,
    sessionId: string,
    tier: 'fast' | 'standard' | 'capable'
  ): Promise<CompletionResponse> {
    try {
      return await provider.complete(request);
    } catch (error) {
      const err = error as Error & { status?: number };

      // Check for context overflow errors (400, 413, or message contains "context" or "token")
      if (this.isContextOverflowError(err)) {
        this.logger.warn({ error: err.message }, 'Context overflow detected, attempting emergency compression');

        // Emergency compress: keep only last 3 messages
        if (this.contextManager && request.messages.length > 3) {
          const compressed = request.messages.slice(-3);
          const compressedRequest = { ...request, messages: compressed };

          this.logger.info({ originalMessages: request.messages.length, compressedMessages: 3 }, 'Emergency compression applied');

          try {
            return await provider.complete(compressedRequest);
          } catch (retryError) {
            this.logger.error({ error: (retryError as Error).message }, 'Retry after compression failed');
          }
        }
      }

      // Try fallback providers via router
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

  /**
   * Check if error is a context overflow error
   */
  private isContextOverflowError(error: Error & { status?: number }): boolean {
    const status = error.status;
    if (status === 400 || status === 413) return true;

    const message = error.message.toLowerCase();
    return message.includes('context') ||
           message.includes('token') ||
           message.includes('too long') ||
           message.includes('maximum') ||
           message.includes('limit');
  }

  private async executeTools(
    toolUses: ToolUseContent[],
    sessionId: string,
    userId?: string,
    onProgress?: ProgressCallback,
    shouldStop?: ShouldStopCallback
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const toolUse of toolUses) {
      // Check if user requested stop between tool calls
      if (shouldStop && shouldStop()) {
        this.logger.info({ remainingTools: toolUses.length - results.length }, 'User requested stop during tool execution');
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Execution stopped by user request.',
          is_error: true,
        });
        // Skip remaining tool calls
        for (const remaining of toolUses.slice(results.length)) {
          if (remaining.id !== toolUse.id) {
            results.push({
              type: 'tool_result',
              tool_use_id: remaining.id,
              content: 'Execution stopped by user request.',
              is_error: true,
            });
          }
        }
        break;
      }
      // Try skill first (skills are now the primary execution path)
      const skill = this.skillRegistry?.getSkill(toolUse.name);

      // Documentation-only skills cannot be invoked as tools
      if (skill && !skill.hasScripts) {
        this.logger.warn({ skillName: toolUse.name }, 'LLM tried to invoke documentation-only skill as tool');
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: "${toolUse.name}" is a documentation-only skill and cannot be invoked as a tool. Use the bash skill to run CLI commands instead. Refer to the skill guide in your instructions for available commands.`,
          is_error: true,
        });
        continue;
      }

      if (skill && (skill.handler || this.skillExecutor)) {
        this.logger.debug({ skillName: toolUse.name, input: toolUse.input, native: !!skill.handler }, 'Executing skill');

        // Send progress: skill starting
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
          let resultOutput: string;

          if (skill.handler) {
            // Native in-process handler (for skills that need runtime access)
            const result = await skill.handler({
              args: toolUse.input as Record<string, unknown>,
              workspace: this.workspace,
              sessionId,
              userId,
            });
            resultSuccess = result.success;
            resultOutput = result.output || '';
            resultContent = result.success
              ? (result.output || 'Success')
              : `Error: ${result.error || result.output}`;
          } else {
            // Subprocess execution via skill executor
            const result = await this.skillExecutor!.execute(skill, {
              skillName: toolUse.name,
              args: toolUse.input,
              cwd: this.workspace,
              userId,
              sessionId,
            });
            resultSuccess = result.success;
            resultOutput = result.output || '';
            resultContent = result.success
              ? (result.output || 'Success')
              : `Error: ${result.error}`;
          }

          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
            is_error: !resultSuccess,
          });

          // Send progress: skill complete
          if (onProgress) {
            await onProgress({
              type: 'tool_complete',
              message: resultContent.slice(0, 2000),
              toolName: toolUse.name,
            });
          }

          // Collect in memory
          if (this.hotCollector && resultSuccess) {
            this.hotCollector.collect({
              content: `Skill ${toolUse.name} executed: ${resultOutput.slice(0, 500)}`,
              sessionId,
              source: `skill:${toolUse.name}`,
              tags: ['skill-execution', toolUse.name],
              metadata: { skillInput: toolUse.input },
            });
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error({ skillName: toolUse.name, error: err.message }, 'Skill execution failed');

          // Send progress: skill error
          if (onProgress) {
            await onProgress({
              type: 'tool_error',
              message: err.message,
              toolName: toolUse.name,
            });
          }

          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error executing skill: ${err.message}`,
            is_error: true,
          });
        }
        continue;
      }

      // Skill not found
      this.logger.warn({ name: toolUse.name }, 'Unknown skill requested');
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: Unknown skill "${toolUse.name}"`,
        is_error: true,
      });
    }

    return results;
  }
}
