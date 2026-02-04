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
import type { ToolRegistry, ToolContext } from '../tools/types.js';
import type { SessionManager } from './session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { Router } from '../routing/router.js';
import type { CostTracker } from '../routing/cost.js';
import type { HotCollector, HybridSearch } from '../memory/memory.js';
import type { LLMFactExtractor } from '../memory/fact-extractor.js';
import type { ContextManager } from '../routing/context.js';
import type { MediaProcessor } from '../media/index.js';
import type { Attachment } from '../channels/types.js';
import { analyzeComplexity } from '../routing/complexity.js';

export interface AgentOptions {
  provider: LLMProvider;
  sessionManager: SessionManager;
  toolRegistry?: ToolRegistry;
  skillRegistry?: SkillRegistry;
  skillExecutor?: SkillExecutor;
  router?: Router;
  costTracker?: CostTracker;
  hotCollector?: HotCollector;
  hybridSearch?: HybridSearch;
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
  type: 'thinking' | 'tool_start' | 'tool_complete' | 'status';
  message: string;
  toolName?: string;
  iteration?: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous AI agent with direct access to the user's system through skills. You MUST use your skills to accomplish tasks - do not just describe what you would do, actually do it.

CRITICAL: You have REAL skills that execute REAL commands. USE THEM. Never say "I cannot" - you CAN through your skills.

SKILLS:
Your capabilities are defined by skills listed at the end of this prompt. Each skill has a name, description, and input parameters. Use skills immediately to accomplish tasks.

REMINDERS - IMPORTANT:
When the user asks to be reminded about something, use the reminder tool with action="set".
- This tool returns IMMEDIATELY after scheduling the reminder
- Supported time formats:
  - Intervals: "5 minutes", "1 hour", "30 min"
  - Absolute times: "at 10am", "3:30pm", "tomorrow at 9am"
  - Recurring: "every day at 10am", "every Monday at 9am", "weekdays at 8am"
- When the reminder triggers:
  - If it contains an ACTION (check, get, search, find, etc.), the action will be EXECUTED automatically
  - If it's a simple reminder (like "smile"), just the message is sent
- Examples:
  - "remind me in 5 min to check the weather" → time="5 minutes"
  - "remind me at 10am to take my medicine" → time="at 10am"
  - "remind me every day at 9am to check email" → time="every day at 9am" (recurring!)
  - "remind me every Monday at 3pm about the meeting" → time="every Monday at 3pm"
- DO NOT use bash sleep or any blocking approach - always use the reminder tool

AUTOMATIC MEMORY - IMPORTANT:
- Your conversations are AUTOMATICALLY remembered. You don't need to do anything special.
- Facts about the user (name, preferences, etc.) are automatically extracted and shown in "MEMORIES FROM THE PAST" section above.
- DO NOT create files to remember things. DO NOT use write/edit tools to store user information.
- When the user says "remember X" or asks if you remember something, just acknowledge it - the memory system handles storage automatically.

PERSONAL REFERENCES - CRITICAL:
When the user mentions something personal they've told you before, ALWAYS use memory_search FIRST:
- "my flatmate", "my friend", "my colleague", "my project", "my car", "my dog", etc.
- "tell me about X" where X is someone/something they've mentioned before
- "remember when...", "you know...", "as I told you..."
If the user asks about "my flatmate's university" - search memory for "flatmate" first!
Only use web_search AFTER checking memory, or if memory has no relevant results.

FOR WEB SEARCHES (sports, news, weather, current events, NEW people/companies):
1. For NEW information (not previously discussed), use web_search - it's fast and reliable
2. If you need more details from a specific page, then use browser to visit that URL
3. memory_search is for past conversations - check it first for personal references!

RESEARCH vs ACTION - CRITICAL:
1. For research tasks: do 1-2 web searches MAX, then proceed with what you found
2. If a search returns useful results, USE THEM immediately - don't keep searching for "better" results
3. If you see "[Identical to previous output]" - you already have that data, move on!
4. For coding tasks: gather info quickly, then WRITE THE CODE
5. Don't get stuck in research loops - after 2 searches, work with what you have

FALLBACK RULES (only if first approach fails):
- API fails → try browser skill instead
- One website fails → try one different website
- Web fetch fails → try browser navigate

EXECUTION RULES:
1. USE skills immediately - don't ask permission
2. Execute one step at a time
3. Show actual results from skill execution
4. Be concise but thorough
5. Keep trying until you succeed or have exhausted all reasonable approaches

PROGRESS UPDATES - CRITICAL:
You MUST always output a brief message BEFORE each skill invocation to keep the user informed. Never invoke skills silently.
- ALWAYS write a short status message before every skill use
- For multi-step tasks, update the user at each step
- Be concise - one short sentence is enough
- This text is sent to the user immediately, so they know you're working

Examples of good progress messages before skill invocations:
- "Searching the web for that..."
- "Found some results. Let me get more details from LinkedIn..."
- "Checking GitHub for your profile..."
- "That didn't work, trying a different approach..."
- "Got the search results. Here's what I found:"

BAD (don't do this): Invoking skills without any text output first.
GOOD: Always write something brief, then invoke the skill.

MESSAGING STYLE:
Text like a human - one thought per message, short and punchy. You can send multiple messages but keep each one brief.

FORMATTING RULES:
- Do NOT use markdown headings (# or ##) in your replies
- Use **bold**, *italic*, and simple formatting instead
- Tables don't render in Telegram - always use bullet lists instead (unless user specifically asks for a table)
- Keep responses clean and conversational, not document-like

WEB BROWSING:
When the user wants you to visit a website, check a page, or get info from a specific URL - use the browser skill! You have it, use it.

You are running on the user's server. Act autonomously and persistently to help them.`;

export class Agent {
  private provider: LLMProvider;
  private sessionManager: SessionManager;
  private toolRegistry: ToolRegistry | null;
  private skillRegistry: SkillRegistry | null;
  private skillExecutor: SkillExecutor | null;
  private router: Router | null;
  private costTracker: CostTracker | null;
  private hotCollector: HotCollector | null;
  private hybridSearch: HybridSearch | null;
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
    this.toolRegistry = options.toolRegistry || null;
    this.skillRegistry = options.skillRegistry || null;
    this.skillExecutor = options.skillExecutor || null;
    this.router = options.router || null;
    this.costTracker = options.costTracker || null;
    this.hotCollector = options.hotCollector || null;
    this.hybridSearch = options.hybridSearch || null;
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
      const userId = session.metadata?.userId || sessionId;
      this.factExtractor.queueForExtraction(
        userMessage,
        userId,
        this.lastAssistantResponse || undefined
      ).catch((error) => {
        this.logger.warn({ error: (error as Error).message }, 'Async fact extraction failed');
      });
    }

    // Build system prompt with memory context
    const systemPrompt = await this.buildSystemPrompt(userMessage, sessionId);

    // Get tool definitions from skills (skills are now the primary capability source)
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

      this.logger.info({
        iteration: iterations,
        stopReason: response.stopReason,
        hasText: !!textContent,
        textLength: textContent?.length || 0,
        toolUseCount: toolUses.length,
        toolNames: toolUses.map(t => t.name),
      }, 'LLM response received');

      // If no tool use, we're done
      if (response.stopReason === 'end_turn' || toolUses.length === 0) {
        finalResponse = textContent || 'I completed the task.';

        // Add assistant response to session
        await this.sessionManager.addMessage(sessionId, {
          role: 'assistant',
          content: response.content,
        });

        break;
      }

      // Send assistant's thinking/planning text to user before executing tools
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
      const toolResults = await this.executeTools(toolUses, sessionId, userId);
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

  private async buildSystemPrompt(userMessage: string, sessionId: string): Promise<string> {
    let prompt = this.baseSystemPrompt;

    // Add workspace context
    prompt += `\n\nWorkspace: ${this.workspace}`;

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

    // Add memory context if hybrid search is available
    if (this.hybridSearch) {
      const memoryContext = this.buildMemoryContext(userMessage, sessionId);
      if (memoryContext) {
        prompt += memoryContext;
      }
    }

    return prompt;
  }

  /**
   * Build memory context for system prompt
   * Includes relevant memories and recent conversations
   *
   * FIX A/B/E: Always include user facts, prioritize facts over context
   */
  private buildMemoryContext(userMessage: string, sessionId: string): string {
    if (!this.hybridSearch) return '';

    const MAX_MEMORY_CHARS = 2000;
    const MAX_CONVERSATION_MESSAGES = 6;
    let context = '';

    try {
      // FIX B/E: First, always get key user facts (subject="user") regardless of query
      // These are facts about the user that should always be available
      const userFacts = this.hybridSearch.search('', {
        limit: 20,
        type: 'fact',
        subject: 'user',  // Only facts about the user, not third parties
        recencyBoost: true,
        minScore: 0,  // Get all user facts
      });

      // FIX A: Search for query-relevant facts, preferring facts type over context
      const relevantFacts = this.hybridSearch.search(userMessage, {
        limit: 10,
        type: 'fact',  // Only facts, not context
        recencyBoost: true,
        minScore: 0.1,
        userSubjectBoost: 2.0,  // Boost user facts higher
      });

      // Combine user facts with query-relevant facts, deduplicating by ID
      const seenIds = new Set<string>();
      const allFacts: typeof userFacts = [];

      // Add user facts first (always included)
      for (const fact of userFacts) {
        if (!seenIds.has(fact.entry.id)) {
          seenIds.add(fact.entry.id);
          allFacts.push(fact);
        }
      }

      // Add query-relevant facts
      for (const fact of relevantFacts) {
        if (!seenIds.has(fact.entry.id)) {
          seenIds.add(fact.entry.id);
          allFacts.push(fact);
        }
      }

      if (allFacts.length > 0) {
        let memoriesText = '';
        let charCount = 0;

        for (const result of allFacts) {
          // Include subject info for third-party facts
          const subject = result.entry.metadata?.subject as string | undefined;
          const subjectPrefix = subject && subject !== 'user' ? `[About ${subject}] ` : '';
          const memoryLine = `- ${subjectPrefix}${result.entry.content}\n`;
          if (charCount + memoryLine.length > MAX_MEMORY_CHARS) break;
          memoriesText += memoryLine;
          charCount += memoryLine.length;
        }

        if (memoriesText) {
          context += `\n\n## MEMORIES FROM THE PAST\nThese are facts you've learned about the user and people they've mentioned:\n${memoriesText}`;
        }
      }

      // Get recent conversation messages from this session
      const conversationMemories = this.hybridSearch.search(userMessage, {
        limit: MAX_CONVERSATION_MESSAGES * 2, // Get extra to filter
        sessionId,
        recencyBoost: true,
        minScore: 0.05,
      });

      // Filter to conversation messages (raw before gardener processes, context after)
      const recentConversations = conversationMemories
        .filter((r) => (r.entry.type === 'raw' || r.entry.type === 'context') && r.entry.tags?.includes('conversation'))
        .slice(0, MAX_CONVERSATION_MESSAGES);

      if (recentConversations.length > 0) {
        let conversationText = '';

        for (const result of recentConversations) {
          const source = result.entry.metadata?.source || 'unknown';
          const role = source === 'user' ? 'User' : source === 'assistant' ? 'Assistant' : source;
          const content = result.entry.content.length > 200
            ? result.entry.content.substring(0, 200) + '...'
            : result.entry.content;
          conversationText += `${role}: ${content}\n`;
        }

        if (conversationText) {
          context += `\n\n## CONVERSATIONS FROM THE PAST\nRelevant past exchanges:\n${conversationText}`;
        }
      }

      if (context) {
        this.logger.debug(
          { userFactCount: userFacts.length, relevantFactCount: relevantFacts.length, totalFacts: allFacts.length },
          'Memory context added to prompt'
        );
      }
    } catch (error) {
      this.logger.warn({ error: (error as Error).message }, 'Failed to build memory context');
    }

    return context;
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
   * Clean progress message by removing JSON tool call patterns
   * Some models output tool calls as JSON text instead of proper tool_calls
   */
  private cleanProgressMessage(text: string): string {
    // Remove JSON blocks that look like tool calls
    let cleaned = text
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
    userId?: string
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const toolUse of toolUses) {
      // Try skill first (skills are now the primary execution path)
      const skill = this.skillRegistry?.getSkill(toolUse.name);

      if (skill && this.skillExecutor) {
        this.logger.debug({ skillName: toolUse.name, input: toolUse.input }, 'Executing skill');

        try {
          const result = await this.skillExecutor.execute(skill, {
            skillName: toolUse.name,
            args: toolUse.input,
            cwd: this.workspace,
          });

          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.success
              ? (result.output || 'Success')
              : `Error: ${result.error}`,
            is_error: !result.success,
          });

          // Collect in memory
          if (this.hotCollector && result.success) {
            this.hotCollector.collect({
              content: `Skill ${toolUse.name} executed: ${(result.output || '').slice(0, 500)}`,
              sessionId,
              source: `skill:${toolUse.name}`,
              tags: ['skill-execution', toolUse.name],
              metadata: { skillInput: toolUse.input },
            });
          }
        } catch (error) {
          const err = error as Error;
          this.logger.error({ skillName: toolUse.name, error: err.message }, 'Skill execution failed');
          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error executing skill: ${err.message}`,
            is_error: true,
          });
        }
        continue;
      }

      // Skill not found - return error (skills are the only execution path)
      {
        this.logger.warn({ name: toolUse.name }, 'Unknown skill/tool requested');
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: Unknown skill "${toolUse.name}"`,
          is_error: true,
        });
      }
    }

    return results;
  }
}
