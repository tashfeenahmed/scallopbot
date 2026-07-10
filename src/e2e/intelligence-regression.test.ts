import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { BoardService } from '../board/board-service.js';
import { saveMCPConfig } from '../config/mcp-config.js';
import { evaluateArtifactFitness } from '../evolution/fitness.js';
import { createLoadProcedureSkill } from '../evolution/procedure-skill.js';
import { SkillStore } from '../evolution/skill-store.js';
import {
  buildIntelligenceScorecard,
  scorecardMarkdown,
  type ImprovementMetric,
} from '../eval/intelligence-scorecard.js';
import { GoalService } from '../goals/goal-service.js';
import { calculateBM25Score, buildDocFreqMap } from '../memory/bm25.js';
import { ScallopDatabase, type ScheduledItem } from '../memory/db.js';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { detectProactiveEngagement } from '../proactive/feedback.js';
import { buildTierMapping } from '../routing/router.js';
import { redactSensitiveText } from '../security/redaction.js';
import { buildSkillSubprocessEnv, createSkillExecutor } from '../skills/executor.js';
import { handler as mcpHandler } from '../skills/bundled/mcp/run.js';
import { createSkillRegistry } from '../skills/registry.js';
import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import { SafeWorkflowExecutor } from '../workflow/executor.js';

const logger = pino({ level: 'silent' });
const MINUTE_MS = 60_000;

function requireObserved(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Intelligence benchmark setup failed: ${message}`);
}

function legacyTierMapping(order: string[]): Record<'fast' | 'standard' | 'capable', string[]> {
  return { fast: [...order], standard: [...order], capable: [...order] };
}

function measureRouting(): ImprovementMetric {
  const order = ['moonshot', 'anthropic', 'openai', 'groq', 'xai', 'ollama'];
  const baselineMapping = legacyTierMapping(order);
  const candidateMapping = buildTierMapping(order);
  const distinctPrimaries = (mapping: Record<'fast' | 'standard' | 'capable', string[]>) =>
    new Set(Object.values(mapping).map(chain => chain[0])).size;
  return {
    id: 'routing-tier-differentiation',
    label: 'Distinct tier primaries',
    baseline: distinctPrimaries(baselineMapping),
    candidate: distinctPrimaries(candidateMapping),
    direction: 'higher',
    minDelta: 2,
    evidence: 'buildTierMapping compared with the former shared-order mapping',
  };
}

function legacyCandidateIds(
  query: string,
  memories: Array<{ id: string; content: string }>,
): string[] {
  const texts = memories.map(memory => memory.content);
  const averageLength = texts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) / texts.length;
  const options = {
    avgDocLength: averageLength,
    docCount: texts.length,
    docFreq: buildDocFreqMap(texts),
  };
  return memories
    .map(memory => ({ id: memory.id, score: calculateBM25Score(query, memory.content, options) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 50)
    .map(result => result.id);
}

async function measureSemanticRecall(root: string): Promise<ImprovementMetric> {
  const store = new ScallopMemoryStore({ dbPath: join(root, 'semantic.db'), logger });
  try {
    // The legacy lexical gate only passed 50 documents to semantic scoring.
    // Sixty lexical decoys therefore make this paraphrase a genuine miss.
    for (let index = 0; index < 60; index++) {
      const memory = await store.add({
        userId: 'benchmark-user',
        content: `keyword inventory decoy number ${index}`,
        detectRelations: false,
      });
      store.update(memory.id, { embedding: [0, 1] });
    }
    const target = await store.add({
      userId: 'benchmark-user',
      content: 'The canine companion sleeps beside the fireplace',
      detectRelations: false,
    });
    store.update(target.id, { embedding: [1, 0] });

    const corpus = store.getByUser('benchmark-user', { minProminence: 0 });
    const baseline = Number(legacyCandidateIds('keyword', corpus).includes(target.id));
    const results = await store.search('keyword', {
      userId: 'benchmark-user',
      limit: 5,
      minProminence: 0,
      queryEmbedding: [1, 0],
    });
    const candidate = Number(results.some(result => result.memory.id === target.id));
    requireObserved(results.length > 0, 'semantic search returned no results');
    return {
      id: 'semantic-recall',
      label: 'Semantic-only target recall',
      baseline,
      candidate,
      direction: 'higher',
      minDelta: 1,
      evidence: 'ScallopMemoryStore.search compared with the former BM25 top-50 gate',
    };
  } finally {
    store.close();
  }
}

function makeProactiveItem(now: number): ScheduledItem {
  return {
    id: 'benchmark-proactive-item',
    userId: 'benchmark-user',
    sessionId: null,
    source: 'agent',
    type: 'goal_checkin',
    message: 'Remember to renew your passport before Spain',
    context: null,
    triggerAt: now - 30 * MINUTE_MS,
    recurring: null,
    status: 'fired',
    firedAt: now - 5 * MINUTE_MS,
    sourceMemoryId: null,
    createdAt: now - 60 * MINUTE_MS,
    updatedAt: now - 5 * MINUTE_MS,
  };
}

function legacyTimeWindowAttribution(
  userId: string,
  items: ScheduledItem[],
  now: number,
): boolean {
  return items.some(item => item.userId === userId
    && item.source === 'agent'
    && item.status === 'fired'
    && item.firedAt !== null
    && now - item.firedAt >= 0
    && now - item.firedAt <= 15 * MINUTE_MS);
}

function measureProactivePrecision(): ImprovementMetric {
  const now = Date.parse('2026-07-10T12:00:00Z');
  const item = makeProactiveItem(now);
  const fixtures = [
    { text: 'I renewed my passport for Spain', expected: true },
    { text: 'Thanks!', expected: true },
    { text: 'Can you explain this TypeScript error?', expected: false },
    { text: 'Hello, what model are you?', expected: false },
    { text: 'Not now, stop reminding me about the passport', expected: false },
  ];
  const baselinePredictions = fixtures.map(() =>
    legacyTimeWindowAttribution('benchmark-user', [item], now));
  const candidatePredictions = fixtures.map(fixture =>
    detectProactiveEngagement('benchmark-user', [item], undefined, now, {
      userMessage: fixture.text,
    }).length > 0);
  const precision = (predictions: boolean[]) => {
    const positives = predictions.filter(Boolean).length;
    const truePositives = predictions.filter((prediction, index) =>
      prediction && fixtures[index].expected).length;
    return positives === 0 ? 0 : truePositives / positives;
  };
  return {
    id: 'proactive-precision',
    label: 'Proactive attribution precision',
    baseline: precision(baselinePredictions),
    candidate: precision(candidatePredictions),
    direction: 'higher',
    minDelta: 0.5,
    evidence: 'detectProactiveEngagement compared with time-window-only attribution',
  };
}

function unscopedBenchmarkSkill(): Skill {
  return {
    name: 'benchmark-unscoped-skill',
    description: 'A benchmark skill with no credential requirement',
    path: '/benchmark/SKILL.md',
    source: 'sdk',
    frontmatter: {
      name: 'benchmark-unscoped-skill',
      description: 'A benchmark skill with no credential requirement',
    },
    content: '',
    available: true,
    hasScripts: true,
    scriptsDir: '/benchmark/scripts',
  };
}

function measureSecretExposure(): ImprovementMetric {
  const key = 'SCALLOPBOT_BENCHMARK_TOKEN';
  const secret = 'benchmark-secret-value-987';
  const prior = process.env[key];
  process.env[key] = secret;
  try {
    // Former script execution inherited the whole environment and returned raw
    // subprocess output; model both channels explicitly as the baseline.
    const legacyEnvironment = { ...process.env };
    const legacyOutput = `tool-result:${secret}`;
    const candidateEnvironment = buildSkillSubprocessEnv(unscopedBenchmarkSkill(), {
      skillName: 'benchmark-unscoped-skill',
      args: {},
      cwd: '/benchmark',
    });
    const candidateOutput = redactSensitiveText(legacyOutput);
    const baseline = Number(legacyEnvironment[key] === secret) + Number(legacyOutput.includes(secret));
    const candidate = Number(candidateEnvironment[key] === secret) + Number(candidateOutput.includes(secret));
    return {
      id: 'secret-exposure',
      label: 'Secret-bearing channels exposed to an unscoped tool',
      baseline,
      candidate,
      direction: 'lower',
      minDelta: 2,
      evidence: 'buildSkillSubprocessEnv and redactSensitiveText against full-env/raw-output behavior',
    };
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

async function measureVerifiedGoals(): Promise<ImprovementMetric> {
  const db = new ScallopDatabase(':memory:');
  try {
    const service = new GoalService({ db, logger });
    const goal = await service.createGoal('benchmark-user', {
      title: 'Publish a verified benchmark artifact',
      status: 'active',
      contract: {
        acceptanceCriteria: [
          { id: 'tests', description: 'Tests passed', kind: 'contains', expected: 'tests passed' },
          { id: 'artifact', description: 'Artifact independently exists', kind: 'manual' },
        ],
      },
      budget: { maxTurns: 1 },
    });
    const output = 'tests passed';
    // The former output-only check ignored criteria it could not derive from
    // text, so the manual artifact criterion could not block completion.
    const baselineAccepted = goal.metadata.contract!.acceptanceCriteria
      .filter(criterion => criterion.kind !== 'manual')
      .every(criterion => output.includes(criterion.expected ?? ''));
    const result = await service.runUntilVerified(goal.id, async () => ({
      output,
      taskComplete: true,
    }));
    return {
      id: 'verified-goal',
      label: 'Unverified goal completion accepted',
      baseline: Number(baselineAccepted),
      candidate: Number(result.state === 'completed'),
      direction: 'lower',
      minDelta: 1,
      evidence: 'GoalService.runUntilVerified with an unsatisfied manual acceptance criterion',
    };
  } finally {
    db.close();
  }
}

function bytesLeaked(serialized: string, hidden: string): number {
  return serialized.includes(hidden) ? Buffer.byteLength(hidden) : 0;
}

async function measureWorkflowLeakage(root: string): Promise<ImprovementMetric> {
  const hidden = `private:${'x'.repeat(2_000)}`;
  let downstreamInput = '';
  const registry = createSkillRegistry(join(root, 'workflow-skills'), logger);
  registry.registerSkill(defineSkill('benchmark-source', 'Produce private benchmark data')
    .onNativeExecute(async () => ({ success: true, output: hidden }))
    .build().skill);
  registry.registerSkill(defineSkill('benchmark-transform', 'Consume private benchmark data')
    .onNativeExecute(async context => {
      downstreamInput = String(context.args.value);
      return { success: true, output: 'processed' };
    })
    .build().skill);
  const executor = new SafeWorkflowExecutor({
    skillRegistry: registry,
    skillExecutor: createSkillExecutor(logger),
    logger,
    allowlist: ['benchmark-source', 'benchmark-transform'],
  });
  const report = await executor.execute({
    steps: [
      { id: 'fetch', tool: 'benchmark-source', expose: false },
      {
        id: 'consume',
        tool: 'benchmark-transform',
        args: { value: '{{fetch.output}}' },
        dependsOn: ['fetch'],
        expose: true,
      },
    ],
  }, { workspace: root, sessionId: 'benchmark-session' });
  requireObserved(report.success, 'workflow did not complete');
  requireObserved(downstreamInput === hidden, 'hidden output did not reach its declared dependency');

  const legacyReport = JSON.stringify({ steps: [{ id: 'fetch', output: hidden }] });
  const candidateReport = JSON.stringify(report);
  return {
    id: 'workflow-context-leakage',
    label: 'Hidden intermediate bytes exposed',
    baseline: bytesLeaked(legacyReport, hidden),
    candidate: bytesLeaked(candidateReport, hidden),
    direction: 'lower',
    minDelta: 1_000,
    unit: 'bytes',
    evidence: 'SafeWorkflowExecutor.execute compared with a report retaining every step output',
  };
}

async function measureMcpCallability(root: string): Promise<ImprovementMetric> {
  const serverPath = join(root, 'benchmark-mcp-server.mjs');
  const configPath = join(root, 'benchmark-mcp.json');
  await writeFile(serverPath, `
    import readline from 'node:readline';
    const lines = readline.createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'benchmark', version: '1' }
        }});
      } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
          name: 'echo', description: 'Echo a value',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } }
        }] }});
      } else if (message.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: message.id, result: {
          content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }]
        }});
      }
    });
  `, 'utf8');
  saveMCPConfig([{
    name: 'benchmark',
    command: process.execPath,
    args: [serverPath],
    description: 'Dynamic scorecard server',
    allowedTools: ['echo'],
  }], configPath);

  const context = { args: {}, workspace: root, sessionId: 'benchmark-session' };
  const listed = await mcpHandler({ ...context, args: { action: 'list' } }, { configPath });
  const discovered = await mcpHandler({
    ...context,
    args: { action: 'tools', server: 'benchmark' },
  }, { configPath });
  const called = await mcpHandler({
    ...context,
    args: { action: 'call', server: 'benchmark', tool: 'echo', args: { value: 'hello' } },
  }, { configPath });

  const operations = ['list', 'tools', 'call'] as const;
  const legacyDocumentationSkill = { hasScripts: false, handler: undefined };
  const baseline = operations.filter(() =>
    legacyDocumentationSkill.hasScripts || typeof legacyDocumentationSkill.handler === 'function').length;
  const candidate = [
    listed.success && listed.output?.includes('benchmark'),
    discovered.success && discovered.output?.includes('echo'),
    called.success && called.output?.includes('hello'),
  ].filter(Boolean).length;
  requireObserved(candidate === operations.length, 'MCP list/discover/call lifecycle was incomplete');
  return {
    id: 'mcp-callability',
    label: 'Working MCP lifecycle operations',
    baseline,
    candidate,
    direction: 'higher',
    minDelta: operations.length,
    evidence: 'MCP skill list, tools, and call actions against a real stdio JSON-RPC child process',
  };
}

async function measureEvolutionFitness(): Promise<ImprovementMetric> {
  const artifact = {
    kind: 'skill' as const,
    target: 'benchmark-research',
    baseline: 'Use primary sources.',
    candidate: 'Use primary sources, maybe.',
  };
  const cases = [{ id: 'holdout', task: 'Find and assess a primary source.' }];
  // The former gate treated a syntactically non-empty artifact as promotable.
  const baselinePromoted = artifact.candidate.trim().length > 0;
  // With no independent evaluator, improvement is unproven. The real fitness
  // API must fail closed instead of converting uncertainty into a promotion.
  const result = await evaluateArtifactFitness(artifact, cases, undefined, 0.05);
  return {
    id: 'evolution-fitness',
    label: 'Unevaluated mutations promoted',
    baseline: Number(baselinePromoted),
    candidate: Number(result.passed),
    direction: 'lower',
    minDelta: 1,
    evidence: 'evaluateArtifactFitness fail-closed behavior without an independent evaluator',
  };
}

class LegacyVolatileWorkerQueue {
  private tasks: string[] = [];

  enqueue(id: string): void {
    this.tasks.push(id);
  }

  claim(): string | undefined {
    return this.tasks.shift();
  }
}

async function measureDurableRecovery(root: string): Promise<ImprovementMetric> {
  let legacyQueue = new LegacyVolatileWorkerQueue();
  legacyQueue.enqueue('legacy-task');
  legacyQueue.claim();
  legacyQueue = new LegacyVolatileWorkerQueue();
  const baseline = Number(legacyQueue.claim() === 'legacy-task');

  const dbPath = join(root, 'durable-workers.db');
  const firstDb = new ScallopDatabase(dbPath);
  const firstBoard = new BoardService(firstDb, logger);
  // The current database is intentionally single-user and canonicalizes durable
  // board work to the persisted `default` identity during restart migrations.
  const task = firstBoard.createItem('default', {
    title: 'Recover this leased task',
    kind: 'task',
    boardStatus: 'backlog',
    maxAttempts: 2,
  });
  const firstLease = firstBoard.claimNextTask('default', 'worker-a', 1_000, 1_000);
  requireObserved(firstLease?.item.id === task.id, 'initial durable task lease failed');
  firstDb.close();

  const secondDb = new ScallopDatabase(dbPath);
  try {
    const secondBoard = new BoardService(secondDb, logger);
    const reclaimed = secondBoard.reclaimExpiredLeases(2_001);
    const recovered = secondBoard.claimNextTask('default', 'worker-b', 1_000, 2_002);
    const candidate = Number(reclaimed === 1 && recovered?.item.id === task.id);
    requireObserved(
      candidate === 1,
      `durable lease recovery returned reclaimed=${reclaimed}, recovered=${recovered?.item.id ?? 'none'}, state=${JSON.stringify(secondBoard.getItem(task.id))}`,
    );
    return {
      id: 'durable-worker-recovery',
      label: 'Expired task leases recoverable after restart',
      baseline,
      candidate,
      direction: 'higher',
      minDelta: 1,
      evidence: 'BoardService lease persisted across ScallopDatabase close/reopen and expired-lease reclaim',
    };
  } finally {
    secondDb.close();
  }
}

async function measureSkillLifecycle(root: string): Promise<ImprovementMetric> {
  const skillName = 'learned-benchmark-skill';
  const legacySkills = new Map<string, string>();
  const legacyEvents: string[] = [];
  legacySkills.set(skillName, 'learned procedure');
  if (legacySkills.has(skillName)) legacyEvents.push('promote');

  const store = new SkillStore({ localDir: join(root, 'learned-skills'), logger });
  const day = 24 * 60 * 60 * 1_000;
  const observedEvents: string[] = [];
  await store.stage(skillName, { 'SKILL.md': 'learned procedure' });
  await store.promote(skillName);
  if (await store.snapshotLive(skillName)) observedEvents.push('promote');

  await store.markAgentCreated(skillName, 'create', 0);
  const learnedProcedure: Skill = {
    name: skillName,
    description: 'Learned benchmark procedure',
    path: join(root, 'learned-skills', skillName, 'SKILL.md'),
    source: 'local',
    frontmatter: { name: skillName, description: 'Learned benchmark procedure' },
    content: 'Follow the verified benchmark procedure.',
    available: true,
    hasScripts: false,
  };
  const procedureLoader = createLoadProcedureSkill(
    { getDocumentationSkills: () => [learnedProcedure] },
    name => store.recordUse(name, 10 * day),
  );
  const loaded = await procedureLoader.handler!({
    args: { name: skillName },
    workspace: root,
    sessionId: 'benchmark-session',
    userId: 'benchmark-user',
  });
  if (loaded.success && (await store.getUsage())[skillName]?.useCount === 1) {
    observedEvents.push('usage');
  }

  const stale = await store.curate({
    now: 45 * day,
    staleAfterDays: 30,
    archiveAfterDays: 90,
    backupKeep: 3,
  });
  if (stale.stale.includes(skillName)) observedEvents.push('stale');

  const archived = await store.curate({
    now: 101 * day,
    staleAfterDays: 30,
    archiveAfterDays: 90,
    backupKeep: 3,
  });
  if (archived.archived.includes(skillName) && !(await store.snapshotLive(skillName))) {
    observedEvents.push('archive');
  }

  const restored = await store.restoreArchived(skillName, 102 * day);
  if (restored && await store.snapshotLive(skillName)) observedEvents.push('restore');
  return {
    id: 'skill-learning-lifecycle',
    label: 'Observed automatic skill lifecycle stages',
    baseline: legacyEvents.length,
    candidate: observedEvents.length,
    direction: 'higher',
    minDelta: 4,
    evidence: 'load_procedure selection plus SkillStore promotion, usage, stale, archive, and restore transitions',
  };
}

/** Execute every before/after behavior used by the public intelligence scorecard. */
export async function collectIntelligenceRegressionMetrics(): Promise<ImprovementMetric[]> {
  const root = await mkdtemp(join(tmpdir(), 'scallop-intelligence-scorecard-'));
  try {
    const substantive = [
      measureRouting(),
      await measureSemanticRecall(root),
      measureProactivePrecision(),
      measureSecretExposure(),
      await measureVerifiedGoals(),
      await measureWorkflowLeakage(root),
      await measureMcpCallability(root),
      await measureEvolutionFitness(),
      await measureDurableRecovery(root),
      await measureSkillLifecycle(root),
    ];
    const baselineCoverage = buildIntelligenceScorecard([], 'legacy-no-scorecard').metrics.length;
    const measured = buildIntelligenceScorecard(substantive, 'dynamic-probes').metrics;
    const candidateCoverage = measured.filter(metric =>
      Number.isFinite(metric.baseline)
      && Number.isFinite(metric.candidate)
      && Boolean(metric.evidence)).length;
    const coverage: ImprovementMetric = {
      id: 'measurement-coverage',
      label: 'Substantive dimensions with dynamic before/after evidence',
      baseline: baselineCoverage,
      candidate: candidateCoverage,
      direction: 'higher',
      minDelta: substantive.length,
      evidence: 'buildIntelligenceScorecard over the executed behavior probes in this test',
    };

    // Keep the roadmap order: measurement is item 10 and automatic skill
    // learning/curation is the added eleventh item.
    return [...substantive.slice(0, 9), coverage, substantive[9]];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('eleven-item intelligence regression scorecard', () => {
  it('executes a measured improvement probe for every roadmap item', async () => {
    const metrics = await collectIntelligenceRegressionMetrics();
    const scorecard = buildIntelligenceScorecard(metrics, 'dynamic-behavior-probes');
    console.log(`\n${scorecardMarkdown(scorecard)}\n`);
    expect(scorecard.metrics).toHaveLength(11);
    expect(scorecard.failed).toBe(0);
    expect(scorecard.passRate).toBe(1);
    expect(scorecard.metrics.every(metric => Boolean(metric.evidence))).toBe(true);
  }, 30_000);
});
