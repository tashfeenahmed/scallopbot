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

const SESSION_SUMMARY_PROMPT = `Summarize this conversation in 2-3 concise sentences. Focus on:
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
      return true;
    } catch (err) {
      this.logger.warn({ error: (err as Error).message, sessionId }, 'Session summarization failed');
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
    // Build conversation text (cap at ~4000 chars to keep LLM call cheap)
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

      const line = `${role}: ${text.substring(0, 500)}\n`;
      if (conversationText.length + line.length > 4000) break;
      conversationText += line;
    }

    const prompt = SESSION_SUMMARY_PROMPT + conversationText;

    const response = await this.provider.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 300,
    });

    const responseText = Array.isArray(response.content)
      ? response.content.map(block => 'text' in block ? block.text : '').join('')
      : String(response.content);

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; topics?: string[] };
    if (!parsed.summary) return null;

    return {
      summary: parsed.summary,
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    };
  }
}
