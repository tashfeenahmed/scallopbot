import * as fs from 'fs/promises';
import * as path from 'path';
import type { Logger } from 'pino';
import type {
  LLMProvider,
  ContentBlock,
  ToolUseContent,
  TokenUsage,
  CompletionRequest,
} from '../providers/types.js';
import type { ToolRegistry, ToolContext } from '../tools/types.js';
import type { SessionManager } from './session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { Router } from '../routing/router.js';
import type { CostTracker } from '../routing/cost.js';
import type { HotCollector } from '../memory/memory.js';
import type { ContextManager } from '../routing/context.js';
import type { MediaProcessor } from '../media/index.js';
import type { Attachment } from '../channels/types.js';
import { analyzeComplexity } from '../routing/complexity.js';

export interface AgentOptions {
  provider: LLMProvider;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  skillRegistry?: SkillRegistry;
  router?: Router;
  costTracker?: CostTracker;
  hotCollector?: HotCollector;
  contextManager?: ContextManager;
  mediaProcessor?: MediaProcessor;
  workspace: string;
  logger: Logger;
  maxIterations: number;
  systemPrompt?: string;
}

export interface AgentResult {
  response: string;
  tokenUsage: TokenUsage;
  iterationsUsed: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools for file operations and command execution.

You can:
- Read files from the filesystem
- Write and edit files
- Execute bash commands

Always be helpful and thorough in completing tasks. When using tools, explain what you're doing.`;

export class Agent {
  private provider: LLMProvider;
  private sessionManager: SessionManager;
  private toolRegistry: ToolRegistry;
  private skillRegistry: SkillRegistry | null;
  private router: Router | null;
  private costTracker: CostTracker | null;
  private hotCollector: HotCollector | null;
  private contextManager: ContextManager | null;
  private mediaProcessor: MediaProcessor | null;
  private workspace: string;
  private logger: Logger;
  private maxIterations: number;
  private baseSystemPrompt: string;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.sessionManager = options.sessionManager;
    this.toolRegistry = options.toolRegistry;
    this.skillRegistry = options.skillRegistry || null;
    this.router = options.router || null;
    this.costTracker = options.costTracker || null;
    this.hotCollector = options.hotCollector || null;
    this.contextManager = options.contextManager || null;
    this.mediaProcessor = options.mediaProcessor || null;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.maxIterations = options.maxIterations;
    this.baseSystemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * Process a message with optional attachments
   */
  async processMessage(
    sessionId: string,
    userMessage: string,
    attachments?: Attachment[]
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

    // Build system prompt
    const systemPrompt = await this.buildSystemPrompt();

    // Get tool definitions
    const tools = this.toolRegistry.getToolDefinitions();

    // Track usage across iterations
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    let finalResponse = '';
    let lastModel = '';

    // Agent loop
    while (iterations < this.maxIterations) {
      iterations++;

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
      };

      this.logger.info({ iteration: iterations, messageCount: messages.length, provider: activeProvider.name }, 'Agent iteration starting');

      // Call LLM
      let response;
      try {
        response = await activeProvider.complete(request);
      } catch (error) {
        this.logger.error({
          iteration: iterations,
          error: (error as Error).message,
          provider: activeProvider.name
        }, 'LLM call failed');
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

      // Add assistant message with tool use
      await this.sessionManager.addMessage(sessionId, {
        role: 'assistant',
        content: response.content,
      });

      // Execute tools and gather results
      this.logger.info({ toolCount: toolUses.length, tools: toolUses.map(t => t.name) }, 'Executing tools');
      const toolResults = await this.executeTools(toolUses, sessionId);
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

    this.logger.info(
      { sessionId, iterations, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, provider: activeProvider.name },
      'Message processed'
    );

    return {
      response: finalResponse,
      tokenUsage,
      iterationsUsed: iterations,
    };
  }

  private async buildSystemPrompt(): Promise<string> {
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

    return prompt;
  }

  private extractTextContent(content: ContentBlock[]): string {
    return content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private extractToolUses(content: ContentBlock[]): ToolUseContent[] {
    return content.filter((block): block is ToolUseContent => block.type === 'tool_use');
  }

  private async executeTools(
    toolUses: ToolUseContent[],
    sessionId: string
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const toolUse of toolUses) {
      const tool = this.toolRegistry.getTool(toolUse.name);

      if (!tool) {
        this.logger.warn({ toolName: toolUse.name }, 'Unknown tool requested');
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: Unknown tool "${toolUse.name}"`,
          is_error: true,
        });
        continue;
      }

      const context: ToolContext = {
        workspace: this.workspace,
        sessionId,
        logger: this.logger.child({ tool: toolUse.name }),
      };

      this.logger.debug({ toolName: toolUse.name, input: toolUse.input }, 'Executing tool');

      try {
        const result = await tool.execute(toolUse.input, context);

        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.success ? result.output : `Error: ${result.error}`,
          is_error: !result.success,
        });

        // Collect tool execution in memory
        if (this.hotCollector && result.success) {
          this.hotCollector.collect({
            content: `Tool ${toolUse.name} executed: ${result.output.slice(0, 500)}${result.output.length > 500 ? '...' : ''}`,
            sessionId,
            source: `tool:${toolUse.name}`,
            tags: ['tool-execution', toolUse.name],
            metadata: { toolInput: toolUse.input },
          });
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error({ toolName: toolUse.name, error: err.message }, 'Tool execution failed');
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error executing tool: ${err.message}`,
          is_error: true,
        });
      }
    }

    return results;
  }
}
