/**
 * LLM Provider Types
 * Defines standardized interfaces for LLM providers
 */

// Content block types for messages
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data?: string;
    url?: string;
  };
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Preserved reasoning/thinking from models with extended thinking (e.g., Kimi K2.5) */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextContent | ImageContent | ToolUseContent | ToolResultContent | ThinkingContent;

// Message types
export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// Tool definition
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * System prompt with cache boundary.
 *
 * `stable`: cacheable prefix — persona, skills, tools docs, profiles. Should not
 *   change between turns of the same session.
 * `dynamic`: per-turn content — timestamps, affect, query-relevant memory,
 *   iteration counters. Excluded from prompt cache.
 *
 * Providers that support prompt caching (Anthropic) emit two blocks with
 * cache_control on the stable one. Providers without caching concatenate
 * stable + dynamic into a single system message.
 */
export interface SystemPrompt {
  stable: string;
  dynamic?: string;
}

/** Collapse SystemPrompt | string to a flat string for providers without cache support. */
export function flattenSystem(system: string | SystemPrompt): string {
  if (typeof system === 'string') return system;
  return system.dynamic ? `${system.stable}${system.dynamic}` : system.stable;
}

// Completion request
export interface CompletionRequest {
  messages: Message[];
  system?: string | SystemPrompt;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** Enable extended thinking for supported models (e.g., Kimi K2.5) */
  enableThinking?: boolean;
  /** Token budget for thinking/reasoning (used by thinking levels system) */
  thinkingBudgetTokens?: number;
  /**
   * Abort signal to cancel an in-flight request. Providers that support
   * cancellation (Anthropic, OpenAI, OpenRouter, Moonshot via fetch/SDK
   * signal plumbing) will terminate the underlying HTTP call; others
   * ignore the signal silently.
   */
  signal?: AbortSignal;
}

// Token usage tracking
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning/thinking tokens consumed (e.g., Kimi K2.5 thinking mode) */
  reasoningTokens?: number;
  /** Input tokens served from prompt cache (subset of inputTokens) */
  cachedInputTokens?: number;
}

// Completion response
export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: TokenUsage;
  model: string;
}

// Streaming event types
export interface StreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_stop';
  index?: number;
  contentBlock?: ContentBlock;
  delta?: { type: string; text?: string };
}

// Provider interface
export interface LLMProvider {
  name: string;

  /**
   * Create a completion (non-streaming)
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Create a streaming completion
   */
  stream?(request: CompletionRequest): AsyncIterable<StreamEvent>;

  /**
   * Check if the provider is available (has valid API key, etc.)
   */
  isAvailable(): boolean;
}

// Provider configuration
export interface ProviderOptions {
  apiKey: string;
  /** Multiple API keys for rotation on auth errors */
  apiKeys?: string[];
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeout?: number;
}
