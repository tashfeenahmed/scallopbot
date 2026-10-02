/**
 * ScallopBench CLI.
 *
 *   npm run bench:agentic -- --model moonshot --tasks trap
 *   npm run bench:agentic -- --models scripted,openrouter:qwen/qwen3.6-plus --tasks all --concurrency 4 --repeat 2
 *   npm run bench:agentic -- --export tasks.json          # neutral task export for Hermes/Prime adapters
 *   npm run bench:agentic -- --score external-run.json    # score another agent's workspaces + replies
 *
 * Flags:
 *   --model <spec> / --models a,b,c   scripted | moonshot[:m] | openrouter:<m> | openai[:m] | anthropic[:m] | local[:m]
 *   --tasks <sel>                     all | trap | coding | assistant | comma list of ids (default all)
 *   --concurrency N                   parallel task runs (default 1)
 *   --repeat N                        runs per task (default 1)
 *   --max-iterations N                agent loop cap per turn (default 40; production is 100)
 *   --timeout S                       wall-clock cap per task in seconds (default 600)
 *   --no-outcome-brain                run without the shared OutcomeBrain (production has it)
 *   --baseline <name>                 also write the results to baselines/<name>.json
 *   --keep                            keep temp workspaces for inspection
 *   --verbose                         agent logs to stderr
 *   --env-file <path>                 env file (default: nearest .env walking up from cwd)
 *   --balance-floor <usd>             stop starting tasks once the Moonshot balance is at or below this
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import pino from 'pino';
import { BENCH_DIR, commitSha, exportTasks, scoreExternal, slug } from './external.js';
import { runTask, type HarnessOptions } from './harness.js';
import { resolveBenchModel, type BenchModel } from './providers.js';
import { buildScorecard, formatScorecard } from './scorecard.js';
import { selectTasks } from './tasks/index.js';
import { createBudgetGuard } from './budget.js';

interface CliArgs {
  models: string[];
  tasks: string;
  concurrency: number;
  repeat: number;
  maxIterations: number;
  timeoutS: number;
  outcomeBrain: boolean;
  baseline?: string;
  keep: boolean;
  verbose: boolean;
  envFile?: string;
  exportPath?: string;
  scorePath?: string;
  /** Stop starting tasks once the Moonshot balance is at or below this (USD). */
  balanceFloor?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    models: [], tasks: 'all', concurrency: 1, repeat: 1, maxIterations: 40, timeoutS: 600,
    outcomeBrain: true, keep: false, verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--model': args.models.push(value()); break;
      case '--models': args.models.push(...value().split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--tasks': args.tasks = value(); break;
      case '--concurrency': args.concurrency = Math.max(1, Number(value())); break;
      case '--repeat': args.repeat = Math.max(1, Number(value())); break;
      case '--balance-floor': args.balanceFloor = Number(value()); break;
      case '--max-iterations': args.maxIterations = Math.max(1, Number(value())); break;
      case '--timeout': args.timeoutS = Math.max(10, Number(value())); break;
      case '--no-outcome-brain': args.outcomeBrain = false; break;
      case '--baseline': args.baseline = value(); break;
      case '--keep': args.keep = true; break;
      case '--verbose': args.verbose = true; break;
      case '--env-file': args.envFile = value(); break;
      case '--export': args.exportPath = value(); break;
      case '--score': args.scorePath = value(); break;
      case '--help': case '-h':
        console.log(`Usage: npm run bench:agentic -- [--model <spec>|--models a,b] [--tasks all|trap|coding|assistant|<ids>] [--concurrency N] [--repeat N] [--export file] [--score file]`);
        process.exit(0);
        break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  return args;
}

function loadEnv(explicit?: string): string | undefined {
  let file = explicit;
  if (!file) {
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, '.env'))) { file = path.join(dir, '.env'); break; }
      if (path.dirname(dir) === dir) break;
    }
  }
  if (file) loadDotenv({ path: file, quiet: true });
  // The bench always works in its own temp workspaces.
  delete process.env.AGENT_WORKSPACE;
  return file;
}

async function pool<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  }));
  return results;
}

async function runBench(args: CliArgs): Promise<void> {
  const tasks = selectTasks(args.tasks);
  const models: BenchModel[] = (args.models.length ? args.models : ['scripted']).map(resolveBenchModel);
  const logger = pino({ level: args.verbose ? 'info' : 'silent' }, pino.destination(2));
  const harness: HarnessOptions = {
    maxIterations: args.maxIterations,
    outcomeBrain: args.outcomeBrain,
    taskTimeoutMs: args.timeoutS * 1000,
    keepWorkspace: args.keep,
    logger,
  };
  const startedAt = new Date();
  const sha = commitSha();
  const canSpend = args.balanceFloor === undefined
    ? async () => true
    : createBudgetGuard(args.balanceFloor, { log: (line) => console.error(line) });

  for (const model of models) {
    const jobs = tasks.flatMap(task => Array.from({ length: args.repeat }, (_, repeat) => async () => {
      if (!(await canSpend())) return null;
      const result = await runTask(task, model, { ...harness, repeat });
      const calls = result.trace.turns.reduce((sum, t) => sum + t.llmCalls, 0);
      console.error(`[${model.label}] ${result.pass ? 'PASS' : 'FAIL'} ${task.id}#${repeat} (${(result.durationMs / 1000).toFixed(1)}s, ${calls} calls) ${result.details}`);
      return result;
    }));
    const settled = await pool(jobs, args.concurrency);
    const results = settled.filter((result): result is NonNullable<typeof result> => result !== null);
    if (results.length < settled.length) {
      console.error(`[budget] ${settled.length - results.length} task run(s) skipped by the balance floor`);
    }
    const scorecard = buildScorecard(model.label, results);
    console.log(formatScorecard(scorecard, results));
    console.log('');

    const payload = {
      bench: 'scallopbench',
      version: 1,
      model: model.label,
      commit: sha,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      options: {
        tasks: args.tasks, repeat: args.repeat, concurrency: args.concurrency,
        ...(args.balanceFloor !== undefined && { balanceFloor: args.balanceFloor }),
        maxIterations: args.maxIterations, outcomeBrain: args.outcomeBrain, timeoutS: args.timeoutS,
      },
      scorecard,
      results,
    };
    const resultsDir = path.join(BENCH_DIR, 'results');
    await mkdir(resultsDir, { recursive: true });
    const file = path.join(resultsDir, `${startedAt.toISOString().replace(/[:.]/g, '-')}-${slug(model.label)}.json`);
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    console.error(`results: ${path.relative(process.cwd(), file)}`);
    if (args.baseline) {
      const baselineFile = path.join(BENCH_DIR, 'baselines', `${slug(args.baseline)}.json`);
      await mkdir(path.dirname(baselineFile), { recursive: true });
      await writeFile(baselineFile, `${JSON.stringify(payload, null, 2)}\n`);
      console.error(`baseline: ${path.relative(process.cwd(), baselineFile)}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envFile = loadEnv(args.envFile);
  if (envFile && args.verbose) console.error(`env: ${envFile}`);
  if (args.exportPath) {
    const { count, file, fixturesDir } = await exportTasks(args.exportPath);
    console.log(`exported ${count} tasks to ${file} (fixtures in ${fixturesDir})`);
    return;
  }
  if (args.scorePath) {
    const { scorecard, results, file } = await scoreExternal(args.scorePath, path.join(BENCH_DIR, 'results'));
    console.log(formatScorecard(scorecard, results));
    console.error(`results: ${path.relative(process.cwd(), file)}`);
    return;
  }
  return runBench(args);
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
