/**
 * Enhanced Tool Loop Detection
 *
 * Detects stuck tool call patterns:
 * - Generic repeat: same tool+args called repeatedly
 * - Ping-pong: A-B-A-B alternation
 * - No-progress polling: same tool+args+result repeated
 * - Repeated failure: the same failure family keeps coming back
 *   - 2nd failure in a family      → warning (soft system note)
 *   - 3rd identical tool+args fail → call-scoped block (that exact call is refused)
 *   - 4th failure in a family      → turn-scoped block (end the tool loop)
 * - Circuit breaker: too many total no-progress calls
 *
 * Thresholds default to values sized for an interactive chat turn, where a
 * human is waiting and three identical failures already prove the approach is
 * wrong. Uses SHA-256 hashing for efficient comparison.
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
  /** Number of repetitions before issuing a warning. Default: 3 */
  warningThreshold: number;
  /** Identical no-progress repetitions before blocking. Default: 5 */
  criticalThreshold: number;
  /** Last-resort no-progress circuit breaker. Default: 8 */
  circuitBreakerThreshold: number;
  /** Failures of one family (any args) before a warning. Default: 2 */
  failureWarningThreshold: number;
  /** Failures of the exact same tool+args before that call is refused. Default: 3 */
  identicalFailureBlockThreshold: number;
  /** Failures of one family (any args) in a turn before the loop ends. Default: 4 */
  failureFamilyBreakerThreshold: number;
}

export type LoopDetectionKind = 'generic_repeat' | 'ping_pong' | 'no_progress' | 'repeated_failure' | 'circuit_breaker';

export interface LoopDetection {
  kind: LoopDetectionKind;
  severity: 'warning' | 'critical' | 'block';
  /**
   * What a `block` applies to. `turn` (default) ends the tool loop; `call`
   * only refuses further dispatch of the exact tool+args that keeps failing
   * and lets the model change its arguments or stop.
   */
  scope?: 'call' | 'turn';
  message: string;
  toolName: string;
  count: number;
}

export interface IdenticalFailureBlock {
  toolName: string;
  count: number;
  failureFamily: string;
}

/**
 * Typed error codes the agent emits when it refuses a call itself (identical
 * call already failed, policy escalation). They continue the family of the
 * failure that caused them instead of starting a fresh, unrelated family, so
 * refusing an identical retry still counts toward the per-turn breaker.
 */
const CARRIED_FAILURE_CODES = new Set(['IDENTICAL_CALL_BLOCKED', 'BLOCKED_ESCALATION']);

const DEFAULT_CONFIG: ToolLoopDetectorConfig = {
  historySize: 30,
  warningThreshold: 3,
  criticalThreshold: 5,
  circuitBreakerThreshold: 8,
  failureWarningThreshold: 2,
  identicalFailureBlockThreshold: 3,
  failureFamilyBreakerThreshold: 4,
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

/** Extract a stable failure family from a tool result, or undefined on success. */
export function failureFamilyOf(result: string): string | undefined {
  const typed = result.match(/\[TOOL_ERROR\s+code=([A-Z0-9_:-]+)\]/i)?.[1]?.toUpperCase();
  if (typed) return typed;
  const plainError = result.match(/^Error:\s*([^\n.]{1,120})/i)?.[1]
    ?.toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return plainError ? `PLAIN:${plainError}` : undefined;
}

export class ToolLoopDetector {
  private config: ToolLoopDetectorConfig;
  private history: Map<string, ToolCallRecord[]> = new Map();
  private noProgressCount: Map<string, number> = new Map();
  /** Consecutive failures of one family (reset by any success). */
  private repeatedFailure: Map<string, { family: string; count: number }> = new Map();
  /** Cumulative failures per family within the session/turn (reset only by clearSession). */
  private failureTotals: Map<string, Map<string, number>> = new Map();
  /** Cumulative failures per exact tool+args within the session/turn. */
  private identicalFailures: Map<string, Map<string, { toolName: string; count: number; family: string }>> = new Map();

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
      failureWarningThreshold: Math.max(1, Math.floor(merged.failureWarningThreshold)),
      identicalFailureBlockThreshold: Math.max(1, Math.floor(merged.identicalFailureBlockThreshold)),
      failureFamilyBreakerThreshold: Math.max(1, Math.floor(merged.failureFamilyBreakerThreshold)),
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
    let failureFamily = failureFamilyOf(result);
    // A refusal the agent itself issued because of an earlier failure belongs
    // to that earlier failure's family.
    if (failureFamily && CARRIED_FAILURE_CODES.has(failureFamily)) {
      failureFamily = this.repeatedFailure.get(sessionId)?.family ?? failureFamily;
    }

    // Find the most recent matching record
    let matched: ToolCallRecord | undefined;
    for (let i = records.length - 1; i >= 0; i--) {
      if (toolCallId && records[i].toolCallId === toolCallId) {
        matched = records[i];
        break;
      }
      // Fallback: match the most recent record without a result hash
      if (!toolCallId && !records[i].resultHash) {
        matched = records[i];
        break;
      }
    }
    if (matched) {
      matched.resultHash = resultHash;
      matched.failureFamily = failureFamily;
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

      const totals = this.failureTotals.get(sessionId) ?? new Map<string, number>();
      totals.set(failureFamily, (totals.get(failureFamily) ?? 0) + 1);
      this.failureTotals.set(sessionId, totals);

      if (matched) {
        const key = `${matched.toolName}:${matched.argsHash}`;
        const identical = this.identicalFailures.get(sessionId) ?? new Map();
        const prev = identical.get(key);
        identical.set(key, {
          toolName: matched.toolName,
          count: (prev?.count ?? 0) + 1,
          family: failureFamily,
        });
        this.identicalFailures.set(sessionId, identical);
      }
    } else {
      // A success proves the approach can change; the soft warning streak
      // resets, but per-turn totals keep counting toward the breaker.
      this.repeatedFailure.delete(sessionId);
    }
  }

  /**
   * Whether this exact tool+args has already failed enough times in the turn
   * that the agent must refuse to dispatch it again.
   */
  isCallBlocked(sessionId: string, toolName: string, args: unknown): IdenticalFailureBlock | null {
    const entry = this.identicalFailures.get(sessionId)?.get(`${toolName}:${stableHash(args)}`);
    if (!entry || entry.count < this.config.identicalFailureBlockThreshold) return null;
    return { toolName: entry.toolName, count: entry.count, failureFamily: entry.family };
  }

  /**
   * Detect loop patterns. Returns the most severe detection, or null.
   * Checked in priority order: circuit_breaker > repeated_failure > ping_pong > no_progress > generic_repeat.
   */
  detect(sessionId: string): LoopDetection | null {
    const records = this.history.get(sessionId);
    if (!records || records.length === 0) return null;

    // 1. Circuit breaker
    const noProgress = this.noProgressCount.get(sessionId) || 0;
    if (noProgress >= this.config.circuitBreakerThreshold) {
      return {
        kind: 'circuit_breaker',
        severity: 'block',
        scope: 'turn',
        message: `Circuit breaker: ${noProgress} no-progress tool calls detected. The agent appears stuck. Try a different approach or ask the user for help.`,
        toolName: records[records.length - 1].toolName,
        count: noProgress,
      };
    }

    // 2. Repeated failure family. A model changing commands does not constitute
    // progress when the execution boundary rejects every attempt for the same
    // reason. Evaluated only while the latest call is itself such a failure.
    const last = records.at(-1)!;
    if (last.failureFamily) {
      const family = last.failureFamily;
      const total = this.failureTotals.get(sessionId)?.get(family) ?? 0;
      if (total >= this.config.failureFamilyBreakerThreshold) {
        return {
          kind: 'repeated_failure',
          severity: 'block',
          scope: 'turn',
          message: `Repeated failure circuit breaker: ${total} tool calls in this turn failed with ${family}. Stop retrying, explain the blocker, and ask only for the missing authorization or input.`,
          toolName: last.toolName,
          count: total,
        };
      }

      const identical = this.identicalFailures.get(sessionId)?.get(`${last.toolName}:${last.argsHash}`);
      if (identical && identical.count >= this.config.identicalFailureBlockThreshold) {
        return {
          kind: 'repeated_failure',
          severity: 'block',
          scope: 'call',
          message: `${last.toolName} failed ${identical.count} times with identical arguments (${family}). That exact call will be refused from now on; change the arguments or stop and tell the user what is missing.`,
          toolName: last.toolName,
          count: identical.count,
        };
      }

      const streak = this.repeatedFailure.get(sessionId);
      if (streak && streak.family === family && streak.count >= this.config.failureWarningThreshold) {
        return {
          kind: 'repeated_failure',
          severity: 'warning',
          message: `The last ${streak.count} tool calls failed with the same ${family} error. Do not reinterpret this as cached or empty output; change the blocking condition before retrying.`,
          toolName: last.toolName,
          count: streak.count,
        };
      }
    }

    if (records.length < 3) return null;

    // 3. Ping-pong: A-B-A-B alternation
    const pingPong = this.detectPingPong(records);
    if (pingPong) return pingPong;

    // 4. No-progress polling: same tool+args+result
    const noProgressDetection = this.detectNoProgress(records);
    if (noProgressDetection) return noProgressDetection;

    // 5. Generic repeat: same argsHash repeated
    const genericRepeat = this.detectGenericRepeat(records);
    if (genericRepeat) return genericRepeat;

    return null;
  }

  /**
   * Clear state for a session (e.g., when a turn starts or ends).
   */
  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.noProgressCount.delete(sessionId);
    this.repeatedFailure.delete(sessionId);
    this.failureTotals.delete(sessionId);
    this.identicalFailures.delete(sessionId);
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
        scope: 'turn',
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
        scope: 'turn',
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
