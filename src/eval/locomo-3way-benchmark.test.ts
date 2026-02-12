/**
 * LoCoMo 3-Way Benchmark — conv-30 (19 sessions, 369 turns, 105 QA)
 *
 * Clean 3-way comparison after production search fixes:
 *   1. OpenClaw  — eval-only search (0.7 vec + 0.3 BM25), no lifecycle
 *   2. Mem0      — LLM fact extraction + cosine search + LLM dedup
 *   3. ScallopBot — production store.search() with full cognitive pipeline,
 *                   reranking disabled to avoid timeout (400+ memories × 105 QA)
 *
 * Run: npx vitest run -c /dev/null src/eval/locomo-3way-benchmark.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport, type LoCoMoResults } from './locomo-eval.js';
import { OPENCLAW_MODE, MEM0_MODE, SCALLOPBOT_MODE } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const OUTPUT_PATH = path.resolve(process.cwd(), 'results/locomo-3way-results.json');
const CONV_ID = new Set(['conv-30']);

/**
 * ScallopBot with production store.search() and LLM reranking.
 * Reranker refines top candidates per QA item (~105 extra LLM calls).
 */
const SCALLOPBOT_PROD = SCALLOPBOT_MODE;

describe('LoCoMo 3-Way Benchmark (Post Production Search Fixes)', () => {
  const modeResults: LoCoMoResults['modes'] = [];

  function saveProgress(label: string) {
    const results: LoCoMoResults = {
      timestamp: new Date().toISOString(),
      model: 'kimi-k2.5',
      conversations: 1,
      totalQA: 105,
      modes: [...modeResults],
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n[saved] ${label} → ${OUTPUT_PATH}`);
    printLoCoMoReport(results);
  }

  it(
    'should run OpenClaw on conv-30',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: OUTPUT_PATH,
        selectedIds: CONV_ID,
        modes: [OPENCLAW_MODE],
      });
      modeResults.push(...results.modes);
      saveProgress('OpenClaw done');

      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].qaCount).toBe(105);
    },
    { timeout: 600_000 },
  );

  it(
    'should run Mem0 on conv-30',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: OUTPUT_PATH,
        selectedIds: CONV_ID,
        modes: [MEM0_MODE],
      });
      modeResults.push(...results.modes);
      saveProgress('OpenClaw + Mem0 done');

      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].qaCount).toBe(105);
    },
    { timeout: 1_200_000 },
  );

  it(
    'should run ScallopBot (no rerank) on conv-30',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: OUTPUT_PATH,
        selectedIds: CONV_ID,
        modes: [SCALLOPBOT_PROD],
      });
      modeResults.push(...results.modes);
      saveProgress('All 3 modes done');

      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].qaCount).toBe(105);
    },
    { timeout: 1_200_000 },
  );

  it('should print final comparison', () => {
    expect(modeResults.length).toBe(3);

    const final: LoCoMoResults = {
      timestamp: new Date().toISOString(),
      model: 'kimi-k2.5',
      conversations: 1,
      totalQA: 105,
      modes: modeResults,
    };

    console.log('\n\n' + '='.repeat(64));
    console.log('  FINAL RESULTS — LoCoMo 3-Way Benchmark (conv-30, 105 QA)');
    console.log('='.repeat(64));
    printLoCoMoReport(final);

    // Save final
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(final, null, 2), 'utf-8');
  });
});
