/**
 * LoCoMo run for the public site: the five-conversation, 1,049-QA subset used
 * by the published figures, with a hard spend cap.
 *
 *   LOCOMO_MODES=openclaw,scallopbot LOCOMO_CONVS=conv-26 LOCOMO_MAX_COST=12 \
 *   LOCOMO_BALANCE_FLOOR=38 LOCOMO_OUT=results/x.json npm run bench:locomo
 *
 * Runs inside vitest because the harness replays sessions on a fake clock.
 *
 * Model: MODEL_EVAL=moonshot:<model> (default kimi-k2.6). Embeddings: local
 * Ollama nomic-embed-text, as in the published run. Spend is computed from
 * the provider's token counts at Moonshot list prices; the run also stops
 * when the account balance is at or below the floor.
 */
import path from 'node:path';
import { it } from 'vitest';
import { runLoCoMo } from './locomo-eval.js';
import { OPENCLAW_MODE, MEM0_MODE, SCALLOPBOT_MODE, SCALLOPBOT_RERANK_MODE, type EvalModeConfig } from './modes.js';
import { createBudgetGuard } from '../../evals/agentic/budget.js';

/** USD per million tokens: uncached input, cached input, output. */
const PRICES: Record<string, [number, number, number]> = {
  'kimi-k2.6': [0.95, 0.19, 4],
  'kimi-k2.7-code': [0.95, 0.19, 4],
  'kimi-k3': [3, 0.3, 15],
};

const PUBLISHED_CONVERSATIONS = ['conv-26', 'conv-41', 'conv-42', 'conv-44', 'conv-48'];
const MODES: Record<string, EvalModeConfig> = {
  openclaw: OPENCLAW_MODE,
  mem0: MEM0_MODE,
  scallopbot: SCALLOPBOT_MODE,
  'scallopbot-rerank': SCALLOPBOT_RERANK_MODE,
};

function arg(name: string): string | undefined {
  return process.env[`LOCOMO_${name.toUpperCase().replace(/-/g, '_')}`] || undefined;
}

async function main(): Promise<void> {
  process.env.MODEL_EVAL ??= 'moonshot:kimi-k2.6';
  const model = process.env.MODEL_EVAL.replace(/^moonshot:/, '');
  const prices = PRICES[model];
  if (!prices) throw new Error(`No price for ${model}; add it to PRICES before spending on it`);

  const modes = (arg('modes') ?? 'openclaw,scallopbot').split(',').map((name) => {
    const mode = MODES[name.trim()];
    if (!mode) throw new Error(`Unknown mode ${name}`);
    return mode;
  });
  const convs = new Set((arg('convs') ?? PUBLISHED_CONVERSATIONS.join(',')).split(',').map((id) => id.trim()));
  const maxCost = Number(arg('max-cost') ?? 12);
  const balanceOk = createBudgetGuard(Number(arg('balance-floor') ?? 38), { log: (line) => console.error(line) });

  // Spend so far across all modes of this run (each mode has its own provider).
  let spentBefore = 0;
  let lastModeCost = 0;
  const costOf = (usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) =>
    ((usage.inputTokens - usage.cachedInputTokens) * prices[0]
      + usage.cachedInputTokens * prices[1]
      + usage.outputTokens * prices[2]) / 1_000_000;

  const outputPath = path.resolve(arg('out') ?? `results/locomo-landing-${model}-${new Date().toISOString().slice(0, 10)}.json`);
  const results = await runLoCoMo({
    dataPath: path.resolve('data/locomo/locomo10.json'),
    outputPath,
    selectedIds: convs,
    modes,
    canSpend: async (usage) => {
      const modeCost = costOf(usage);
      if (modeCost < lastModeCost) spentBefore += lastModeCost; // a new mode started
      lastModeCost = modeCost;
      const total = spentBefore + modeCost;
      console.error(`[budget] spent so far $${total.toFixed(3)} of $${maxCost.toFixed(2)}`);
      if (total >= maxCost) {
        console.error('[budget] cost cap reached; stopping');
        return false;
      }
      return balanceOk();
    },
  });

  let totalCost = 0;
  for (const mode of results.modes) {
    const cost = mode.usage ? costOf(mode.usage) : 0;
    totalCost += cost;
    console.log(`${mode.label}: F1 ${mode.overallF1.toFixed(4)} EM ${mode.overallEM.toFixed(4)} over ${mode.qaCount} QA, ${mode.llmCalls} LLM calls, $${cost.toFixed(3)}${mode.partial ? ' (PARTIAL)' : ''}`);
  }
  console.log(`total cost $${totalCost.toFixed(3)}; results: ${path.relative(process.cwd(), outputPath)}`);
}

it('LoCoMo landing-page run', main, 24 * 60 * 60 * 1000);
