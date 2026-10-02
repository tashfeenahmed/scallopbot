/**
 * Web Search Skill Execution Script (subprocess fallback).
 *
 * The gateway serves web_search in-process (src/tools/web) with a 20-minute
 * single-flight cache; this script exists for standalone skill execution.
 * Receives arguments via the SKILL_ARGS environment variable.
 */

import { braveSearch, parseSearchArgs } from '../../../../tools/web/search.js';

function outputResult(result: { success: boolean; output: string; error?: string }): never {
  console.log(JSON.stringify({ ...result, exitCode: result.success ? 0 : 1 }));
  process.exit(result.success ? 0 : 1);
}

async function main(): Promise<void> {
  const raw = process.env.SKILL_ARGS;
  if (!raw) outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set' });
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON in SKILL_ARGS: ${(e as Error).message}` });
  }
  if (!args || typeof args !== 'object') outputResult({ success: false, output: '', error: 'SKILL_ARGS must be a JSON object' });
  const parsed = parseSearchArgs(args as Record<string, unknown>);
  if ('error' in parsed) outputResult({ success: false, output: '', error: parsed.error });
  const result = await braveSearch(parsed);
  outputResult(result.success ? result : { success: false, output: '', error: result.output });
}

void main();
