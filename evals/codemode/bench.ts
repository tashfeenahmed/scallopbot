/**
 * Code-mode A/B: the same seeded multi-step tasks in tool mode (normal file
 * and shell tools) and code mode (one `exec` tool + kernel API prompt), on a
 * weak model through the repo's real providers and Agent loop.
 *
 *   npm run bench:codemode
 *
 * Env:
 *   BENCH_ENV_FILE   .env to load (default ./.env)
 *   BENCH_PROVIDER   moonshot (default) | openrouter
 *   BENCH_MODEL      model id (default: moonshot kimi-k2.6 / openrouter qwen/qwen3-coder)
 *   BENCH_MODES      comma list of tool,code,hybrid (default tool,code)
 *   BENCH_TASKS      comma list of task ids (default all)
 *   BENCH_TRIALS     trials per task and mode (default 1)
 *   BENCH_OUT        JSON results path (default evals/codemode/last-run.json)
 *   BENCH_TRACE      directory for per-trial transcripts of native tool calls (code cells)
 *   BENCH_KEEP       keep the seeded workspaces
 *
 * Scored from the filesystem, never from the model's reply. LLM calls and
 * tokens are counted by wrapping the provider.
 */

import dotenv from 'dotenv';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Agent } from '../../src/agent/agent.js';
import { SessionManager } from '../../src/agent/session.js';
import { ScallopDatabase } from '../../src/memory/db.js';
import { MoonshotProvider } from '../../src/providers/moonshot.js';
import { OpenRouterProvider } from '../../src/providers/openrouter.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/providers/types.js';
import { createSkillExecutor } from '../../src/skills/executor.js';
import { SkillLoader } from '../../src/skills/loader.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import {
  buildCodeModePrompt,
  createRegistryCallTool,
  registerCodeModeTool,
  registerExecuteCodeTool,
  type CallTool,
  type KernelManager,
} from '../../src/codemode/index.js';
import { TASKS, type BenchTask } from './tasks.js';

dotenv.config({ path: process.env.BENCH_ENV_FILE || path.resolve('.env'), quiet: true } as dotenv.DotenvConfigOptions);

// The bench's workspace is a fresh temp repo; a deployment AGENT_WORKSPACE
// from .env would redirect the script tools' cwd elsewhere.
delete process.env.AGENT_WORKSPACE;

const logger = pino({ level: process.env.BENCH_LOG_LEVEL || 'silent' });
type Mode = 'tool' | 'code' | 'hybrid';

const BASE_PROMPT =
  'You are a careful coding agent working inside a repository (the workspace). Complete the task completely with your tools, ' +
  'check the result yourself, then reply with one short line saying what you did.';

const TOOL_MODE_TOOLS = ['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'bash', 'ls'];

class CountingProvider implements LLMProvider {
  readonly name: string;
  readonly model?: string;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cachedInputTokens = 0;
  constructor(private readonly inner: LLMProvider) {
    this.name = inner.name;
    this.model = inner.model;
  }
  isAvailable(): boolean {
    return this.inner.isAvailable();
  }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls++;
    const response = await this.inner.complete(request);
    this.inputTokens += response.usage.inputTokens || 0;
    this.outputTokens += response.usage.outputTokens || 0;
    this.cachedInputTokens += response.usage.cachedInputTokens || 0;
    return response;
  }
}

function makeProvider(): LLMProvider {
  const which = (process.env.BENCH_PROVIDER || 'moonshot').toLowerCase();
  if (which === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    return new OpenRouterProvider({ apiKey, model: process.env.BENCH_MODEL || 'qwen/qwen3-coder', timeout: 120_000, maxRetries: 2 });
  }
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error('MOONSHOT_API_KEY is not set');
  return new MoonshotProvider({ apiKey, model: process.env.BENCH_MODEL || 'kimi-k2.6', timeout: 120_000, maxRetries: 2 }, logger);
}

async function loadToolRegistry(workspace: string): Promise<SkillRegistry> {
  const loader = new SkillLoader({ workspaceDir: workspace, localDir: path.join(workspace, '.no-local-skills'), watch: false }, logger);
  const registry = new SkillRegistry(loader, logger);
  await registry.initialize();
  // Keep the bench to the coding toolkit in both modes.
  for (const skill of registry.getAllSkills()) {
    if (!TOOL_MODE_TOOLS.includes(skill.name)) registry.registerSkill({ ...skill, available: false });
  }
  return registry;
}

interface TrialResult {
  task: string;
  mode: Mode;
  trial: number;
  pass: boolean;
  detail: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelToolCalls: number;
  innerToolCalls: number;
  iterations: number;
  completionReason: string;
  seconds: number;
  error?: string;
}

async function runTrial(task: BenchTask, mode: Mode, trial: number, baseProvider: LLMProvider): Promise<TrialResult> {
  const workspace = await mkdtemp(path.join(tmpdir(), `cm-bench-${task.id}-${mode}-`));
  task.seed(workspace);
  const provider = new CountingProvider(baseProvider);
  const tools = await loadToolRegistry(workspace);
  const executor = createSkillExecutor(logger, undefined, { timeoutMs: 120_000 });
  let innerToolCalls = 0;
  const baseCall = createRegistryCallTool(tools, executor);
  const countingCall: CallTool = async (name, args, ctx) => {
    innerToolCalls++;
    return baseCall(name, args, ctx);
  };

  let agentRegistry = tools;
  let systemPrompt = BASE_PROMPT;
  let allow = TOOL_MODE_TOOLS;
  let manager: KernelManager | undefined;
  if (mode === 'code') {
    // The agent sees only `exec`; the kernel dispatches to the full tool registry.
    agentRegistry = new SkillRegistry(new SkillLoader({ workspaceDir: path.join(workspace, '.none'), localDir: path.join(workspace, '.none'), watch: false }, logger), logger);
    manager = registerCodeModeTool(agentRegistry, { workspace, toolRegistry: tools, callTool: countingCall, snapshotDir: null, idleMs: 0, setAsDefault: false }).manager;
    systemPrompt = `${BASE_PROMPT}\n\n${buildCodeModePrompt(tools)}`;
    allow = ['exec'];
  } else if (mode === 'hybrid') {
    manager = registerExecuteCodeTool(tools, { workspace, callTool: countingCall, snapshotDir: null, idleMs: 0, setAsDefault: false }).manager;
    allow = [...TOOL_MODE_TOOLS, 'execute_code'];
  }

  const traceDir = process.env.BENCH_TRACE;
  const trace: string[] = [];
  if (traceDir) {
    // Record every model-visible tool call (code cells included) with its output.
    for (const skill of agentRegistry.getAllSkills()) {
      if (!skill.handler || !allow.includes(skill.name)) continue;
      const inner = skill.handler;
      agentRegistry.registerSkill({
        ...skill,
        handler: async (ctx) => {
          const res = await inner(ctx);
          trace.push(`### ${skill.name}\n${typeof ctx.args.code === 'string' ? ctx.args.code : JSON.stringify(ctx.args)}\n--- ${res.success ? 'ok' : 'error'}\n${res.output}\n`);
          return res;
        },
      });
    }
  }

  const db = new ScallopDatabase(':memory:');
  const sessionManager = new SessionManager(db);
  const agent = new Agent({
    provider,
    sessionManager,
    skillRegistry: agentRegistry,
    skillExecutor: executor,
    workspace,
    logger,
    maxIterations: 40,
    enableThinking: false,
    enableComplexityAnalysis: false,
    toolPolicy: { allow },
    foregroundCallTimeoutMs: 180_000,
    turnTimeoutMs: 900_000,
    subAgentMode: true,
    systemPrompt,
  });
  const session = await sessionManager.createSession({ userId: 'bench-user', channelId: 'bench' });
  let modelToolCalls = 0;
  const started = Date.now();
  let result: Awaited<ReturnType<Agent['processMessage']>> | undefined;
  let error: string | undefined;
  try {
    result = await agent.processMessage(session.id, task.prompt, undefined, async update => {
      if (update.type === 'tool_start') modelToolCalls++;
    });
  } catch (err) {
    error = (err as Error).message;
  }
  const seconds = (Date.now() - started) / 1000;
  const verdict = task.verify(workspace);
  if (traceDir && trace.length) {
    await writeFile(path.join(traceDir, `${task.id}-${mode}-${trial}.md`), `${task.prompt}\n\n${trace.join('\n')}\n\nFINAL: ${result?.response ?? error ?? ''}\n`);
  }
  await manager?.disposeAll();
  db.close?.();
  if (!process.env.BENCH_KEEP) await rm(workspace, { recursive: true, force: true });
  return {
    task: task.id,
    mode,
    trial,
    pass: verdict.pass,
    detail: verdict.detail,
    llmCalls: provider.calls,
    inputTokens: provider.inputTokens,
    outputTokens: provider.outputTokens,
    cachedInputTokens: provider.cachedInputTokens,
    modelToolCalls,
    innerToolCalls: mode === 'tool' ? modelToolCalls : innerToolCalls,
    iterations: result?.iterationsUsed ?? 0,
    completionReason: result?.completionReason ?? 'error',
    seconds,
    ...(error ? { error } : {}),
  };
}

function summarize(results: TrialResult[]): string {
  const modes = [...new Set(results.map(r => r.mode))];
  const lines = [
    '| task | mode | pass | LLM calls | input tok | output tok | model tool calls | inner tool calls | seconds |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(`| ${r.task} | ${r.mode} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.llmCalls} | ${r.inputTokens} | ${r.outputTokens} | ${r.modelToolCalls} | ${r.innerToolCalls} | ${r.seconds.toFixed(0)} |`);
  }
  lines.push('', '| mode | pass rate | LLM calls | input tok | output tok | seconds |', '|---|---|---|---|---|---|');
  for (const mode of modes) {
    const rows = results.filter(r => r.mode === mode);
    const sum = (key: keyof TrialResult) => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
    lines.push(`| ${mode} | ${rows.filter(r => r.pass).length}/${rows.length} | ${sum('llmCalls')} | ${sum('inputTokens')} | ${sum('outputTokens')} | ${sum('seconds').toFixed(0)} |`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const modes = (process.env.BENCH_MODES || 'tool,code').split(',').map(m => m.trim()).filter(Boolean) as Mode[];
  const taskIds = process.env.BENCH_TASKS?.split(',').map(t => t.trim());
  const tasks = TASKS.filter(task => !taskIds || taskIds.includes(task.id));
  const trials = Math.max(1, Number(process.env.BENCH_TRIALS || 1));
  const provider = makeProvider();
  console.log(`provider=${provider.name} model=${provider.model} modes=${modes.join(',')} tasks=${tasks.map(t => t.id).join(',')} trials=${trials}`);

  const results: TrialResult[] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= trials; trial++) {
      for (const mode of modes) {
        const r = await runTrial(task, mode, trial, provider);
        results.push(r);
        console.log(`${r.task} [${r.mode}#${r.trial}] ${r.pass ? 'PASS' : 'FAIL'} calls=${r.llmCalls} in=${r.inputTokens} out=${r.outputTokens} tools=${r.modelToolCalls}/${r.innerToolCalls} ${r.seconds.toFixed(0)}s ${r.completionReason}${r.error ? ' error=' + r.error : ''} — ${r.detail}`);
      }
    }
  }
  console.log('\n' + summarize(results));
  const out = process.env.BENCH_OUT || path.resolve('evals/codemode/last-run.json');
  await writeFile(out, JSON.stringify({ date: new Date().toISOString(), provider: provider.name, model: provider.model, results }, null, 2) + '\n');
  console.log(`\nwrote ${out}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
