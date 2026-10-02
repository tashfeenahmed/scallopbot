/**
 * ScallopBench types.
 *
 * A task seeds a fresh workspace, sends one or more user turns to the real
 * Agent, and is scored from the workspace state and the recorded trace —
 * never from the model's own claims about what it did.
 *
 * Two scoring modes (see BASELINES.md):
 * - default: ScallopBot's own regression mode. A few trap scorers also look
 *   at the trace (which tool ran, how often), because that is the waste
 *   pattern they reproduce.
 * - cross-agent (`crossAgent: true`): outcome only. Every scorer judges the
 *   workspace and the user-visible reply, never tool names or call counts,
 *   so agents with different tool sets are judged identically. Process
 *   signals are still reported, as efficiency metrics, not pass/fail.
 */

export type TaskCategory = 'trap' | 'coding' | 'assistant' | 'hard';

export interface ScoreContext {
  /** Outcome-only scoring: never pass/fail on tool names or tool-call counts. */
  crossAgent: boolean;
}

/** Process signals reported next to pass/fail (lower is usually better). Never part of the score. */
export type EfficiencyMetrics = Record<string, number>;

/** One tool call as a reference solution (or a scripted model) would emit it. */
export interface ReferenceCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * A known-good solution, used two ways:
 * - the `scripted` provider replays it through the real Agent (CI smoke);
 * - the scorer self-check runs it straight through the real skills, with no
 *   Agent in between, to prove the scorer accepts a correct solution.
 */
export interface ReferenceTurn {
  /** Each inner array is one model response (calls in it run as one batch). */
  steps: ReferenceCall[][];
  /** Final text reply for the turn. */
  reply: string;
}

export interface BenchTask {
  id: string;
  category: TaskCategory;
  /** Short description of the waste pattern / skill the task probes. */
  title: string;
  /** User turns, sent in order to the same session. */
  prompt: string[];
  /** Seed the workspace (absolute path to an empty temp dir). */
  setup(workspace: string): Promise<void> | void;
  /**
   * Score from workspace state + trace. Must not trust the reply's claims.
   * With `context.crossAgent` it may only read the workspace and the replies.
   */
  score(workspace: string, trace: TaskTrace, context: ScoreContext): Promise<ScoreResult> | ScoreResult;
  /** Task-specific process metrics (e.g. tool rounds for a parallel-lookup task). */
  efficiency?(trace: TaskTrace): EfficiencyMetrics;
  /** One entry per prompt turn. */
  reference: ReferenceTurn[];
  /** Optional per-task wall-clock cap in ms (default from the CLI). */
  timeoutMs?: number;
}

export interface ScoreResult {
  pass: boolean;
  details: string;
}

/** One provider.complete() call, as seen by the tracing wrapper. */
export interface LlmCallTrace {
  turn: number;
  purpose: string;
  /** Whether tools were offered (main agent loop calls offer tools). */
  withTools: boolean;
  startedAt: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** False when the provider does not report cache reads at all (so 0 means "unknown"). */
  cacheReported: boolean;
  reasoningTokens: number;
  stopReason: string;
  model: string;
  /** Tool calls the model asked for in this response. */
  toolUses: string[];
  error?: string;
}

export interface ToolCallTrace {
  turn: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Undefined when the agent never produced a result for the call. */
  isError?: boolean;
  /** Result text, truncated. */
  result?: string;
  /** True when the result is a gate/safety refusal rather than a tool failure. */
  blocked?: boolean;
}

export interface TurnTrace {
  turn: number;
  userMessage: string;
  response: string;
  completionReason: string;
  iterationsUsed: number;
  /** processMessage wall time; equals time-to-first-reply until streaming lands. */
  totalMs: number;
  timeToFirstReplyMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCalls: number;
  toolErrors: number;
  blockedCalls: number;
  /** ProgressCallback counts (only tools that reached dispatch). */
  progressToolStarts: number;
  progressToolErrors: number;
  /** "[System: ...]" nudges the agent injected into the session this turn. */
  systemNudges: number;
  cannedRefusal: boolean;
  pendingApproval?: string;
  error?: string;
}

export interface TaskTrace {
  turns: TurnTrace[];
  llmCalls: LlmCallTrace[];
  toolCalls: ToolCallTrace[];
  /** Texts the agent pushed through send_message. */
  sentMessages: string[];
  /** Final reply of the last turn (convenience). */
  finalResponse: string;
  /** All replies joined (for multi-turn tasks). */
  allResponses: string;
}

export interface TaskRunResult {
  taskId: string;
  category: TaskCategory;
  model: string;
  repeat: number;
  pass: boolean;
  details: string;
  durationMs: number;
  trace: TaskTrace;
  /** Process signals (tool calls, LLM calls, task-specific); reported, never scored. */
  efficiency?: EfficiencyMetrics;
  error?: string;
  /** Kept temp workspace (only with --keep). */
  workspace?: string;
}

export interface CategoryStats {
  tasks: number;
  passed: number;
  passRate: number;
}

export interface ModelScorecard {
  model: string;
  /** Scoring mode the results were judged in. */
  scoring?: 'default' | 'cross-agent';
  runs: number;
  passed: number;
  passRate: number;
  byCategory: Partial<Record<TaskCategory, CategoryStats>>;
  userTurns: number;
  meanLlmCallsPerTurn: number;
  meanInputTokensPerTurn: number;
  meanOutputTokensPerTurn: number;
  /** null when no call in the run reported cache reads. */
  cacheReadShare: number | null;
  meanTurnLatencyMs: number;
  medianTurnLatencyMs: number;
  meanTimeToFirstReplyMs: number;
  toolCalls: number;
  toolErrorRate: number;
  blockedCalls: number;
  cannedRefusals: number;
  systemNudges: number;
  completionReasons: Record<string, number>;
  llmCallsByPurpose: Record<string, number>;
  /** Mean tool calls and LLM calls per task run (efficiency, not part of the score). */
  meanToolCallsPerTask?: number;
  meanLlmCallsPerTask?: number;
}
