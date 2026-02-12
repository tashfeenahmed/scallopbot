/**
 * LoCoMo ScallopBot-Tuned — eval-only search optimizations
 *
 * Same cognitive pipeline as ScallopBot (fusion, NREM, decay) but with
 * optimized retrieval (no prominence penalty, 0.7 semantic, rank-based BM25,
 * minScore=0.35, all candidates).
 *
 * Run: npx vitest run -c /dev/null src/eval/locomo-scallopbot-tuned.test.ts
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport } from './locomo-eval.js';
import { SCALLOPBOT_TUNED_MODE } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const CONV_ID = new Set(['conv-30']);

describe('LoCoMo ScallopBot-Tuned', () => {
  it(
    'should run ScallopBot-Tuned on conv-30',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: '/tmp/locomo-scallopbot-tuned.json',
        selectedIds: CONV_ID,
        modes: [SCALLOPBOT_TUNED_MODE],
      });

      const mode = results.modes[0];
      expect(mode.qaCount).toBe(105);

      console.log('\n' + '='.repeat(64));
      console.log('  ScallopBot-Tuned vs Others (conv-30, 105 QA)');
      console.log('='.repeat(64));
      console.log(`  OpenClaw:         F1=0.36  (baseline)`);
      console.log(`  ScallopBot:       F1=0.29  (with archival fix)`);
      console.log(`  ScallopBot-Tuned: F1=${mode.overallF1.toFixed(3)}`);
      console.log('');
      console.log('  F1 by Category:');
      const baselines: Record<string, { oc: number; sb: number }> = {
        'Single-hop':  { oc: 0.11, sb: 0.07 },
        'Temporal':    { oc: 0.04, sb: 0.00 },
        'Multi-hop':   { oc: 0.31, sb: 0.16 },
        'Adversarial': { oc: 0.92, sb: 0.96 },
      };
      for (const [cat, f1] of Object.entries(mode.f1ByCategory)) {
        const b = baselines[cat] ?? { oc: 0, sb: 0 };
        console.log(`    ${cat.padEnd(14)} OC=${b.oc.toFixed(2)}  SB=${b.sb.toFixed(2)}  Tuned=${f1.toFixed(2)}`);
      }
      console.log('='.repeat(64));

      printLoCoMoReport(results);
    },
    { timeout: 1_800_000 },
  );
});
