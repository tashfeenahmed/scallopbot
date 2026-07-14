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
import type { ScallopDatabase, SessionMessageRow, ToolOperationLedgerEntry } from './db.js';
import { completionBudgetForPurpose, charsForTokenBudget, getModelTokenLimits } from '../routing/model-limits.js';
import { extractJSON, extractResponseText } from '../proactive/proactive-utils.js';
import {
  classifySessionMessage,
  filterHumanVisibleTranscript,
} from './session-message-view.js';

export interface SessionSummarizerOptions {
  provider: LLMProvider;
  logger: Logger;
  embedder?: EmbeddingProvider;
  /** Minimum messages for a session to qualify for summarization (default: 4) */
  minMessages?: number;
  /** Hard wall-clock budget for the strict JSON provider call (default: 10s). */
  requestTimeoutMs?: number;
  /** Injectable clock for deterministic durable-backoff tests. */
  now?: () => number;
}

export interface SessionSummaryResult {
  summary: string;
  topics: string[];
}

export const SESSION_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'topics'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 12_000 },
    topics: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};

// Exported for fine-tune dataset construction (scripts/ft/).
export const SESSION_SUMMARY_PROMPT = `Summarize this conversation in 2-3 concise sentences. Focus on:
- What the user asked for / what was discussed
- Key outcomes or decisions made
- Any commitments or follow-ups mentioned

External-action provenance rules:
- An assistant statement that something was logged, saved, sent, updated,
  created, uploaded, or otherwise changed externally is only a claim.
- Treat it as verified only when that exact assistant turn is annotated with a
  successful external-operation receipt. Otherwise say the assistant reported
  it and that completion is unconfirmed.
- Never generalize one receipt into proof that every requested item succeeded.

Also extract 3-7 topic tags (short phrases) that describe what was discussed.

Respond with JSON only:
{"summary": "2-3 sentence summary", "topics": ["topic1", "topic2", ...]}

Conversation:
`;

const EXTERNAL_ACTION_CLAIM_RE = /\b(?:logged|saved|sent|updated|created|uploaded|deleted|booked|submitted|added|wrote|written|published|deployed)\b[^.!?]{0,160}\b(?:notion|tracker|dashboard|calendar|email|service|database|file|document|report|spreadsheet|github|slack|drive)\b|\b(?:notion|tracker|dashboard|calendar|email|service|database|file|document|report|spreadsheet|github|slack|drive)\b[^.!?]{0,160}\b(?:logged|saved|sent|updated|created|uploaded|deleted|booked|submitted|added|wrote|written|published|deployed)\b/i;
const PROVENANCE_QUALIFIER_RE = /\b(?:assistant reported|assistant said|unconfirmed|successful .* receipt|verified .* receipt)\b/i;

export function groundSessionSummaryExternalClaims(
  summary: string,
  operations: readonly ToolOperationLedgerEntry[],
): string {
  const sentences = summary.match(/[^.!?]+[.!?]?/g)?.map(sentence => sentence.trim()).filter(Boolean) ?? [summary];
  let replaced = false;
  const kept = sentences.filter(sentence => {
    if (!EXTERNAL_ACTION_CLAIM_RE.test(sentence) || PROVENANCE_QUALIFIER_RE.test(sentence)) return true;
    replaced = true;
    return false;
  });
  if (!replaced) return summary.trim();

  const successful = operations.filter(operation => operation.status === 'succeeded');
  const provenance = successful.length === 0
    ? 'The assistant reported an external action as complete, but no successful operation receipt is attached, so completion remains unconfirmed.'
    : `${successful.length} successful ${[...new Set(successful.map(operation => operation.toolName))].join(', ')} operation receipt${successful.length === 1 ? ' was' : 's were'} recorded, but ${successful.length === 1 ? 'it does not by itself' : 'they do not by themselves'} verify every assistant completion claim.`;
  return [...kept, provenance].join(' ').trim();
}

/**
 * Generates and stores session summaries
 */
export class SessionSummarizer {
  private provider: LLMProvider;
  private logger: Logger;
  private embedder?: EmbeddingProvider;
  private minMessages: number;
  private requestTimeoutMs: number;
  private now: () => number;
  private static readonly ROUTE = 'session_summary';

  get minimumMessageCount(): number {
    return this.minMessages;
  }

  constructor(options: SessionSummarizerOptions) {
    this.provider = options.provider;
    this.logger = options.logger.child({ component: 'session-summarizer' });
    this.embedder = options.embedder;
    this.minMessages = options.minMessages ?? 4;
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
    this.now = options.now ?? Date.now;
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
    if (existing && db.hasVerifiedSessionSummary(sessionId)) {
      this.logger.debug({ sessionId }, 'Verified session summary already exists, skipping');
      return false;
    }
    if (existing) {
      this.logger.info(
        { sessionId, priorSummaryId: existing.id },
        'Regenerating rejected session summary with lossless revision history',
      );
    }

    // Get session messages
    const sessionMetadata = db.getSession(sessionId)?.metadata;
    const messages = filterHumanVisibleTranscript(
      db.getSessionMessages(sessionId),
      { sessionMetadata },
    );
    if (messages.length < this.minMessages) {
      this.logger.debug({ sessionId, messageCount: messages.length }, 'Session too short for summary');
      return false;
    }

    // Both gates are durable. A restart therefore cannot turn a malformed
    // session—or a degraded structured-output provider—back into a tight
    // background retry loop.
    const now = this.now();
    const sessionFailure = db.getSessionSummaryFailure(sessionId);
    const routeCircuit = db.getStructuredRouteCircuit(SessionSummarizer.ROUTE);
    const retryAt = Math.max(sessionFailure?.nextRetryAt ?? 0, routeCircuit?.nextRetryAt ?? 0);
    if (retryAt > now) {
      this.logger.debug(
        {
          sessionId,
          retryAt,
          sessionFailures: sessionFailure?.failureCount ?? 0,
          routeFailures: routeCircuit?.failureCount ?? 0,
        },
        'Session summary retry is durably backed off',
      );
      return false;
    }

    try {
      const operations = db.getToolOperationsBySession(sessionId);
      const result = await this.generateSummary(messages, operations, sessionId);
      if (!result) throw new Error('session_summary_invalid_json');
      result.summary = groundSessionSummaryExternalClaims(result.summary, operations);

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

      const stored = db.upsertVerifiedSessionSummary({
        sessionId,
        userId,
        summary: result.summary,
        topics: result.topics,
        messageCount: messages.length,
        durationMs,
        embedding,
      }, {
        verifier: 'session_summarizer',
        verificationVersion: 2,
      });
      if (!stored.schemaValid || stored.verifiedAt == null) {
        throw new Error('session_summary_verification_failed');
      }

      this.logger.info(
        { sessionId, topics: result.topics, messageCount: messages.length },
        'Session summary generated'
      );
      db.clearSessionSummaryFailure(sessionId);
      db.clearStructuredRouteCircuit(SessionSummarizer.ROUTE);
      return true;
    } catch (err) {
      const errorCode = this.summaryErrorCode(err);
      const failedAt = this.now();
      const sessionState = db.recordSessionSummaryFailure(sessionId, errorCode, failedAt);
      const routeState = db.recordStructuredRouteFailure(SessionSummarizer.ROUTE, errorCode, failedAt);
      this.logger.warn(
        {
          error: (err as Error).message,
          errorCode,
          sessionId,
          attempt: sessionState.failureCount,
          nextRetryAt: Math.max(sessionState.nextRetryAt, routeState.nextRetryAt),
        },
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
  private async generateSummary(
    messages: SessionMessageRow[],
    operations: ToolOperationLedgerEntry[],
    sessionId: string,
  ): Promise<SessionSummaryResult | null> {
    const firstBudget = completionBudgetForPurpose(this.provider, 'session_summary');
    const limits = getModelTokenLimits(this.provider);
    const promptTokenBudget = Math.max(
      1000,
      Math.floor((limits.contextWindowTokens - firstBudget - 512) * 0.5)
    );
    const conversationCharLimit = Math.min(12_000, Math.max(4_000, charsForTokenBudget(promptTokenBudget)));
    const conversationText = this.buildConversationText(messages, operations, conversationCharLimit);

    const first = await this.requestSummary(conversationText, firstBudget, sessionId);
    return this.parseSummaryResponse(extractResponseText(first.content));
  }

  private buildConversationText(
    messages: SessionMessageRow[],
    operations: ToolOperationLedgerEntry[],
    maxChars: number,
  ): string {
    let conversationText = '';
    let turnStartedAt = Number.NEGATIVE_INFINITY;
    for (const msg of messages) {
      const view = classifySessionMessage(msg);
      if (!view.isHumanVisible || !view.visibleText) continue;
      const role = view.isHumanTurn ? 'User' : 'Assistant';
      const text = view.visibleText;

      if (view.isHumanTurn) turnStartedAt = msg.createdAt;
      const successfulTools = view.isHumanTurn
        ? []
        : operations.filter(operation => (
            operation.status === 'succeeded'
            && operation.updatedAt >= turnStartedAt
            && operation.updatedAt <= msg.createdAt + 5_000
          ));
      const provenance = view.isHumanTurn
        ? ''
        : successfulTools.length > 0
          ? ` [verified successful operation receipts: ${[...new Set(successfulTools.map(operation => operation.toolName))].join(', ')}]`
          : ' [no successful external-operation receipt for this reply]';

      const line = `${role}${provenance}: ${text.substring(0, 700)}\n`;
      if (conversationText.length + line.length > maxChars) break;
      conversationText += line;
    }
    return conversationText;
  }

  private async requestSummary(conversationText: string, maxTokens: number, sessionId: string) {
    const prompt = SESSION_SUMMARY_PROMPT + conversationText;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error('session_summary_timeout'));
        reject(new Error('session_summary_timeout'));
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([
        this.provider.complete({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          maxTokens,
          enableThinking: false,
          structuredOutput: {
            name: 'session_summary',
            schema: SESSION_SUMMARY_SCHEMA,
            strict: true,
          },
          signal: controller.signal,
          purpose: 'session_summary',
          traceSessionId: sessionId,
          traceMetadata: {
            conversationChars: conversationText.length,
            structuredOutput: 'json',
          },
        }),
        timedOut,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private summaryErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('session_summary_timeout')) return 'timeout';
    if (message.includes('session_summary_invalid_json')) return 'invalid_json';
    if (message.includes('session_summary_verification_failed')) return 'verification_failed';
    return 'provider_error';
  }

  private parseSummaryResponse(responseText: string): SessionSummaryResult | null {
    const parsed = extractJSON<{ summary?: unknown; topics?: unknown }>(responseText);
    if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) return null;
    if (!Array.isArray(parsed.topics)
      || parsed.topics.length < 1
      || parsed.topics.length > 20
      || !parsed.topics.every(topic => (
        typeof topic === 'string' && topic.trim().length > 0 && topic.trim().length <= 100
      ))) return null;

    return {
      summary: parsed.summary.trim(),
      topics: parsed.topics.map(topic => (topic as string).trim()),
    };
  }
}
