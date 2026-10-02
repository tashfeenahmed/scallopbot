import { it, expect } from 'vitest';
// Regression: a probe's background child once held the stdout pipe open and hung the turn.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkOnStop } from './check.js';
it('a probe that leaves a background process holding the pipe does not hang the check', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-'));
  fs.writeFileSync(path.join(ws, 'a.js'), 'x');
  let n = 0;
  const provider = { name: 'f', complete: async () => (++n === 1
    ? { content: [{ type: 'tool_use', id: 't', name: 'run', input: { language: 'bash', code: 'sleep 300 &\necho started' } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'f' }
    : { content: [{ type: 'text', text: 'VERDICT: LGTM' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'f' }) } as any;
  const t0 = Date.now();
  await checkOnStop({ workspace: ws, requests: ['r'], reply: '', turnStartedAt: Date.now() - 1000, provider, timeoutMs: 10_000 });
  expect(Date.now() - t0).toBeLessThan(30_000);
}, 60_000);
