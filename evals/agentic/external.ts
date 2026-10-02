/**
 * Neutral task export and external scoring, so Hermes Agent, Prime Agent (or
 * anything else) can run the same tasks and be scored by the same scorers.
 * See BASELINES.md for the adapter contract.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScorecard } from './scorecard.js';
import { ALL_TASKS } from './tasks/index.js';
import { CANNED_REFUSAL_RE } from './trace.js';
import type { BenchTask, ModelScorecard, TaskRunResult, TaskTrace } from './types.js';

export const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Short commit id of the checkout the bench runs from (recorded in results). */
export function commitSha(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: BENCH_DIR, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

export const slug = (text: string) => text.replace(/[^a-zA-Z0-9.-]+/g, '_');

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child);
  }
  return files.sort();
}

/**
 * Write `<target>` (task list) and `<target minus .json>.fixtures/<task-id>/`
 * (each task's seeded workspace). Hidden tests and scorers stay here.
 */
export async function exportTasks(
  target: string,
  tasks: readonly BenchTask[] = ALL_TASKS,
): Promise<{ count: number; file: string; fixturesDir: string }> {
  const out = path.resolve(target);
  const fixturesDir = `${out.replace(/\.json$/, '')}.fixtures`;
  await rm(fixturesDir, { recursive: true, force: true });
  await mkdir(fixturesDir, { recursive: true });
  const exported = [];
  for (const task of tasks) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), `scallopbench-export-${task.id}-`));
    try {
      await task.setup(scratch);
      const files = await listFiles(scratch);
      const fixture = path.join(fixturesDir, task.id);
      await mkdir(fixture, { recursive: true });
      await cp(scratch, fixture, { recursive: true });
      const sizes = await Promise.all(files.map(async file => (await stat(path.join(scratch, file))).size));
      exported.push({
        id: task.id,
        category: task.category,
        title: task.title,
        turns: task.prompt,
        fixture: path.relative(path.dirname(out), fixture),
        files: files.map((file, i) => ({ path: file, bytes: sizes[i] })),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  await writeFile(out, `${JSON.stringify({
    bench: 'scallopbench',
    version: 1,
    commit: commitSha(),
    instructions: 'Copy each fixture dir to a fresh workspace, start the agent with that workspace as its cwd, send the turns in order in ONE session, then record the workspace path and every final reply. Score with: npm run bench:agentic -- --score <run.json>. See evals/agentic/BASELINES.md.',
    tasks: exported,
  }, null, 2)}\n`);
  return { count: exported.length, file: out, fixturesDir };
}

/** What an external adapter writes after running the exported tasks. */
export interface ExternalRun {
  /** Model id, e.g. "moonshotai/kimi-k2". */
  model: string;
  /** Agent name, e.g. "hermes" or "prime". */
  agent?: string;
  results: Array<{
    taskId: string;
    /** Workspace the agent worked in (absolute, or relative to the run file). */
    workspace: string;
    /** Final reply of each turn, in order. */
    replies: string[];
    toolCalls?: Array<{ name: string; input?: Record<string, unknown>; isError?: boolean }>;
    llmCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    durationMs?: number;
  }>;
}

/** Score an external run with the same scorers and write a results file. */
export async function scoreExternal(
  file: string,
  resultsDir: string,
): Promise<{ scorecard: ModelScorecard; results: TaskRunResult[]; file: string }> {
  const run = JSON.parse(await readFile(file, 'utf8')) as ExternalRun;
  const label = run.agent ? `${run.agent}:${run.model}` : run.model;
  const results: TaskRunResult[] = [];
  for (const entry of run.results) {
    const task = ALL_TASKS.find(t => t.id === entry.taskId);
    if (!task) throw new Error(`unknown task ${entry.taskId}`);
    const turnCount = Math.max(entry.replies.length, 1);
    const per = (value: number | undefined) => Math.round((value ?? 0) / turnCount);
    const toolCalls = (entry.toolCalls ?? []).map((call, i) => ({
      turn: 0, id: `ext-${i}`, name: call.name, input: call.input ?? {}, isError: call.isError,
    }));
    const trace: TaskTrace = {
      turns: entry.replies.map((response, turn) => ({
        turn, userMessage: task.prompt[turn] ?? '', response, completionReason: 'external', iterationsUsed: 0,
        totalMs: per(entry.durationMs), timeToFirstReplyMs: per(entry.durationMs), llmCalls: per(entry.llmCalls),
        inputTokens: per(entry.inputTokens), outputTokens: per(entry.outputTokens),
        cachedInputTokens: per(entry.cachedInputTokens),
        toolCalls: turn === 0 ? toolCalls.length : 0,
        toolErrors: turn === 0 ? toolCalls.filter(call => call.isError).length : 0,
        blockedCalls: 0, progressToolStarts: 0, progressToolErrors: 0, systemNudges: 0,
        cannedRefusal: CANNED_REFUSAL_RE.test(response),
      })),
      llmCalls: [],
      toolCalls,
      sentMessages: [],
      finalResponse: entry.replies[entry.replies.length - 1] ?? '',
      allResponses: entry.replies.join('\n\n'),
    };
    const score = await task.score(path.resolve(path.dirname(file), entry.workspace), trace);
    results.push({
      taskId: task.id, category: task.category, model: label, repeat: 0, pass: score.pass, details: score.details,
      durationMs: entry.durationMs ?? 0, trace,
    });
  }
  const scorecard = buildScorecard(label, results);
  const out = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(label)}-external.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ bench: 'scallopbench', version: 1, model: label, external: true, scorecard, results }, null, 2)}\n`);
  return { scorecard, results, file: out };
}
