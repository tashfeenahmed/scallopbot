/** Aggregate task runs into per-model scorecards and render them. */

import type { CategoryStats, ModelScorecard, TaskCategory, TaskRunResult } from './types.js';

const CATEGORIES: TaskCategory[] = ['trap', 'coding', 'assistant'];

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function buildScorecard(model: string, results: TaskRunResult[]): ModelScorecard {
  const byCategory: Partial<Record<TaskCategory, CategoryStats>> = {};
  for (const category of CATEGORIES) {
    const runs = results.filter(r => r.category === category);
    if (!runs.length) continue;
    const passed = runs.filter(r => r.pass).length;
    byCategory[category] = { tasks: runs.length, passed, passRate: passed / runs.length };
  }
  const turns = results.flatMap(r => r.trace.turns);
  const calls = results.flatMap(r => r.trace.llmCalls);
  const toolCalls = results.flatMap(r => r.trace.toolCalls);
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const cachedTokens = calls.reduce((sum, call) => sum + call.cachedInputTokens, 0);
  const completionReasons: Record<string, number> = {};
  for (const turn of turns) completionReasons[turn.completionReason] = (completionReasons[turn.completionReason] ?? 0) + 1;
  const llmCallsByPurpose: Record<string, number> = {};
  for (const call of calls) llmCallsByPurpose[call.purpose] = (llmCallsByPurpose[call.purpose] ?? 0) + 1;
  const passed = results.filter(r => r.pass).length;

  return {
    model,
    runs: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    byCategory,
    userTurns: turns.length,
    meanLlmCallsPerTurn: mean(turns.map(t => t.llmCalls)),
    meanInputTokensPerTurn: mean(turns.map(t => t.inputTokens)),
    meanOutputTokensPerTurn: mean(turns.map(t => t.outputTokens)),
    cacheReadShare: calls.some(call => call.cacheReported) && inputTokens > 0 ? cachedTokens / inputTokens : null,
    meanTurnLatencyMs: mean(turns.map(t => t.totalMs)),
    medianTurnLatencyMs: median(turns.map(t => t.totalMs)),
    meanTimeToFirstReplyMs: mean(turns.map(t => t.timeToFirstReplyMs)),
    toolCalls: toolCalls.length,
    toolErrorRate: toolCalls.length ? toolCalls.filter(c => c.isError).length / toolCalls.length : 0,
    blockedCalls: toolCalls.filter(c => c.blocked).length,
    cannedRefusals: turns.filter(t => t.cannedRefusal).length,
    systemNudges: turns.reduce((sum, t) => sum + t.systemNudges, 0),
    completionReasons,
    llmCallsByPurpose,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatScorecard(card: ModelScorecard, results: TaskRunResult[]): string {
  const lines: string[] = [];
  lines.push(`== ScallopBench · ${card.model} ==`);
  lines.push(`pass rate           ${pct(card.passRate)} (${card.passed}/${card.runs})`);
  for (const category of CATEGORIES) {
    const stats = card.byCategory[category];
    if (stats) lines.push(`  ${category.padEnd(18)}${pct(stats.passRate)} (${stats.passed}/${stats.tasks})`);
  }
  lines.push(`LLM calls / turn    ${card.meanLlmCallsPerTurn.toFixed(2)}   by purpose: ${Object.entries(card.llmCallsByPurpose).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push(`input tok / turn    ${Math.round(card.meanInputTokensPerTurn)}   output tok / turn ${Math.round(card.meanOutputTokensPerTurn)}`);
  lines.push(`cache-read share    ${card.cacheReadShare === null ? 'n/a (provider does not report cache reads)' : pct(card.cacheReadShare)}`);
  lines.push(`turn latency        mean ${secs(card.meanTurnLatencyMs)}  median ${secs(card.medianTurnLatencyMs)}  first reply ${secs(card.meanTimeToFirstReplyMs)}`);
  lines.push(`tool calls          ${card.toolCalls}   error rate ${pct(card.toolErrorRate)}   gate-blocked ${card.blockedCalls}`);
  lines.push(`canned refusals     ${card.cannedRefusals}   [System:] nudges ${card.systemNudges}`);
  lines.push(`stop reasons        ${Object.entries(card.completionReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push('');
  for (const result of results) {
    const turns = result.trace.turns;
    const calls = turns.reduce((sum, t) => sum + t.llmCalls, 0);
    const tools = result.trace.toolCalls.length;
    lines.push(
      `  ${result.pass ? 'PASS' : 'FAIL'}  ${result.taskId.padEnd(30)} ${String(calls).padStart(3)} calls ${String(tools).padStart(3)} tools ${secs(result.durationMs).padStart(7)}  ${result.details}`,
    );
  }
  return lines.join('\n');
}
