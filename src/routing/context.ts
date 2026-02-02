/**
 * Context Manager
 * Manages sliding window context with compression and tool output truncation
 */

import type { Message, ContentBlock } from '../providers/types.js';
import { createHash } from 'crypto';

/**
 * Tool Output Deduplicator
 * Detects and deduplicates identical tool outputs to reduce context size
 */
export interface DeduplicatorOptions {
  /** Whether deduplication is enabled (default: true) */
  enabled?: boolean;
  /** Minimum output size in bytes to consider for deduplication (default: 100) */
  minSizeBytes?: number;
}

interface DeduplicatedOutput {
  hash: string;
  toolName: string;
  inputHash: string;
  output: string;
  firstSeenAt: number;
  occurrences: number;
}

export class ToolOutputDeduplicator {
  private enabled: boolean;
  private minSizeBytes: number;
  private outputs: Map<string, DeduplicatedOutput> = new Map();
  private callHistory: Map<string, string> = new Map(); // inputHash -> outputHash

  constructor(options: DeduplicatorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.minSizeBytes = options.minSizeBytes ?? 100;
  }

  /**
   * Hash tool call input for lookup
   */
  private hashToolCall(toolName: string, input: Record<string, unknown>): string {
    const data = JSON.stringify({ tool: toolName, input });
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  /**
   * Hash output content
   */
  private hashOutput(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Check if a tool output should be deduplicated
   * Returns the deduplicated output if applicable, or null if not
   */
  shouldDeduplicate(
    toolName: string,
    input: Record<string, unknown>,
    output: string
  ): { deduplicated: boolean; reference?: string; originalHash?: string } {
    if (!this.enabled) {
      return { deduplicated: false };
    }

    const outputBytes = Buffer.byteLength(output, 'utf-8');
    if (outputBytes < this.minSizeBytes) {
      return { deduplicated: false };
    }

    const inputHash = this.hashToolCall(toolName, input);
    const outputHash = this.hashOutput(output);

    // Check if we've seen this exact output before
    const existing = this.outputs.get(outputHash);
    if (existing) {
      existing.occurrences++;
      return {
        deduplicated: true,
        reference: `[Identical to previous ${existing.toolName} output. Hash: ${outputHash}]`,
        originalHash: outputHash,
      };
    }

    // Check if we've seen this exact call before (same tool + input)
    const previousOutputHash = this.callHistory.get(inputHash);
    if (previousOutputHash) {
      const previousOutput = this.outputs.get(previousOutputHash);
      if (previousOutput) {
        previousOutput.occurrences++;
        return {
          deduplicated: true,
          reference: `[Same as previous ${previousOutput.toolName} call. Hash: ${previousOutputHash}]`,
          originalHash: previousOutputHash,
        };
      }
    }

    // Store this output for future deduplication
    this.outputs.set(outputHash, {
      hash: outputHash,
      toolName,
      inputHash,
      output,
      firstSeenAt: Date.now(),
      occurrences: 1,
    });
    this.callHistory.set(inputHash, outputHash);

    return { deduplicated: false };
  }

  /**
   * Get original output by hash
   */
  getOutputByHash(hash: string): string | undefined {
    return this.outputs.get(hash)?.output;
  }

  /**
   * Get deduplication stats
   */
  getStats(): { totalOutputs: number; totalDeduplicated: number; bytesSaved: number } {
    let totalDeduplicated = 0;
    let bytesSaved = 0;

    for (const output of this.outputs.values()) {
      const duplicates = output.occurrences - 1;
      if (duplicates > 0) {
        totalDeduplicated += duplicates;
        bytesSaved += duplicates * Buffer.byteLength(output.output, 'utf-8');
      }
    }

    return {
      totalOutputs: this.outputs.size,
      totalDeduplicated,
      bytesSaved,
    };
  }

  /**
   * Clear all stored outputs
   */
  clear(): void {
    this.outputs.clear();
    this.callHistory.clear();
  }

  /**
   * Check if deduplication is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable deduplication
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export interface CompressedContext {
  summary: string;
  messageCount: number;
  toolsUsed: string[];
  topics: string[];
  timestamp: Date;
}

export interface ProcessedContext {
  hotMessages: Message[];
  warmSummary?: CompressedContext;
  wasCompressed: boolean;
  estimatedTokens: number;
}

export interface ContextManagerOptions {
  hotWindowSize?: number;
  maxContextTokens?: number;
  compressionThreshold?: number;
  maxToolOutputBytes?: number;
  /** Enable tool output deduplication (default: true) */
  dedupeIdentical?: boolean;
}

interface TruncatedOutput {
  hash: string;
  originalContent: string;
  truncatedContent: string;
}

export class ContextManager {
  private hotWindowSize: number;
  private maxContextTokens: number;
  private compressionThreshold: number;
  private maxToolOutputBytes: number;
  private truncatedOutputs: Map<string, TruncatedOutput> = new Map();
  private deduplicator: ToolOutputDeduplicator;

  constructor(options: ContextManagerOptions) {
    this.hotWindowSize = options.hotWindowSize ?? 5;
    this.maxContextTokens = options.maxContextTokens ?? 128000;
    this.compressionThreshold = options.compressionThreshold ?? 0.7;
    this.maxToolOutputBytes = options.maxToolOutputBytes ?? 30000;
    this.deduplicator = new ToolOutputDeduplicator({
      enabled: options.dedupeIdentical ?? true,
    });
  }

  /**
   * Get the deduplicator instance for external use
   */
  getDeduplicator(): ToolOutputDeduplicator {
    return this.deduplicator;
  }

  getHotWindowSize(): number {
    return this.hotWindowSize;
  }

  getMaxContextTokens(): number {
    return this.maxContextTokens;
  }

  processMessages(messages: Message[]): ProcessedContext {
    // Truncate tool outputs first
    const processedMessages = this.truncateToolOutputs(messages);

    const estimatedTokens = this.estimateTokens(processedMessages);
    const capacityUsage = estimatedTokens / this.maxContextTokens;

    // Check if we need compression
    const needsCompression =
      processedMessages.length > this.hotWindowSize ||
      capacityUsage >= this.compressionThreshold;

    if (!needsCompression) {
      return {
        hotMessages: processedMessages,
        wasCompressed: false,
        estimatedTokens,
      };
    }

    // Split into hot and cold messages
    const hotStartIndex = Math.max(0, processedMessages.length - this.hotWindowSize);
    const hotMessages = processedMessages.slice(hotStartIndex);
    const coldMessages = processedMessages.slice(0, hotStartIndex);

    // Compress cold messages
    const warmSummary = this.compressMessages(coldMessages);

    return {
      hotMessages,
      warmSummary,
      wasCompressed: coldMessages.length > 0,
      estimatedTokens: this.estimateTokens(hotMessages),
    };
  }

  private truncateToolOutputs(messages: Message[]): Message[] {
    // Build map of tool_use_id -> tool info for deduplication
    const toolUseMap = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const msg of messages) {
      if (typeof msg.content !== 'string') {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolUseMap.set(block.id, { name: block.name, input: block.input });
          }
        }
      }
    }

    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return msg;
      }

      const processedContent = msg.content.map((block) => {
        if (block.type !== 'tool_result') {
          return block;
        }

        const toolResult = block as {
          type: 'tool_result';
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        };

        // Check for deduplication first
        const toolInfo = toolUseMap.get(toolResult.tool_use_id);
        if (toolInfo && this.deduplicator.isEnabled()) {
          const dedupeResult = this.deduplicator.shouldDeduplicate(
            toolInfo.name,
            toolInfo.input,
            toolResult.content
          );

          if (dedupeResult.deduplicated && dedupeResult.reference) {
            return {
              ...toolResult,
              content: dedupeResult.reference,
            };
          }
        }

        const contentBytes = Buffer.byteLength(toolResult.content, 'utf-8');

        if (contentBytes <= this.maxToolOutputBytes) {
          return block;
        }

        // Truncate and store original
        const hash = this.hashContent(toolResult.content);
        const truncatedContent = this.truncateContent(
          toolResult.content,
          this.maxToolOutputBytes
        );

        this.truncatedOutputs.set(hash, {
          hash,
          originalContent: toolResult.content,
          truncatedContent,
        });

        return {
          ...toolResult,
          content: truncatedContent + `\n\n[Output truncated. Hash: ${hash}]`,
        };
      });

      return {
        ...msg,
        content: processedContent as ContentBlock[],
      };
    });
  }

  private truncateContent(content: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(content);

    if (encoded.length <= maxBytes) {
      return content;
    }

    // Find a safe truncation point (don't split multi-byte chars)
    const truncated = encoded.slice(0, maxBytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(truncated);
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  getTruncatedOutputHashes(): string[] {
    return Array.from(this.truncatedOutputs.keys());
  }

  getFullOutputByHash(hash: string): string | undefined {
    return this.truncatedOutputs.get(hash)?.originalContent;
  }

  private compressMessages(messages: Message[]): CompressedContext {
    const toolsUsed = new Set<string>();
    const summaryParts: string[] = [];
    const topics = new Set<string>();

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        summaryParts.push(`${msg.role}: ${msg.content}`);
        this.extractTopics(msg.content, topics);
      } else {
        // Process content blocks
        for (const block of msg.content) {
          if (block.type === 'text') {
            summaryParts.push(`${msg.role}: ${block.text}`);
            this.extractTopics(block.text, topics);
          } else if (block.type === 'tool_use') {
            toolsUsed.add(block.name);
          }
        }
      }
    }

    return {
      summary: summaryParts.join('\n'),
      messageCount: messages.length,
      toolsUsed: Array.from(toolsUsed),
      topics: Array.from(topics),
      timestamp: new Date(),
    };
  }

  private extractTopics(text: string, topics: Set<string>): void {
    // Simple topic extraction based on capitalized words and common patterns
    const patterns = [
      /\b(TypeScript|JavaScript|React|Vue|Angular|Node|Python|Go|Rust)\b/gi,
      /\b(API|REST|GraphQL|Database|SQL|MongoDB)\b/gi,
      /\b(Docker|Kubernetes|AWS|Azure|GCP)\b/gi,
      /\b(authentication|authorization|security|testing)\b/gi,
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach((m) => topics.add(m.toLowerCase()));
      }
    }
  }

  estimateTokens(messages: Message[]): number {
    let totalChars = 0;

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            totalChars += block.text.length;
          } else if (block.type === 'tool_use') {
            totalChars += JSON.stringify(block.input).length + block.name.length;
          } else if (block.type === 'tool_result') {
            totalChars += block.content.length;
          }
        }
      }
    }

    // Rough estimate: ~4 characters per token
    return Math.ceil(totalChars / 4);
  }

  getRemainingCapacity(messages: Message[]): number {
    const used = this.estimateTokens(messages);
    return Math.max(0, this.maxContextTokens - used);
  }

  getCapacityUsage(messages: Message[]): number {
    const used = this.estimateTokens(messages);
    return used / this.maxContextTokens;
  }

  buildContextMessages(messages: Message[]): Message[] {
    const processed = this.processMessages(messages);

    if (!processed.warmSummary) {
      return processed.hotMessages;
    }

    // Build context with compressed history indicator
    const contextNote: Message = {
      role: 'user',
      content: `[Previous conversation summary (${processed.warmSummary.messageCount} messages):\n${this.formatSummaryForContext(processed.warmSummary)}\n\nContinuing from recent messages:]`,
    };

    return [contextNote, ...processed.hotMessages];
  }

  private formatSummaryForContext(summary: CompressedContext): string {
    const parts: string[] = [];

    if (summary.topics.length > 0) {
      parts.push(`Topics discussed: ${summary.topics.join(', ')}`);
    }

    if (summary.toolsUsed.length > 0) {
      parts.push(`Tools used: ${summary.toolsUsed.join(', ')}`);
    }

    // Add abbreviated summary
    const lines = summary.summary.split('\n');
    const abbreviated = lines.slice(0, 10).join('\n');
    if (lines.length > 10) {
      parts.push(abbreviated + `\n... (${lines.length - 10} more exchanges)`);
    } else {
      parts.push(abbreviated);
    }

    return parts.join('\n');
  }
}
