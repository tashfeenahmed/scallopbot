/**
 * LLM trace tap — records structured LLM calls for fine-tune dataset building.
 *
 * Every provider registered in the ProviderRegistry is wrapped with a Proxy
 * that intercepts `complete()`. Calls carrying a `purpose` tag (set at the
 * call site via CompletionRequest.purpose), or calls that include tool
 * definitions (implicitly `tool_call`), are persisted to the `llm_traces`
 * table. Untagged, tool-less calls (plain chat) pass through unrecorded.
 *
 * The sink is injected lazily (the gateway creates providers before the
 * memory store/DB exists); traces before injection are silently dropped.
 * Recording is strictly best-effort — a sink failure must never break the
 * actual LLM call path.
 */

import type { LLMProvider, CompletionRequest, CompletionResponse } from '../providers/types.js';
import { extractJSON, extractResponseText } from '../proactive/proactive-utils.js';
import { getModelTokenLimits } from './model-limits.js';
import { redactSensitiveText } from '../security/redaction.js';

/** Purposes whose responses are expected to be parseable JSON. */
const JSON_PURPOSES = new Set([
  'fact_extract',
  'memory_manage',
  'relation_classify',
  'rerank',
  'session_summary',
]);

/** Cap stored prompt/response sizes — guards against pathological rows on the Pi SD card. */
const MAX_FIELD_BYTES = 256 * 1024;

export interface LlmTraceRow {
  ts: number;
  purpose: string;
  model: string;
  provider: string;
  prompt: string;
  response: string;
  parsedOk: number;
  sessionId: string | null;
  latencyMs: number;
  stopReason: CompletionResponse['stopReason'];
  requestMaxTokens: number | null;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number;
}

export type TraceSink = (row: LlmTraceRow) => void;

let activeSink: TraceSink | null = null;

/** Inject (or clear) the persistence sink. Called by the gateway once the DB exists. */
export function setTraceSink(sink: TraceSink | null): void {
  activeSink = sink;
}

/** Textual tool-call markup that indicates the model TRIED to call a tool but
 *  emitted it as text instead of a structured tool_calls block. These are the
 *  parse failures the fine-tune is meant to eliminate. */
const TEXTUAL_TOOL_CALL_RE = /<function_calls>|<tool_call>|<invoke\b|"tool_calls"\s*:|^\s*\{\s*"name"\s*:\s*"[a-z_]+"\s*,\s*"(arguments|input|parameters)"/im;

function computeParsedOk(purpose: string, response: CompletionResponse): number {
  if (JSON_PURPOSES.has(purpose)) {
    const text = extractResponseText(response.content);
    return extractJSON(text) !== null ? 1 : 0;
  }
  if (purpose === 'tool_call') {
    const blocks = Array.isArray(response.content) ? response.content : [];
    const hasStructuredToolUse = blocks.some(
      (b: { type?: string }) => b.type === 'tool_use'
    );
    if (hasStructuredToolUse) return 1;
    const text = extractResponseText(response.content);
    // No structured call — fine if it's a plain answer, a failure if the text
    // contains tool-call markup the parser had to fish out.
    return TEXTUAL_TOOL_CALL_RE.test(text) ? 0 : 1;
  }
  return 1;
}

function prepareForPersistence(s: string): string {
  const redacted = redactSensitiveText(s);
  return redacted.length > MAX_FIELD_BYTES
    ? redacted.slice(0, MAX_FIELD_BYTES) + '…[truncated]'
    : redacted;
}

/** Serialize the request exactly as the model saw it (system + messages + tools). */
function serializePrompt(request: CompletionRequest): string {
  return JSON.stringify({
    system: request.system ?? null,
    messages: request.messages,
    tools: request.tools ?? null,
  });
}

function serializeResponse(response: CompletionResponse): string {
  return JSON.stringify({ content: response.content, stopReason: response.stopReason });
}

/**
 * Wrap a provider so tagged completions are recorded. Implemented as a Proxy
 * so every other property/method (name, model, characteristics, stream,
 * isAvailable, provider-specific extras) passes through untouched.
 */
export function wrapProviderWithTraceTap(provider: LLMProvider): LLMProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop !== 'complete') return Reflect.get(target, prop, receiver);

      return async function complete(request: CompletionRequest): Promise<CompletionResponse> {
        const purpose = request.purpose ?? (request.tools && request.tools.length > 0 ? 'tool_call' : undefined);
        if (!purpose || !activeSink) {
          return target.complete(request);
        }

        const started = Date.now();
        const response = await target.complete(request);
        try {
          const model = response.model || (target as { model?: string }).model || target.name;
          const limits = getModelTokenLimits({
            name: target.name,
            model,
          });
          activeSink({
            ts: started,
            purpose,
            model,
            provider: target.name,
            prompt: prepareForPersistence(serializePrompt(request)),
            response: prepareForPersistence(serializeResponse(response)),
            parsedOk: computeParsedOk(purpose, response),
            sessionId: request.traceSessionId ?? null,
            latencyMs: Date.now() - started,
            stopReason: response.stopReason,
            requestMaxTokens: request.maxTokens ?? request.thinkingBudgetTokens ?? null,
            modelContextWindowTokens: limits.contextWindowTokens,
            modelMaxOutputTokens: limits.maxOutputTokens,
          });
        } catch {
          // Tracing must never break the call path.
        }
        return response;
      };
    },
  });
}
