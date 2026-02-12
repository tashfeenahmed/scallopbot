/**
 * LoCoMo Final 2-Way Eval — OpenClaw vs ScallopBot (3 conversations)
 *
 * Final benchmark after production search optimizations (af900ab):
 *   - No candidate limit, no prominence penalty
 *   - includeAllSources, minScore 0.35, reranking enabled
 *
 * Conversations:
 *   conv-30: 19 sessions, 369 turns, 105 QA (small)
 *   conv-42: 29 sessions, 629 turns, 260 QA (large)
 *   conv-49: 25 sessions, 509 turns, 196 QA (medium)
 *   Total: 561 QA items
 *
 * Run: npx vitest run -c /dev/null src/eval/locomo-final-eval.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport, type LoCoMoResults } from './locomo-eval.js';
import { OPENCLAW_MODE, SCALLOPBOT_MODE } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const OUTPUT_PATH = path.resolve(process.cwd(), 'results/locomo-final-eval.json');
const CONV_IDS = new Set(['conv-30', 'conv-42', 'conv-49']);
const TOTAL_QA = 561;

describe('LoCoMo Final Eval: OpenClaw vs ScallopBot (3 conversations)', () => {
  const modeResults: LoCoMoResults['modes'] = [];

  function saveProgress(label: string) {
    const results: LoCoMoResults = {
      timestamp: new Date().toISOString(),
      model: 'kimi-k2.5',
      conversations: 3,
      totalQA: TOTAL_QA,
      modes: [...modeResults],
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n[saved] ${label} → ${OUTPUT_PATH}`);
    printLoCoMoReport(results);
  }

  it(
    'should run OpenClaw on 3 conversations',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: OUTPUT_PATH,
        selectedIds: CONV_IDS,
        modes: [OPENCLAW_MODE],
      });
      modeResults.push(...results.modes);
      saveProgress('OpenClaw done');

      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].qaCount).toBe(TOTAL_QA);
      expect(results.modes[0].perConversation).toHaveLength(3);
    },
    { timeout: 1_800_000 },
  );

  it(
    'should run ScallopBot on 3 conversations',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: OUTPUT_PATH,
        selectedIds: CONV_IDS,
        modes: [SCALLOPBOT_MODE],
      });
      modeResults.push(...results.modes);
      saveProgress('OpenClaw + ScallopBot done');

      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].qaCount).toBe(TOTAL_QA);
      expect(results.modes[0].perConversation).toHaveLength(3);
    },
    { timeout: 3_600_000 },
  );

  it('should print final comparison and save results', () => {
    expect(modeResults.length).toBe(2);

    const final: LoCoMoResults = {
      timestamp: new Date().toISOString(),
      model: 'kimi-k2.5',
      conversations: 3,
      totalQA: TOTAL_QA,
      modes: modeResults,
    };

    console.log('\n\n' + '='.repeat(64));
    console.log('  FINAL RESULTS — OpenClaw vs ScallopBot (3 convs, 561 QA)');
    console.log('='.repeat(64));
    printLoCoMoReport(final);

    // Save final results
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(final, null, 2), 'utf-8');
    console.log(`\nFinal results saved to: ${OUTPUT_PATH}`);
  });
});
