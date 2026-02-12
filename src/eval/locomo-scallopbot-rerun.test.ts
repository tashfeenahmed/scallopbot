/**
 * LoCoMo ScallopBot Re-run — conv-30 only
 *
 * Runs ScallopBot with production fixes:
 *   1. Fusion/NREM no longer supersede originals (keep raw turns searchable)
 *   2. UPDATES relations no longer auto-supersede target memories
 *   3. Utility archival disabled during eval (batch ingestion has no retrieval)
 *   4. Reranking disabled to reduce LLM calls (405 memories × 105 QA is too slow)
 *
 * Saves standalone results to src/eval/locomo-scallopbot-rerun.json
 * and updates ScallopBot entry in results/locomo-results.json.
 *
 * Run: npx vitest run -c /dev/null src/eval/locomo-scallopbot-rerun.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport, type LoCoMoResults } from './locomo-eval.js';
import { SCALLOPBOT_MODE, type EvalModeConfig } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const EVAL_OUTPUT = path.resolve(import.meta.dirname, 'locomo-scallopbot-rerun.json');
const MAIN_RESULTS = path.resolve(process.cwd(), 'results/locomo-results.json');
const CONV_ID = new Set(['conv-30']);

// Override: disable reranking to avoid 105 extra LLM calls with 405 memories
const SCALLOPBOT_NO_RERANK: EvalModeConfig = {
  ...SCALLOPBOT_MODE,
  enableReranking: false,
};

describe('LoCoMo ScallopBot Re-run (archival fix)', () => {
  it(
    'should run ScallopBot on conv-30 with archival fix',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: EVAL_OUTPUT,
        selectedIds: CONV_ID,
        modes: [SCALLOPBOT_NO_RERANK],
      });

      const mode = results.modes[0];
      expect(mode.qaCount).toBe(105);
      expect(mode.overallF1).toBeGreaterThanOrEqual(0);

      // Save standalone eval results
      const evalResults = {
        ...results,
        fixes: [
          'fusion/NREM no longer supersede originals (production fix in memory.ts)',
          'UPDATES relations no longer auto-supersede target memories (db.ts)',
          'utility archival disabled during eval (disableArchival flag in memory.ts)',
          'reranking disabled for speed (405 memories too slow with LLM reranker)',
        ],
        baseline: { f1: 0.25, em: 0.22, llmCalls: 249 },
      };
      fs.writeFileSync(EVAL_OUTPUT, JSON.stringify(evalResults, null, 2), 'utf-8');
      console.log(`\n[saved] Eval results → ${EVAL_OUTPUT}`);

      // Update ScallopBot in main results
      try {
        const mainRaw = JSON.parse(fs.readFileSync(MAIN_RESULTS, 'utf-8')) as LoCoMoResults;
        const sbIdx = mainRaw.modes.findIndex(m => m.mode === 'scallopbot');
        if (sbIdx >= 0) {
          mainRaw.modes[sbIdx] = mode;
        } else {
          mainRaw.modes.push(mode);
        }
        mainRaw.timestamp = new Date().toISOString();
        fs.writeFileSync(MAIN_RESULTS, JSON.stringify(mainRaw, null, 2), 'utf-8');
        console.log(`[saved] Updated ScallopBot in → ${MAIN_RESULTS}`);
      } catch (e) {
        console.warn(`[warn] Could not update main results: ${(e as Error).message}`);
      }

      // Print comparison
      console.log('\n' + '='.repeat(64));
      console.log('  BEFORE vs AFTER — ScallopBot (conv-30, 105 QA)');
      console.log('='.repeat(64));
      console.log(`  Baseline F1: 0.25  →  New F1: ${mode.overallF1.toFixed(3)}`);
      console.log(`  Baseline EM: 0.22  →  New EM: ${mode.overallEM.toFixed(3)}`);
      console.log(`  LLM Calls:   249   →  New:    ${mode.llmCalls}`);
      console.log('');
      console.log('  F1 by Category:');
      for (const [cat, f1] of Object.entries(mode.f1ByCategory)) {
        const baseline: Record<string, number> = {
          'Single-hop': 0.07, 'Temporal': 0.00, 'Open-domain': 0.00,
          'Multi-hop': 0.05, 'Adversarial': 0.96,
        };
        const prev = baseline[cat] ?? 0;
        const delta = f1 - prev;
        console.log(`    ${cat.padEnd(14)} ${prev.toFixed(2)} → ${f1.toFixed(2)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
      }
      console.log('='.repeat(64));

      printLoCoMoReport(results);
    },
    { timeout: 1_800_000 },
  );
});
