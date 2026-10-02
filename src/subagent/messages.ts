/**
 * Harness message headers for delegated work.
 *
 * Every message the harness injects into a parent conversation starts with a
 * `[kind: qualifier]` header so the model never mistakes it for the user:
 *
 *   [agent-result: <name>] (self-report — verify before relying on it)
 *   [agent-exited: no-reply <name>]
 *   [agent-progress: <name>]
 *
 * Child reports are capped at min(24k chars, 50% of the parent's remaining
 * context room). Anything over the cap stays in the report file and the
 * parent gets the path, so it can read_file the rest only if it needs to.
 */

import type { AnnounceEntry } from './types.js';

/** Hard ceiling for a child report injected into the parent (Hermes: 24k). */
export const AGENT_RESULT_MAX_CHARS = 24_000;
/** Never squeeze a report below this, even when the parent is nearly full. */
export const AGENT_RESULT_MIN_CHARS = 1_000;
/** How much of a dead child's last text the parent sees. */
export const AGENT_EXIT_TAIL_CHARS = 2_000;

export const SELF_REPORT_LABEL = '(self-report — verify before relying on it)';

/** Text returned to the parent by spawn_agent. */
export const SPAWN_ACK_INSTRUCTION =
  'One-line status to the user, then end your turn — never poll or sleep; '
  + 'you will be woken with [agent-result: name] when it finishes.';

export interface ResultCapOptions {
  /**
   * Characters of context the parent still has room for. The result is capped
   * at 50% of this (and never above 24k). Defaults to 48k, so the default cap
   * is the 24k ceiling.
   */
  remainingContextChars?: number;
  /** Path to the full report file, quoted when the body is truncated. */
  reportPath?: string;
  /** Run id, appended as a footer so duplicates can be detected. */
  runId?: string;
}

export function resultCapChars(remainingContextChars?: number): number {
  if (remainingContextChars === undefined || !Number.isFinite(remainingContextChars)) {
    return AGENT_RESULT_MAX_CHARS;
  }
  const half = Math.floor(Math.max(0, remainingContextChars) / 2);
  return Math.max(AGENT_RESULT_MIN_CHARS, Math.min(AGENT_RESULT_MAX_CHARS, half));
}

function footer(opts: ResultCapOptions, truncated: boolean, totalChars: number): string {
  const parts: string[] = [];
  if (truncated) {
    parts.push(opts.reportPath
      ? `[report truncated at ${totalChars} chars — the full report is at ${opts.reportPath}; read_file it only if you need the rest]`
      : `[report truncated — ${totalChars} chars total]`);
  } else if (opts.reportPath) {
    parts.push(`[full report: ${opts.reportPath}]`);
  }
  if (opts.runId) parts.push(`[run ${opts.runId}]`);
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}

function capBody(body: string, cap: number): { text: string; truncated: boolean } {
  if (body.length <= cap) return { text: body, truncated: false };
  return { text: `${body.slice(0, cap).trimEnd()}\n…`, truncated: true };
}

/** `[agent-result: <name>] (self-report — verify before relying on it)\n<report>` */
export function formatAgentResult(name: string, report: string, opts: ResultCapOptions = {}): string {
  const body = report.trim() || '(the agent finished with an empty report)';
  const { text, truncated } = capBody(body, resultCapChars(opts.remainingContextChars));
  return `[agent-result: ${name}] ${SELF_REPORT_LABEL}\n${text}${footer(opts, truncated, body.length)}`;
}

/**
 * `[agent-exited: no-reply <name>]\n<tail of child's last text>` — the child
 * finished without a final answer, crashed, timed out or was cancelled.
 */
export function formatAgentExited(
  name: string,
  lastText: string,
  opts: ResultCapOptions & { reason?: string } = {},
): string {
  const tail = lastText.trim()
    ? lastText.trim().length > AGENT_EXIT_TAIL_CHARS
      ? `…${lastText.trim().slice(-AGENT_EXIT_TAIL_CHARS)}`
      : lastText.trim()
    : '(no text from the agent)';
  const reason = opts.reason ? `Reason: ${opts.reason}\n` : '';
  const tailCap = resultCapChars(opts.remainingContextChars);
  const { text } = capBody(`${reason}Last text:\n${tail}`, tailCap);
  return `[agent-exited: no-reply ${name}]\n${text}${footer({ ...opts, reportPath: opts.reportPath }, false, 0)}`;
}

/** `[agent-progress: <name>] <note>` — informational, never wakes the parent. */
export function formatAgentProgress(name: string, note: string): string {
  return `[agent-progress: ${name}] ${note.trim()}`;
}

/**
 * Format a drained announce entry for injection into the parent conversation.
 * This is what agent.ts should use instead of its own 2000-char truncation.
 */
export function formatAnnounceEntry(entry: AnnounceEntry, opts: { remainingContextChars?: number } = {}): string {
  const name = entry.label;
  if (entry.kind === 'agent-progress') {
    return formatAgentProgress(name, entry.progressNote ?? entry.result.summary);
  }
  if (entry.kind === 'agent-exited') {
    return formatAgentExited(name, entry.lastText ?? entry.result.summary, {
      reason: entry.exitReason,
      reportPath: entry.reportPath,
      runId: entry.runId,
      remainingContextChars: opts.remainingContextChars,
    });
  }
  return formatAgentResult(name, entry.report ?? entry.result.response ?? entry.result.summary, {
    reportPath: entry.reportPath,
    runId: entry.runId,
    remainingContextChars: opts.remainingContextChars,
  });
}

/** True for any harness-injected `[kind: qualifier]` message (not from the user). */
export function isHarnessMessage(text: string): boolean {
  return /^\s*\[(?:agent-(?:result|exited|progress)|bash-done|heartbeat|reminder|steering|wake)\b[^\]]*\]/i.test(text)
    || /^\s*\[Sub-agent\b/.test(text);
}
