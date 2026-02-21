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
  toolCallId?: string;
  timestamp: number;
}

export interface ToolLoopDetectorConfig {
  /** Maximum history entries to track per session. Default: 20 */
  historySize: number;
  /** Number of repetitions before issuing a warning. Default: 8 */
  warningThreshold: number;
  /** Number of repetitions before critical alert. Default: 15 */
  criticalThreshold: number;
  /** Total no-progress calls before hard block. Default: 20 */
  circuitBreakerThreshold: number;
}

export type LoopDetectionKind = 'generic_repeat' | 'ping_pong' | 'no_progress' | 'circuit_breaker';

export interface LoopDetection {
  kind: LoopDetectionKind;
  severity: 'warning' | 'critical' | 'block';
  message: string;
  toolName: string;
  count: number;
}

const DEFAULT_CONFIG: ToolLoopDetectorConfig = {
  historySize: 20,
  warningThreshold: 3,
  criticalThreshold: 6,
  circuitBreakerThreshold: 15,
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

  constructor(config?: Partial<ToolLoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

    // Find the most recent matching record
    for (let i = records.length - 1; i >= 0; i--) {
      if (toolCallId && records[i].toolCallId === toolCallId) {
        records[i].resultHash = resultHash;
        break;
      }
      // Fallback: match the most recent record without a result hash
      if (!toolCallId && !records[i].resultHash) {
        records[i].resultHash = resultHash;
        break;
      }
    }

    // Track no-progress: same args + same result as previous call of same tool
    const lastTwo = records.filter(r => r.resultHash).slice(-2);
    if (lastTwo.length === 2 &&
        lastTwo[0].toolName === lastTwo[1].toolName &&
        lastTwo[0].argsHash === lastTwo[1].argsHash &&
        lastTwo[0].resultHash === lastTwo[1].resultHash) {
      this.noProgressCount.set(sessionId, (this.noProgressCount.get(sessionId) || 0) + 1);
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
  }

  private detectPingPong(records: ToolCallRecord[]): LoopDetection | null {
    if (records.length < 4) return null;

    // Look for A-B-A-B pattern in the most recent records
    let alternationCount = 0;
    for (let i = records.length - 1; i >= 3; i--) {
      const a1 = records[i];
      const b1 = records[i - 1];
      const a2 = records[i - 2];
      const b2 = records[i - 3];

      if (a1.toolName === a2.toolName && b1.toolName === b2.toolName &&
          a1.toolName !== b1.toolName &&
          a1.argsHash === a2.argsHash && b1.argsHash === b2.argsHash) {
        alternationCount++;
      } else {
        break;
      }
    }

    // Each alternation pair represents 2 cycles, and we checked from the end
    const cycles = alternationCount + 1; // +1 because the first 4 entries = 1 check
    const toolA = records[records.length - 1].toolName;
    const toolB = records[records.length - 2].toolName;

    if (cycles * 2 >= this.config.criticalThreshold) {
      return {
        kind: 'ping_pong',
        severity: 'critical',
        message: `Ping-pong loop detected: ${toolA} and ${toolB} alternating ${cycles * 2} times. Break the cycle — try a completely different approach.`,
        toolName: toolA,
        count: cycles * 2,
      };
    }

    if (cycles * 2 >= this.config.warningThreshold) {
      return {
        kind: 'ping_pong',
        severity: 'warning',
        message: `Ping-pong pattern: ${toolA} and ${toolB} alternating ${cycles * 2} times. Consider changing your approach.`,
        toolName: toolA,
        count: cycles * 2,
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
        severity: 'critical',
        message: `No-progress loop: ${last.toolName} called ${count} times with identical args and results. The tool is returning the same output. Stop repeating and try something else.`,
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
      if (records[i].argsHash === last.argsHash) {
        count++;
      } else {
        break;
      }
    }

    if (count >= this.config.criticalThreshold) {
      return {
        kind: 'generic_repeat',
        severity: 'critical',
        message: `Repetitive tool loop detected: ${last.toolName} called ${count} times with the same arguments. Stop repeating the same tool and try a different approach.`,
        toolName: last.toolName,
        count,
      };
    }

    if (count >= this.config.warningThreshold) {
      return {
        kind: 'generic_repeat',
        severity: 'warning',
        message: `Repetitive tool call detected: ${last.toolName} called ${count} times with the same arguments. Consider varying your approach.`,
        toolName: last.toolName,
        count,
      };
    }

    return null;
  }
}
