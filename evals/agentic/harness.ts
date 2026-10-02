/**
 * ScallopBench harness: runs one task through the REAL Agent.
 *
 * Wiring mirrors the gateway's main agent (src/gateway/gateway.ts) minus the
 * channels and memory: real SkillRegistry/SkillExecutor with the bundled
 * skills, SessionManager on a temp SQLite db, a Router + CostTracker around the
 * bench provider, and the shared OutcomeBrain (on by default, like production).
 * Each run gets a fresh temp workspace seeded by the task.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { Agent, type ProgressUpdate } from '../../src/agent/agent.js';
import { ApprovalStore } from '../../src/agent/approvals.js';
import { SessionManager } from '../../src/agent/session.js';
import { OutcomeBrain } from '../../src/brain/outcome-brain.js';
import { ScallopDatabase } from '../../src/memory/db.js';
import { CostTracker } from '../../src/routing/cost.js';
import { Router } from '../../src/routing/router.js';
import { createSkillExecutor } from '../../src/skills/executor.js';
import { SkillLoader } from '../../src/skills/loader.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { defineSkill } from '../../src/skills/sdk.js';
import { registerAgentTools, coreToolHooks } from '../../src/tools/index.js';
import type { BenchModel } from './providers.js';
import { efficiencyOf } from './scorecard.js';
import { CANNED_REFUSAL_RE, TracingProvider, extractTurnTranscript } from './trace.js';
import type { BenchTask, TaskRunResult, TaskTrace, ToolCallTrace, TurnTrace } from './types.js';

export interface HarnessOptions {
  /** Agent loop cap per turn. Production default is 100; the bench uses 40 to bound cost. */
  maxIterations?: number;
  /** Wire the shared OutcomeBrain like the gateway does (default true). */
  outcomeBrain?: boolean;
  /** Wall-clock cap per task in ms (default 10 minutes). */
  taskTimeoutMs?: number;
  /** Keep the temp workspace + db for inspection. */
  keepWorkspace?: boolean;
  logger?: Logger;
  repeat?: number;
  /** Outcome-only scoring (workspace + replies), as for external agents. */
  crossAgent?: boolean;
}

export interface BenchSandbox {
  root: string;
  workspace: string;
  dataDir: string;
}

/** Fresh temp workspace + data dir for one run. */
export async function createSandbox(taskId: string): Promise<BenchSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), `scallopbench-${taskId}-`));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { root, workspace, dataDir };
}

/**
 * Bundled skills only: the local ~/.scallopbot/skills dir is pointed at an
 * empty folder so the bench is hermetic and comparable across machines.
 */
export async function createBenchSkills(sandbox: BenchSandbox, logger: Logger) {
  const loader = new SkillLoader({
    workspaceDir: sandbox.workspace,
    localDir: path.join(sandbox.dataDir, 'no-local-skills'),
  }, logger);
  const registry = new SkillRegistry(loader, logger);
  await registry.initialize();
  // Same native tools as the gateway (bash, process, todo, webfetch, web_search…).
  registerAgentTools(registry);
  const executor = createSkillExecutor(logger);
  return { registry, executor };
}

/** Production's send_message is gateway-bound; the bench records the texts instead. */
function createBenchSendMessageSkill(onSend: (message: string) => void) {
  return defineSkill('send_message', 'Send a text message to the user immediately. Use this for conversational, human-like messaging.')
    .userInvocable(false)
    .safety({ externalWrite: true, publicCommunication: true })
    .inputSchema({
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message text to send. Keep it short and conversational, like a text message.' },
      },
      required: ['message'],
    })
    .onNativeExecute(async (ctx) => {
      const message = typeof ctx.args.message === 'string' ? ctx.args.message.trim() : '';
      if (!message) return { success: false, output: 'Missing required parameter: message' };
      onSend(message);
      return { success: true, output: 'Message sent' };
    })
    .build().skill;
}

function emptyTrace(): TaskTrace {
  return { turns: [], llmCalls: [], toolCalls: [], sentMessages: [], finalResponse: '', allResponses: '' };
}

export async function runTask(task: BenchTask, model: BenchModel, options: HarnessOptions = {}): Promise<TaskRunResult> {
  // Skills resolve their cwd from AGENT_WORKSPACE before request.cwd; a value
  // inherited from .env would point every tool at the wrong directory.
  delete process.env.AGENT_WORKSPACE;

  const logger = options.logger ?? pino({ level: 'silent' });
  const startedAt = Date.now();
  const sandbox = await createSandbox(task.id);
  const trace = emptyTrace();
  let db: ScallopDatabase | null = null;
  let runError: string | undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('bench task timeout')),
    task.timeoutMs ?? options.taskTimeoutMs ?? 600_000,
  );

  try {
    await task.setup(sandbox.workspace);
    db = new ScallopDatabase(path.join(sandbox.dataDir, 'bench.db'));
    const sessions = new SessionManager(db);
    const { registry, executor } = await createBenchSkills(sandbox, logger);
    let firstSendAt: number | null = null;
    registry.registerSkill(createBenchSendMessageSkill((message) => {
      trace.sentMessages.push(message);
      firstSendAt ??= Date.now();
    }));

    const provider = new TracingProvider(model.create(task));
    const router = new Router({
      providerOrder: [provider.name],
      tierMapping: { fast: [provider.name], standard: [provider.name], capable: [provider.name] },
    });
    router.registerProvider(provider);
    const costTracker = new CostTracker({ db });
    const outcomeBrain = options.outcomeBrain === false
      ? undefined
      : new OutcomeBrain({ db, logger, router });

    const agent = new Agent({
      provider,
      sessionManager: sessions,
      skillRegistry: registry,
      skillExecutor: executor,
      router,
      costTracker,
      outcomeBrain,
      approvals: new ApprovalStore({ dataDir: sandbox.dataDir }),
      workspace: sandbox.workspace,
      logger,
      maxIterations: options.maxIterations ?? 40,
      maxToolCallsPerResponse: 64,
      toolLoopDetection: { historySize: 30, warningThreshold: 3, criticalThreshold: 5, circuitBreakerThreshold: 8 },
      enableThinking: model.enableThinking,
      hooks: coreToolHooks({ workspace: sandbox.workspace }),
    });

    const session = await sessions.createSession({ userId: 'api:bench', channelId: 'api' });
    const seenToolIds = new Set<string>();

    for (let turn = 0; turn < task.prompt.length; turn++) {
      const userMessage = task.prompt[turn]!;
      provider.turn = turn;
      firstSendAt = null;
      let progressToolStarts = 0;
      let progressToolErrors = 0;
      const onProgress = async (update: ProgressUpdate) => {
        if (update.type === 'tool_start') progressToolStarts++;
        if (update.type === 'tool_error') progressToolErrors++;
      };
      const turnStart = Date.now();
      let response = '';
      let completionReason = 'error';
      let iterationsUsed = 0;
      let pendingApproval: string | undefined;
      let turnError: string | undefined;
      try {
        const result = await agent.processMessage(
          session.id, userMessage, undefined, onProgress, undefined, undefined, controller.signal,
        );
        response = result.response;
        completionReason = result.completionReason;
        iterationsUsed = result.iterationsUsed;
        pendingApproval = result.pendingApproval?.question;
      } catch (error) {
        turnError = (error as Error).message;
      }
      const totalMs = Date.now() - turnStart;

      const stored = await sessions.getSession(session.id);
      const { toolCalls: all, systemNudges } = extractTurnTranscript(stored?.messages ?? [], turn);
      const toolCalls: ToolCallTrace[] = all.filter(call => !seenToolIds.has(call.id));
      for (const call of toolCalls) seenToolIds.add(call.id);
      trace.toolCalls.push(...toolCalls);

      const calls = provider.calls.filter(call => call.turn === turn);
      const turnTrace: TurnTrace = {
        turn,
        userMessage,
        response,
        completionReason,
        iterationsUsed,
        totalMs,
        timeToFirstReplyMs: firstSendAt !== null ? Math.min(firstSendAt - turnStart, totalMs) : totalMs,
        llmCalls: calls.length,
        inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
        outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
        cachedInputTokens: calls.reduce((sum, call) => sum + call.cachedInputTokens, 0),
        toolCalls: toolCalls.length,
        toolErrors: toolCalls.filter(call => call.isError).length,
        blockedCalls: toolCalls.filter(call => call.blocked).length,
        progressToolStarts,
        progressToolErrors,
        // systemNudges is cumulative over the transcript; store the delta.
        systemNudges: systemNudges - trace.turns.reduce((sum, t) => sum + t.systemNudges, 0),
        cannedRefusal: CANNED_REFUSAL_RE.test(response),
        ...(pendingApproval && { pendingApproval }),
        ...(turnError && { error: turnError }),
      };
      trace.turns.push(turnTrace);
      if (turnError) {
        runError = turnError;
        break;
      }
    }
    trace.llmCalls = provider.calls;
    trace.finalResponse = trace.turns[trace.turns.length - 1]?.response ?? '';
    trace.allResponses = trace.turns.map(t => t.response).join('\n\n');
  } catch (error) {
    runError = (error as Error).message;
  } finally {
    clearTimeout(timer);
  }

  let pass = false;
  let details = runError ? `run error: ${runError}` : '';
  if (!runError || trace.turns.length > 0) {
    try {
      const score = await task.score(sandbox.workspace, trace, { crossAgent: options.crossAgent === true });
      pass = score.pass;
      details = runError ? `${score.details} (run error: ${runError})` : score.details;
    } catch (error) {
      details = `scorer error: ${(error as Error).message}`;
    }
  }

  // Provider failures are infrastructure, not agent behaviour: make them loud.
  const failedCalls = trace.llmCalls.filter(call => call.error);
  if (failedCalls.length > 0) {
    details = `${details}; ${failedCalls.length}/${trace.llmCalls.length} LLM calls failed (${failedCalls[0]!.error!.slice(0, 120)})`;
  }

  // Global rule for every task: the outcome brain's canned refusal is a fail.
  const canned = trace.turns.filter(turn => turn.cannedRefusal).length;
  if (canned > 0) {
    pass = false;
    details = `${details}; canned refusal in ${canned} turn(s)`;
  }

  db?.close();
  if (!options.keepWorkspace) await rm(sandbox.root, { recursive: true, force: true });

  return {
    taskId: task.id,
    category: task.category,
    model: model.label,
    repeat: options.repeat ?? 0,
    pass,
    details,
    durationMs: Date.now() - startedAt,
    trace,
    efficiency: efficiencyOf(task, trace),
    ...(runError && { error: runError }),
    ...(options.keepWorkspace && { workspace: sandbox.workspace }),
  };
}
