/**
 * ScallopBot-only LoCoMo eval on all 5 conversations (1,049 QA).
 * Run: npx vitest run -c /dev/null src/eval/locomo-scallopbot-quick.test.ts
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport } from './locomo-eval.js';
import { SCALLOPBOT_MODE } from './modes.js';

describe('LoCoMo ScallopBot Full', () => {
  it(
    'should run ScallopBot on all 5 conversations',
    async () => {
      const results = await runLoCoMo({
        dataPath: path.resolve(process.cwd(), 'data/locomo/locomo10.json'),
        outputPath: path.resolve(process.cwd(), 'results/locomo-scallopbot-quick.json'),
        modes: [SCALLOPBOT_MODE],
      });

      expect(results.modes).toHaveLength(1);
      expect(results.modes[0].mode).toBe('scallopbot');
      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
      expect(results.modes[0].overallF1).toBeLessThanOrEqual(1);

      const sb = results.modes[0];
      console.log('\n\n===== COMPARISON WITH BASELINE =====\n');
      console.log('Baseline (previous run):');
      console.log('  OpenClaw:   F1=0.39  EM=0.28');
      console.log('  ScallopBot: F1=0.42  EM=0.30');
      console.log('  SB Temporal=0.08  Adversarial=0.95');
      console.log(`\nNew ScallopBot: F1=${sb.overallF1.toFixed(3)}  EM=${sb.overallEM.toFixed(3)}  (${sb.llmCalls} LLM calls)`);
      console.log('\nF1 by Category:');
      console.log('  Category     | Baseline OC | Baseline SB | New SB');
      console.log('  -------------|-------------|-------------|-------');
      const cats = ['Single-hop', 'Temporal', 'Open-domain', 'Multi-hop', 'Adversarial'];
      const ocBaseline: Record<string, number> = { 'Single-hop': 0.12, 'Temporal': 0.10, 'Open-domain': 0.11, 'Multi-hop': 0.34, 'Adversarial': 0.96 };
      const sbBaseline: Record<string, number> = { 'Single-hop': 0.18, 'Temporal': 0.08, 'Open-domain': 0.11, 'Multi-hop': 0.41, 'Adversarial': 0.95 };
      for (const cat of cats) {
        const newVal = sb.f1ByCategory[cat] ?? 0;
        const delta = newVal - (ocBaseline[cat] ?? 0);
        console.log(`  ${cat.padEnd(13)} | ${(ocBaseline[cat] ?? 0).toFixed(2).padStart(11)} | ${(sbBaseline[cat] ?? 0).toFixed(2).padStart(11)} | ${newVal.toFixed(2).padStart(6)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs OC)`);
      }
    },
    { timeout: 7_200_000 },
  );
});
