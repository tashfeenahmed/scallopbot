/**
 * Enhanced Tool Loop Detection
 *
 * Detects stuck tool call patterns:
 * - Generic repeat: same tool+args called repeatedly
 * - Ping-pong: A-B-A-B alternation
 * - No-progress polling: same tool+args+result repeated
 * - Circuit breaker: too many total no-progress calls
 *
 * Uses SHA-256 hashing for efficient comparison.
 */

import { createHash } from 'crypto';

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;       // SHA-256 of sorted JSON args
  resultHash?: string;    // SHA-256 of tool output (set after execution)
  /** Stable machine-readable failure family, independent of changing args. */
  failureFamily?: string;
  toolCallId?: string;
  timestamp: number;
}

export interface ToolLoopDetectorConfig {
  /** Maximum history entries to track per session. Default: 30 */
  historySize: number;
  /** Number of repetitions before issuing a warning. Default: 10 */
  warningThreshold: number;
  /** Identical no-progress repetitions before blocking. Default: 20 */
  criticalThreshold: number;
  /** Last-resort no-progress circuit breaker. Default: 30 */
  circuitBreakerThreshold: number;
}

export type LoopDetectionKind = 'generic_repeat' | 'ping_pong' | 'no_progress' | 'repeated_failure' | 'circuit_breaker';

export interface LoopDetection {
  kind: LoopDetectionKind;
  severity: 'warning' | 'critical' | 'block';
  message: string;
  toolName: string;
  count: number;
}

const DEFAULT_CONFIG: ToolLoopDetectorConfig = {
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  circuitBreakerThreshold: 30,
};

/**
 * Hash a value deterministically using SHA-256.
 * Sorts object keys for stability.
 */
function stableHash(value: unknown): string {
  const json = stableStringify(value);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * Deterministic JSON.stringify that sorts object keys.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return '{' + parts.join(',') + '}';
}

export class ToolLoopDetector {
  private config: ToolLoopDetectorConfig;
  private history: Map<string, ToolCallRecord[]> = new Map();
  private noProgressCount: Map<string, number> = new Map();
  private repeatedFailure: Map<string, { family: string; count: number }> = new Map();

  constructor(config?: Partial<ToolLoopDetectorConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    const warningThreshold = Math.max(1, Math.floor(merged.warningThreshold));
    const criticalThreshold = Math.max(warningThreshold + 1, Math.floor(merged.criticalThreshold));
    this.config = {
      historySize: Math.max(criticalThreshold, Math.floor(merged.historySize)),
      warningThreshold,
      criticalThreshold,
      circuitBreakerThreshold: Math.max(
        criticalThreshold + 1,
        Math.floor(merged.circuitBreakerThreshold),
      ),
    };
  }

  /**
   * Record a tool call before execution.
   */
  recordToolCall(
    sessionId: string,
    toolName: string,
    args: unknown,
    toolCallId?: string
  ): void {
    const records = this.history.get(sessionId) || [];
    records.push({
      toolName,
      argsHash: stableHash(args),
      toolCallId,
      timestamp: Date.now(),
    });

    // Keep bounded
    if (records.length > this.config.historySize) {
      records.splice(0, records.length - this.config.historySize);
    }

    this.history.set(sessionId, records);
  }

  /**
   * Record the outcome of a tool call (after execution).
   */
  recordToolOutcome(sessionId: string, toolCallId: string | undefined, result: string): void {
    const records = this.history.get(sessionId);
    if (!records) return;

    const resultHash = stableHash(result);
    const typed = result.match(/\[TOOL_ERROR\s+code=([A-Z0-9_:-]+)\]/i)?.[1]?.toUpperCase();
    const plainError = result.match(/^Error:\s*([^\n.]{1,120})/i)?.[1]
      ?.toLowerCase()
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
    const failureFamily = typed ?? (plainError ? `PLAIN:${plainError}` : undefined);

    // Find the most recent matching record
    for (let i = records.length - 1; i >= 0; i--) {
      if (toolCallId && records[i].toolCallId === toolCallId) {
        records[i].resultHash = resultHash;
        records[i].failureFamily = failureFamily;
        break;
      }
      // Fallback: match the most recent record without a result hash
      if (!toolCallId && !records[i].resultHash) {
        records[i].resultHash = resultHash;
        records[i].failureFamily = failureFamily;
        break;
      }
    }

    // Track a consecutive no-progress streak. A changed call or result proves
    // progress and resets the global breaker instead of permanently poisoning
    // the rest of a long, useful turn.
    const lastTwo = records.filter(r => r.resultHash).slice(-2);
    if (lastTwo.length === 2 &&
        lastTwo[0].toolName === lastTwo[1].toolName &&
        lastTwo[0].argsHash === lastTwo[1].argsHash &&
        lastTwo[0].resultHash === lastTwo[1].resultHash) {
      this.noProgressCount.set(sessionId, (this.noProgressCount.get(sessionId) || 0) + 1);
    } else {
      this.noProgressCount.set(sessionId, 0);
    }

    if (failureFamily) {
      const prior = this.repeatedFailure.get(sessionId);
      this.repeatedFailure.set(sessionId, {
        family: failureFamily,
        count: prior?.family === failureFamily ? prior.count + 1 : 1,
      });
    } else {
      this.repeatedFailure.delete(sessionId);
    }
  }

  /**
   * Detect loop patterns. Returns the most severe detection, or null.
   * Checked in priority order: circuit_breaker > ping_pong > no_progress > generic_repeat.
   */
  detect(sessionId: string): LoopDetection | null {
    const records = this.history.get(sessionId);
    if (!records || records.length < 3) return null;

    // 1. Circuit breaker
    const noProgress = this.noProgressCount.get(sessionId) || 0;
    if (noProgress >= this.config.circuitBreakerThreshold) {
      return {
        kind: 'circuit_breaker',
        severity: 'block',
        message: `Circuit breaker: ${noProgress} no-progress tool calls detected. The agent appears stuck. Try a different approach or ask the user for help.`,
        toolName: records[records.length - 1].toolName,
        count: noProgress,
      };
    }

    // A model changing commands does not constitute progress when the
    // execution boundary rejects every attempt for the same reason.
    const repeatedFailure = this.repeatedFailure.get(sessionId);
    if (repeatedFailure && repeatedFailure.count >= 6) {
      return {
        kind: 'repeated_failure',
        severity: 'block',
        message: `Repeated failure circuit breaker: ${repeatedFailure.count} consecutive tool calls failed with ${repeatedFailure.family}. Stop retrying, explain the blocker, and ask only for the missing authorization or input.`,
        toolName: records.at(-1)!.toolName,
        count: repeatedFailure.count,
      };
    }
    if (repeatedFailure && repeatedFailure.count >= 3) {
      return {
        kind: 'repeated_failure',
        severity: 'warning',
        message: `The last ${repeatedFailure.count} tool calls failed with the same ${repeatedFailure.family} error. Do not reinterpret this as cached or empty output; change the blocking condition before retrying.`,
        toolName: records.at(-1)!.toolName,
        count: repeatedFailure.count,
      };
    }

    // 2. Ping-pong: A-B-A-B alternation
    const pingPong = this.detectPingPong(records);
    if (pingPong) return pingPong;

    // 3. No-progress polling: same tool+args+result
    const noProgressDetection = this.detectNoProgress(records);
    if (noProgressDetection) return noProgressDetection;

    // 4. Generic repeat: same argsHash repeated
    const genericRepeat = this.detectGenericRepeat(records);
    if (genericRepeat) return genericRepeat;

    return null;
  }

  /**
   * Clear state for a session (e.g., when session ends).
   */
  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.noProgressCount.delete(sessionId);
    this.repeatedFailure.delete(sessionId);
  }

  private detectPingPong(records: ToolCallRecord[]): LoopDetection | null {
    if (records.length < 4) return null;

    const signature = (record: ToolCallRecord) => `${record.toolName}:${record.argsHash}`;
    const current = signature(records.at(-1)!);
    const previous = signature(records.at(-2)!);
    if (current === previous) return null;

    const tail: ToolCallRecord[] = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const expected = tail.length % 2 === 0 ? current : previous;
      if (signature(records[i]) !== expected) break;
      tail.push(records[i]);
    }
    if (tail.length < 4) return null;

    const outcomesBySignature = new Map<string, Set<string>>();
    let allOutcomesKnown = true;
    for (const record of tail) {
      if (!record.resultHash) {
        allOutcomesKnown = false;
        continue;
      }
      const outcomes = outcomesBySignature.get(signature(record)) ?? new Set<string>();
      outcomes.add(record.resultHash);
      outcomesBySignature.set(signature(record), outcomes);
    }
    const noProgressEvidence = allOutcomesKnown
      && outcomesBySignature.size === 2
      && [...outcomesBySignature.values()].every((outcomes) => outcomes.size === 1);
    const toolA = records.at(-1)!.toolName;
    const toolB = records.at(-2)!.toolName;

    if (tail.length >= this.config.criticalThreshold && noProgressEvidence) {
      return {
        kind: 'ping_pong',
        severity: 'block',
        message: `No-progress ping-pong loop: ${toolA} and ${toolB} returned the same outcomes across ${tail.length} alternating calls. Stop and report the blockage.`,
        toolName: toolA,
        count: tail.length,
      };
    }

    if (tail.length >= this.config.warningThreshold) {
      return {
        kind: 'ping_pong',
        severity: 'warning',
        message: `Ping-pong pattern: ${toolA} and ${toolB} alternated ${tail.length} times. Continue only if the results are changing and the task is progressing.`,
        toolName: toolA,
        count: tail.length,
      };
    }

    return null;
  }

  private detectNoProgress(records: ToolCallRecord[]): LoopDetection | null {
    // Count consecutive records at the end with same tool+args+result
    const last = records[records.length - 1];
    if (!last.resultHash) return null;

    let count = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].toolName === last.toolName &&
          records[i].argsHash === last.argsHash &&
          records[i].resultHash === last.resultHash) {
        count++;
      } else {
        break;
      }
    }

    if (count >= this.config.criticalThreshold) {
      return {
        kind: 'no_progress',
        severity: 'block',
        message: `No-progress loop: ${last.toolName} returned the same result for the same arguments ${count} times. Stop and report the blockage.`,
        toolName: last.toolName,
        count,
      };
    }

    if (count >= this.config.warningThreshold) {
      return {
        kind: 'no_progress',
        severity: 'warning',
        message: `No-progress detected: ${last.toolName} called ${count} times with same args and results. Consider a different approach.`,
        toolName: last.toolName,
        count,
      };
    }

    return null;
  }

  private detectGenericRepeat(records: ToolCallRecord[]): LoopDetection | null {
    const last = records[records.length - 1];
    let count = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].toolName === last.toolName && records[i].argsHash === last.argsHash) {
        count++;
      } else {
        break;
      }
    }

    if (count >= this.config.warningThreshold) {
      return {
        kind: 'generic_repeat',
        severity: 'warning',
        message: `Repetitive tool call: ${last.toolName} used the same arguments ${count} times. Continue only if its results are changing; otherwise change approach.`,
        toolName: last.toolName,
        count,
      };
    }

    return null;
  }
}
