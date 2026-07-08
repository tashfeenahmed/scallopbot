/**
 * Session Summarizer
 *
 * Generates LLM-powered summaries of chat sessions before they are pruned.
 * Summaries capture the key topics and outcomes of each conversation,
 * enabling "what did we discuss?" queries without keeping full transcripts.
 */

import type { Logger } from 'pino';
import type { LLMProvider } from '../providers/types.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { ScallopDatabase, SessionMessageRow } from './db.js';
import { completionBudgetForPurpose, charsForTokenBudget, getModelTokenLimits } from '../routing/model-limits.js';
import { extractJSON, extractResponseText } from '../proactive/proactive-utils.js';

export interface SessionSummarizerOptions {
  provider: LLMProvider;
  logger: Logger;
  embedder?: EmbeddingProvider;
  /** Minimum messages for a session to qualify for summarization (default: 4) */
  minMessages?: number;
}

export interface SessionSummaryResult {
  summary: string;
  topics: string[];
}

// Exported for fine-tune dataset construction (scripts/ft/).
export const SESSION_SUMMARY_PROMPT = `Summarize this conversation in 2-3 concise sentences. Focus on:
- What the user asked for / what was discussed
- Key outcomes or decisions made
- Any commitments or follow-ups mentioned

Also extract 3-7 topic tags (short phrases) that describe what was discussed.

Respond with JSON only:
{"summary": "2-3 sentence summary", "topics": ["topic1", "topic2", ...]}

Conversation:
`;

/**
 * Generates and stores session summaries
 */
export class SessionSummarizer {
  private provider: LLMProvider;
  private logger: Logger;
  private embedder?: EmbeddingProvider;
  private minMessages: number;
  /** Per-session failure counter so a chronically broken session doesn't retry every gardener tick. */
  private failures: Map<string, number> = new Map();
  private static readonly MAX_FAILURES = 3;

  constructor(options: SessionSummarizerOptions) {
    this.provider = options.provider;
    this.logger = options.logger.child({ component: 'session-summarizer' });
    this.embedder = options.embedder;
    this.minMessages = options.minMessages ?? 4;
  }

  /**
   * Summarize a session and store the result.
   * Skips sessions with fewer than minMessages messages.
   */
  async summarizeAndStore(
    db: ScallopDatabase,
    sessionId: string,
    userId: string = 'default'
  ): Promise<boolean> {
    // Skip sessions that have failed too many times. Without this, the gardener's
    // `NOT EXISTS session_summaries` query re-selects the same broken session
    // every tick, thrashing the LLM forever.
    const priorFailures = this.failures.get(sessionId) ?? 0;
    if (priorFailures >= SessionSummarizer.MAX_FAILURES) {
      this.logger.debug({ sessionId, failures: priorFailures }, 'Skipping chronically failing session summary');
      return false;
    }

    // Check if summary already exists
    const existing = db.getSessionSummary(sessionId);
    if (existing) {
      this.logger.debug({ sessionId }, 'Session summary already exists, skipping');
      return false;
    }

    // Get session messages
    const messages = db.getSessionMessages(sessionId);
    if (messages.length < this.minMessages) {
      this.logger.debug({ sessionId, messageCount: messages.length }, 'Session too short for summary');
      return false;
    }

    try {
      const result = await this.generateSummary(messages);
      if (!result) return false;

      // Generate embedding for the summary
      let embedding: number[] | null = null;
      if (this.embedder) {
        try {
          embedding = await this.embedder.embed(result.summary);
        } catch (err) {
          this.logger.warn({ error: (err as Error).message }, 'Summary embedding failed');
        }
      }

      // Calculate duration
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];
      const durationMs = lastMsg.createdAt - firstMsg.createdAt;

      db.addSessionSummary({
        sessionId,
        userId,
        summary: result.summary,
        topics: result.topics,
        messageCount: messages.length,
        durationMs,
        embedding,
      });

      this.logger.info(
        { sessionId, topics: result.topics, messageCount: messages.length },
        'Session summary generated'
      );
      this.failures.delete(sessionId);
      return true;
    } catch (err) {
      const attempt = priorFailures + 1;
      this.failures.set(sessionId, attempt);
      this.logger.warn(
        { error: (err as Error).message, sessionId, attempt, willRetry: attempt < SessionSummarizer.MAX_FAILURES },
        'Session summarization failed'
      );
      return false;
    }
  }

  /**
   * Summarize multiple sessions (e.g., before pruning).
   * Returns count of successfully summarized sessions.
   */
  async summarizeBatch(
    db: ScallopDatabase,
    sessionIds: string[],
    userId: string = 'default'
  ): Promise<number> {
    let count = 0;
    for (const sessionId of sessionIds) {
      const success = await this.summarizeAndStore(db, sessionId, userId);
      if (success) count++;
    }
    return count;
  }

  /**
   * Generate summary from session messages using LLM.
   */
  private async generateSummary(messages: SessionMessageRow[]): Promise<SessionSummaryResult | null> {
    const firstBudget = completionBudgetForPurpose(this.provider, 'session_summary');
    const retryBudget = completionBudgetForPurpose(
      this.provider,
      'session_summary_retry',
      firstBudget * 2,
      { minTokens: firstBudget + 1 }
    );
    const limits = getModelTokenLimits(this.provider);
    const promptTokenBudget = Math.max(
      1000,
      Math.floor((limits.contextWindowTokens - firstBudget - 512) * 0.5)
    );
    const conversationCharLimit = Math.min(12_000, Math.max(4_000, charsForTokenBudget(promptTokenBudget)));
    const conversationText = this.buildConversationText(messages, conversationCharLimit);

    const first = await this.requestSummary(conversationText, firstBudget);
    const firstParsed = this.parseSummaryResponse(extractResponseText(first.content));
    if (firstParsed) return firstParsed;

    if (first.stopReason === 'max_tokens' && retryBudget > firstBudget) {
      this.logger.debug(
        { firstBudget, retryBudget, model: first.model, modelContextWindowTokens: limits.contextWindowTokens },
        'Session summary hit max_tokens; retrying with larger output budget'
      );
      const retry = await this.requestSummary(conversationText, retryBudget);
      return this.parseSummaryResponse(extractResponseText(retry.content));
    }

    return null;
  }

  private buildConversationText(messages: SessionMessageRow[], maxChars: number): string {
    let conversationText = '';
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      // Parse content - may be JSON (content blocks) or plain string
      let text: string;
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => b.text)
            .join(' ');
        } else {
          text = String(msg.content);
        }
      } catch {
        text = msg.content;
      }

      const line = `${role}: ${text.substring(0, 700)}\n`;
      if (conversationText.length + line.length > maxChars) break;
      conversationText += line;
    }
    return conversationText;
  }

  private async requestSummary(conversationText: string, maxTokens: number) {
    const prompt = SESSION_SUMMARY_PROMPT + conversationText;

    return this.provider.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens,
      purpose: 'session_summary',
      traceMetadata: {
        conversationChars: conversationText.length,
      },
    });
  }

  private parseSummaryResponse(responseText: string): SessionSummaryResult | null {
    const parsed = extractJSON<{ summary?: unknown; topics?: unknown }>(responseText);
    if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) return null;

    return {
      summary: parsed.summary.trim(),
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    };
  }
}
