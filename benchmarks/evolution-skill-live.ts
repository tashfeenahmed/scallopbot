/**
 * Provider-backed, fully isolated self-evolution benchmark.
 *
 * The benchmark uses only synthetic fixtures, in-memory SQLite databases, and
 * temporary skill/workspace directories. It never opens the configured memory
 * database, production skill store, bot channels, or user conversations.
 *
 * Pipeline:
 *   synthetic reusable-task signals -> real-provider reflection -> deterministic
 *   promotion gate -> temporary documentation-skill promotion -> real Agent A/B
 *   -> deterministic correctness/tool-use score.
 */
import 'dotenv/config';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Agent } from '../src/agent/agent.js';
import { SessionManager } from '../src/agent/session.js';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildTierMapping } from '../src/routing/router.js';
import { ScallopDatabase } from '../src/memory/db.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GroqProvider } from '../src/providers/groq.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
} from '../src/providers/types.js';
import { flattenSystem } from '../src/providers/types.js';
import { XAIProvider } from '../src/providers/xai.js';
import { runEvolutionOptimizer } from '../src/evolution/optimizer.js';
import {
  hasMeasuredEvolutionImprovement,
  scoreEvolutionTrial,
} from '../src/evolution/benchmark-score.js';
import { createLoadProcedureSkill } from '../src/evolution/procedure-skill.js';
import { SkillStore } from '../src/evolution/skill-store.js';
import { createSkillExecutor } from '../src/skills/executor.js';
import { SkillLoader } from '../src/skills/loader.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { defineSkill } from '../src/skills/sdk.js';

const logger = pino({ level: 'silent' });
const SYNTHETIC_USER = 'evolution-benchmark-synthetic';
const EXPECTED_TOKEN = 'ABC-5';
const HOLDOUT_TASK =
  'This is an isolated synthetic benchmark. Apply the Caligo checksum convention to ' +
  'words cobalt, amber, birch and integers 8, 13, 5. If a matching learned procedure ' +
  'is listed, call load_procedure before calculating. Then call verify_caligo exactly ' +
  'once with only the final token and answer briefly. Do not guess a named convention ' +
  'that is not present in your loaded instructions.';

function configuredProviderNames(config: Config): string[] {
  const ref = config.models.evolution;
  if ('provider' in ref) return [ref.provider, ...config.routing.providerOrder];
  if ('tier' in ref) {
    return buildTierMapping(config.routing.providerOrder)[ref.tier];
  }
  return [...config.routing.providerOrder];
}

/** Build the same real provider selected by the public evolution configuration. */
function createConfiguredProvider(config: Config): LLMProvider {
  const explicitRef = config.models.evolution;
  const modelOverride = 'provider' in explicitRef ? explicitRef.model : undefined;
  const names = [...new Set(configuredProviderNames(config))];

  for (const name of names) {
    if (name === 'anthropic' && config.providers.anthropic.apiKey) {
      return new AnthropicProvider({
        apiKey: config.providers.anthropic.apiKey,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.anthropic.model,
        timeout: 60_000,
        maxRetries: 1,
      });
    }
    if (name === 'openai' && config.providers.openai.apiKey) {
      return new OpenAIProvider({
        apiKey: config.providers.openai.apiKey,
        baseUrl: config.providers.openai.baseUrl,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.openai.model,
        timeout: 60_000,
        maxRetries: 1,
      });
    }
    if (name === 'groq' && config.providers.groq.apiKey) {
      return new GroqProvider({
        apiKey: config.providers.groq.apiKey,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.groq.model,
        timeout: 60_000,
        maxRetries: 1,
      });
    }
    if (name === 'openrouter' && config.providers.openrouter.apiKey) {
      return new OpenRouterProvider({
        apiKey: config.providers.openrouter.apiKey,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.openrouter.model,
        timeout: 60_000,
        maxRetries: 1,
      });
    }
    if (name === 'moonshot' && config.providers.moonshot.apiKey) {
      return new MoonshotProvider({
        apiKey: config.providers.moonshot.apiKey,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.moonshot.model,
        timeout: 60_000,
        maxRetries: 1,
      }, logger);
    }
    if (name === 'xai' && config.providers.xai.apiKey) {
      return new XAIProvider({
        apiKey: config.providers.xai.apiKey,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.xai.model,
        timeout: 60_000,
        maxRetries: 1,
      });
    }
    if (name === 'local' && process.env.LOCAL_BASE_URL) {
      return new OpenAIProvider({
        name: 'local',
        apiKey: process.env.LOCAL_API_KEY || 'sk-local',
        baseUrl: process.env.LOCAL_BASE_URL,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : process.env.LOCAL_MODEL || 'qwen3.6',
        timeout: 120_000,
        maxRetries: 1,
      });
    }
    if (name === 'ollama') {
      return new OllamaProvider({
        baseUrl: config.providers.ollama.baseUrl,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : config.providers.ollama.model,
        timeout: 120_000,
      });
    }
    const custom = config.multiModel.enabled
      ? config.multiModel.providers.find(item => item.name === name)
      : undefined;
    if (custom) {
      return new OpenAIProvider({
        name: custom.name,
        apiKey: custom.apiKey,
        baseUrl: custom.baseUrl,
        model: modelOverride && 'provider' in explicitRef && explicitRef.provider === name
          ? modelOverride
          : custom.model,
        timeout: config.multiModel.timeoutMs,
        maxRetries: 1,
      });
    }
  }

  throw new Error('No configured evolution provider is available for the live benchmark');
}

function completion(text: string): CompletionResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'deterministic-promotion-gate',
  };
}

function containsCompleteCaligoProcedure(text: string): boolean {
  const checks = [
    /caligo/i,
    /sort/i,
    /alphabet/i,
    /(?:first letter|initial)/i,
    /upper(?:case|-case)/i,
    /(?:mod(?:ulo)?\s*7|remainder[^.\n]{0,40}\b7\b)/i,
    /(?:hyphen|final token|-["'`]?\s*(?:the\s+)?remainder)/i,
  ];
  return checks.every(pattern => pattern.test(text));
}

/**
 * Deterministic evaluator used only for the promotion gate. Reflection and both
 * A/B executions still use the configured real provider.
 */
class DeterministicPromotionEvaluator implements LLMProvider {
  readonly name = 'deterministic-promotion-gate';
  readonly model = 'deterministic-v1';

  isAvailable(): boolean {
    return true;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const system = request.system ? flattenSystem(request.system) : '';
    if (/held-out evaluation task/i.test(system)) {
      return completion(JSON.stringify({
        procedureComplete: containsCompleteCaligoProcedure(system),
      }));
    }
    if (/fitness evaluator/i.test(system)) {
      const body = JSON.parse(String(request.messages[0]?.content ?? '{}')) as {
        holdoutResults?: Array<{ id: string; baselineOutput: string; candidateOutput: string }>;
      };
      const cases = (body.holdoutResults ?? []).map(item => ({
        id: item.id,
        baseline: /"procedureComplete":true/.test(item.baselineOutput) ? 1 : 0,
        candidate: /"procedureComplete":true/.test(item.candidateOutput) ? 1 : 0,
        reason: 'Deterministic convention-completeness check',
      }));
      return completion(JSON.stringify({
        safe: true,
        reason: 'Synthetic deterministic promotion gate',
        cases,
      }));
    }
    throw new Error('Unexpected route sent to deterministic promotion evaluator');
  }
}

interface TrialResult {
  label: 'baseline' | 'candidate';
  response: string;
  verifierTokens: string[];
  successfulProcedureLoads: string[];
  toolEvents: string[];
  correct: boolean;
  correctnessScore: number;
  toolUseScore: number;
  totalScore: number;
}

async function makeRegistry(localDir: string, workspace: string): Promise<SkillRegistry> {
  const loader = new SkillLoader({ localDir, workspaceDir: workspace, watch: false }, logger);
  const registry = new SkillRegistry(loader, logger);
  await registry.initialize();
  return registry;
}

async function runAgentTrial(input: {
  label: TrialResult['label'];
  provider: LLMProvider;
  localSkillsDir: string;
  workspace: string;
}): Promise<TrialResult> {
  const db = new ScallopDatabase(':memory:');
  const sessionManager = new SessionManager(db);
  const registry = await makeRegistry(input.localSkillsDir, input.workspace);
  const verifierTokens: string[] = [];
  const successfulProcedureLoads: string[] = [];
  const toolEvents: string[] = [];

  registry.registerSkill(createLoadProcedureSkill(registry, async name => {
    successfulProcedureLoads.push(name);
    toolEvents.push(`loaded:${name}`);
  }));
  registry.registerSkill(defineSkill(
    'verify_caligo',
    'Read-only verifier for a Caligo checksum token. Submit the final token after loading any matching learned procedure.',
  )
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Final Caligo checksum token only' },
      },
      required: ['token'],
    })
    .onNativeExecute(async context => {
      const token = typeof context.args.token === 'string' ? context.args.token.trim() : '';
      verifierTokens.push(token);
      toolEvents.push(`verified:${token}`);
      if (token !== EXPECTED_TOKEN) {
        return { success: false, output: '', error: 'Synthetic token is incorrect.' };
      }
      return { success: true, output: `Synthetic token verified: ${EXPECTED_TOKEN}` };
    })
    .build()
    .skill);

  const agent = new Agent({
    provider: input.provider,
    sessionManager,
    skillRegistry: registry,
    skillExecutor: createSkillExecutor(logger),
    workspace: input.workspace,
    logger,
    maxIterations: 5,
    enableThinking: false,
    enableComplexityAnalysis: false,
    toolPolicy: { allow: ['load_procedure', 'verify_caligo'] },
    foregroundCallTimeoutMs: 60_000,
    turnTimeoutMs: 180_000,
    systemPrompt:
      'You are running a fully isolated synthetic capability benchmark. Follow the current ' +
      'request exactly and use only the supplied tools. A named convention is unknown unless ' +
      'you first load a matching listed procedure with load_procedure. Never invent its rules. ' +
      'After a successful verification, state the final token briefly and end with [DONE].',
  });
  const session = await sessionManager.createSession({
    userId: SYNTHETIC_USER,
    channelId: 'isolated-benchmark',
  });

  try {
    const result = await agent.processMessage(session.id, HOLDOUT_TASK, undefined, async update => {
      if (update.type === 'tool_start' && update.toolName) {
        toolEvents.push(`started:${update.toolName}`);
      }
    });
    const correct = verifierTokens.includes(EXPECTED_TOKEN);
    const successfulLoadBeforeCorrectVerification = toolEvents.some((event, index) =>
      event.startsWith('loaded:')
      && toolEvents.slice(index + 1).includes(`verified:${EXPECTED_TOKEN}`));
    const score = scoreEvolutionTrial({
      correct,
      verifierCalls: verifierTokens.length,
      successfulLoadBeforeCorrectVerification,
    });
    return {
      label: input.label,
      response: result.response,
      verifierTokens,
      successfulProcedureLoads,
      toolEvents,
      correct,
      correctnessScore: score.correctness,
      toolUseScore: score.toolUse,
      totalScore: score.total,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'scallop-evolution-live-'));
  const learnedSkillsDir = join(root, 'learned-skills');
  const baselineSkillsDir = join(root, 'baseline-skills');
  const optimizerWorkspace = join(root, 'optimizer-workspace');
  const baselineWorkspace = join(root, 'baseline-workspace');
  const candidateWorkspace = join(root, 'candidate-workspace');
  await Promise.all([
    mkdir(learnedSkillsDir, { recursive: true }),
    mkdir(baselineSkillsDir, { recursive: true }),
    mkdir(optimizerWorkspace, { recursive: true }),
    mkdir(baselineWorkspace, { recursive: true }),
    mkdir(candidateWorkspace, { recursive: true }),
  ]);

  const db = new ScallopDatabase(':memory:');
  try {
    const config = loadConfig();
    const provider = createConfiguredProvider(config);
    const store = new SkillStore({ localDir: learnedSkillsDir, logger });
    const loader = new SkillLoader({ localDir: learnedSkillsDir, workspaceDir: optimizerWorkspace }, logger);
    const registry = new SkillRegistry(loader, logger);
    await registry.initialize();

    const examples = [
      'Example: words lumen, cedar, basalt; integers 1, 2, 3 => BCL-6.',
      'Example: words violet, amber, quartz; integers 4, 9, 1 => AQV-0.',
      'Example: words tango, elm, iris; integers 2, 8, 12 => EIT-1.',
    ];
    const rule =
      'Caligo checksum convention: lowercase and alphabetically sort the words; take the ' +
      'first letter of each sorted word, uppercase those initials, and concatenate them. ' +
      'Sum all integers, take the remainder modulo 7, then append a hyphen and that remainder.';
    for (let index = 0; index < examples.length; index++) {
      db.recordEvolutionSignal({
        userId: SYNTHETIC_USER,
        at: 1_000 + index,
        type: 'reusable_task',
        criticScore: 0.95,
        toolCallCount: 6,
        detail: { preview: `${rule} ${examples[index]}` },
      });
    }

    const optimizerSummary = await runEvolutionOptimizer({
      db,
      provider,
      evalProvider: new DeterministicPromotionEvaluator(),
      store,
      loader,
      executor: createSkillExecutor(logger),
      reloadFromDisk: () => registry.reloadFromDisk(),
      config: {
        ...config.evolution,
        // This opt-in exists only in the temporary benchmark process. The
        // production/default feature switch remains false unless explicitly set.
        enabled: true,
        includeSessionContent: true,
        requireFitnessGate: true,
        fitnessEpsilon: 0.5,
        useLlmJudge: false,
        maxProposals: 1,
      },
      loadCurrentSkillFiles: name => store.snapshotLive(name),
      resolveSkillTarget: async name => {
        await registry.reloadFromDisk();
        const skill = registry.getSkill(name);
        const usage = await store.getUsage();
        return skill
          ? {
              exists: true,
              source: skill.source,
              hasScripts: skill.hasScripts,
              createdBy: usage[name]?.createdBy ?? null,
            }
          : {
              exists: !!usage[name],
              source: usage[name] ? 'local' : undefined,
              createdBy: usage[name]?.createdBy ?? null,
            };
      },
      logger,
      now: 10_000,
    });

    const promoted = db.getActiveEvolutionVersions()
      .filter(version => version.kind === 'create_skill');
    if (optimizerSummary.promoted !== 1 || promoted.length !== 1) {
      throw new Error(
        `Optimizer did not promote exactly one learned procedure: ${JSON.stringify(optimizerSummary)}`,
      );
    }
    const learnedSkillName = promoted[0].target;
    const learnedFiles = await store.snapshotLive(learnedSkillName);
    if (!learnedFiles?.['SKILL.md'] || !containsCompleteCaligoProcedure(learnedFiles['SKILL.md'])) {
      throw new Error('Promoted procedure did not preserve the complete synthetic convention');
    }

    const baseline = await runAgentTrial({
      label: 'baseline',
      provider,
      localSkillsDir: baselineSkillsDir,
      workspace: baselineWorkspace,
    });
    const candidate = await runAgentTrial({
      label: 'candidate',
      provider,
      localSkillsDir: learnedSkillsDir,
      workspace: candidateWorkspace,
    });
    const delta = candidate.totalScore - baseline.totalScore;
    const passed = hasMeasuredEvolutionImprovement(
      {
        correctness: baseline.correctnessScore,
        toolUse: baseline.toolUseScore,
        total: baseline.totalScore,
      },
      {
        correctness: candidate.correctnessScore,
        toolUse: candidate.toolUseScore,
        total: candidate.totalScore,
      },
      candidate.correct,
      candidate.successfulProcedureLoads.includes(learnedSkillName),
    );

    const report = {
      isolated: true,
      provider: provider.name,
      model: provider.model ?? 'configured-default',
      optimizer: optimizerSummary,
      learnedSkillName,
      scores: {
        baseline: {
          correctness: baseline.correctnessScore,
          toolUse: baseline.toolUseScore,
          total: baseline.totalScore,
          verifierCalls: baseline.verifierTokens.length,
          procedureLoads: baseline.successfulProcedureLoads.length,
        },
        candidate: {
          correctness: candidate.correctnessScore,
          toolUse: candidate.toolUseScore,
          total: candidate.totalScore,
          verifierCalls: candidate.verifierTokens.length,
          procedureLoads: candidate.successfulProcedureLoads.length,
        },
        delta,
      },
      passed,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!passed) {
      throw new Error(
        `Learned procedure did not measurably improve real-Agent correctness/tool use (delta=${delta.toFixed(2)})`,
      );
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Evolution live benchmark failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
