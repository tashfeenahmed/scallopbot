/**
 * Trace collection without touching agent.ts.
 *
 * - TracingProvider delegates every completion and records purpose, latency,
 *   token usage (including cache reads when the provider reports them), stop
 *   reason and the tool calls the model asked for.
 * - Tool calls and their results are read back from the session transcript,
 *   which also catches calls the safety gates refused before dispatch (those
 *   never reach the ProgressCallback).
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMProvider,
  Message,
  StreamEvent,
} from '../../src/providers/types.js';
import type { LlmCallTrace, ToolCallTrace } from './types.js';

/** The exact text the outcome brain substitutes when it rejects a reply. */
export const CANNED_REFUSAL_RE = /I could not produce a safe/i;

/** Tool results that are gate refusals rather than tool failures. */
export const BLOCKED_RESULT_RE =
  /\[TOOL_ERROR code=(?:SAFETY_[A-Z_]+|UNVERIFIED_[A-Z_]+|ARTIFACT_RECEIPT_REQUIRED|EVIDENCE_[A-Z_]+)\]|\bBLOCKED\b|already succeeded during the current turn|is not permitted in this session/;

const RESULT_PREVIEW_CHARS = 2_000;

export class TracingProvider implements LLMProvider {
  readonly name: string;
  readonly model?: string;
  readonly calls: LlmCallTrace[] = [];
  /** Turn index stamped onto new call records; the runner advances it. */
  turn = 0;

  constructor(private readonly inner: LLMProvider) {
    this.name = inner.name;
    this.model = inner.model;
  }

  isAvailable(): boolean {
    return this.inner.isAvailable();
  }

  get stream(): ((request: CompletionRequest) => AsyncIterable<StreamEvent>) | undefined {
    return this.inner.stream?.bind(this.inner);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startedAt = Date.now();
    const base = {
      turn: this.turn,
      purpose: request.purpose ?? (request.tools?.length ? 'tool_call' : 'untagged'),
      withTools: (request.tools?.length ?? 0) > 0,
      startedAt,
    };
    try {
      const response = await this.inner.complete(request);
      this.calls.push({
        ...base,
        latencyMs: Date.now() - startedAt,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cachedInputTokens: response.usage?.cachedInputTokens ?? 0,
        cacheReported: response.usage?.cachedInputTokens !== undefined,
        reasoningTokens: response.usage?.reasoningTokens ?? 0,
        stopReason: response.stopReason,
        model: response.model || this.inner.model || this.inner.name,
        toolUses: response.content
          .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
          .map(block => block.name),
      });
      return response;
    } catch (error) {
      this.calls.push({
        ...base,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheReported: false,
        reasoningTokens: 0,
        stopReason: 'error',
        model: this.inner.model || this.inner.name,
        toolUses: [],
        error: (error as Error).message,
      });
      throw error;
    }
  }
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Extract tool calls (with results) and injected "[System: ...]" nudges from
 * the transcript messages added during one turn.
 */
export function extractTurnTranscript(
  messages: readonly Message[],
  turn: number,
): { toolCalls: ToolCallTrace[]; systemNudges: number } {
  const calls = new Map<string, ToolCallTrace>();
  let systemNudges = 0;
  for (const message of messages) {
    if (message.role === 'user' && textOf(message.content).trimStart().startsWith('[System:')) {
      systemNudges++;
    }
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        calls.set(block.id, { turn, id: block.id, name: block.name, input: block.input ?? {} });
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id)
          ?? { turn, id: block.tool_use_id, name: 'unknown', input: {} };
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        call.isError = block.is_error === true || /^Error:/.test(content) || content.startsWith('[TOOL_ERROR');
        call.blocked = BLOCKED_RESULT_RE.test(content);
        call.result = content.length > RESULT_PREVIEW_CHARS ? `${content.slice(0, RESULT_PREVIEW_CHARS)}…` : content;
        calls.set(block.tool_use_id, call);
      }
    }
  }
  return { toolCalls: [...calls.values()], systemNudges };
}
