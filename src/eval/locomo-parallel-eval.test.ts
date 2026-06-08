/**
 * LoCoMo Parallel Eval — OpenClaw & ScallopBot, one test per conversation.
 *
 * Run OpenClaw conv-26:  npx vitest run -c /dev/null src/eval/locomo-parallel-eval.test.ts -t "oc-conv-26"
 * Run ScallopBot conv-26: npx vitest run -c /dev/null src/eval/locomo-parallel-eval.test.ts -t "sb-conv-26"
 */

import * as path from 'node:path';
import { it, expect } from 'vitest';
import { runLoCoMo, printLoCoMoReport } from './locomo-eval.js';
import { OPENCLAW_MODE, SCALLOPBOT_MODE } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const CONVS = ['conv-26', 'conv-41', 'conv-42', 'conv-44', 'conv-48'];

for (const conv of CONVS) {
  it(
    `oc-${conv}`,
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: path.resolve(process.cwd(), `results/locomo-oc-${conv}.json`),
        selectedIds: new Set([conv]),
        modes: [OPENCLAW_MODE],
      });
      printLoCoMoReport(results);
      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
    },
    { timeout: 600_000 },
  );
}

for (const conv of CONVS) {
  it(
    `sb-${conv}`,
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: path.resolve(process.cwd(), `results/locomo-sb-${conv}.json`),
        selectedIds: new Set([conv]),
        modes: [SCALLOPBOT_MODE],
      });
      printLoCoMoReport(results);
      expect(results.modes[0].overallF1).toBeGreaterThanOrEqual(0);
    },
    { timeout: 3_600_000 },
  );
}
