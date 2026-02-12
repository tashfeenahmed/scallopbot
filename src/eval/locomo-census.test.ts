/**
 * LoCoMo Memory Census — compare what OpenClaw vs ScallopBot actually store
 *
 * Run: npx vitest run -c /dev/null src/eval/locomo-census.test.ts
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runLoCoMo } from './locomo-eval.js';
import { OPENCLAW_MODE, SCALLOPBOT_MODE } from './modes.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');
const CONV_ID = new Set(['conv-30']);

describe('LoCoMo Memory Census', () => {
  it(
    'OpenClaw memory count',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: '/tmp/locomo-census-openclaw.json',
        selectedIds: CONV_ID,
        modes: [OPENCLAW_MODE],
      });
      expect(results.modes[0].qaCount).toBe(105);
    },
    { timeout: 600_000 },
  );

  it(
    'ScallopBot memory count',
    async () => {
      const results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: '/tmp/locomo-census-scallopbot.json',
        selectedIds: CONV_ID,
        modes: [SCALLOPBOT_MODE],
      });
      expect(results.modes[0].qaCount).toBe(105);
    },
    { timeout: 600_000 },
  );
});
