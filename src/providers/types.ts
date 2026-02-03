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

export type ContentBlock = TextContent | ImageContent | ToolUseContent | ToolResultContent;

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

// Completion request
export interface CompletionRequest {
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** Enable extended thinking for supported models (e.g., Kimi K2.5) */
  enableThinking?: boolean;
}

// Token usage tracking
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
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
