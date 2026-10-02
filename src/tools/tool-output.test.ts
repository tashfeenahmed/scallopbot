import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capHeadTail, persistLargeOutput, persistThreshold, readFileHeadTail, toolOutputDir } from './tool-output.js';

describe('tool output persistence', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tool-output-'));
    saved = process.env.SCALLOPBOT_HOME;
    process.env.SCALLOPBOT_HOME = root;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SCALLOPBOT_HOME;
    else process.env.SCALLOPBOT_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('threshold is max(8000, 15% of the window in chars)', () => {
    expect(persistThreshold()).toBe(8_000);
    expect(persistThreshold({ contextWindowTokens: 8_000 })).toBe(8_000);
    expect(persistThreshold({ contextWindowTokens: 200_000 })).toBe(120_000);
    expect(persistThreshold({ threshold: 100 })).toBe(100);
  });

  it('returns small output unchanged', () => {
    expect(persistLargeOutput('s', 'grep', 'short')).toBe('short');
  });

  it('persists large output with path, size, a 1,500-char preview and a read hint', () => {
    const text = 'A'.repeat(1_000) + 'B'.repeat(1_000) + 'C'.repeat(10_000);
    const out = persistLargeOutput('sess/1', 'mcp_tool', text);
    const m = out.match(/^<persisted-output path="([^"]+)" bytes="12000" chars="12000">/);
    expect(m).toBeTruthy();
    expect(m![1].startsWith(join(root, 'tool-output', 'sess_1'))).toBe(true);
    expect(readFileSync(m![1], 'utf8')).toBe(text);
    expect(out).toContain('A'.repeat(1_000) + 'B'.repeat(500));
    expect(out).not.toContain('C');
    expect(out).toMatch(/read_file with offset\/limit/);
    expect(out.length).toBeLessThan(2_200);
  });

  it('read_file is exempt, and already-persisted output is not re-persisted', () => {
    const big = 'x'.repeat(20_000);
    expect(persistLargeOutput('s', 'read_file', big)).toBe(big);
    const once = persistLargeOutput('s', 'bash', big, { threshold: 100 });
    expect(persistLargeOutput('s', 'bash', once, { threshold: 100 })).toBe(once);
  });

  it('capHeadTail keeps 40% head and 60% tail with a marker', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `${i}`).join(',');
    const capped = capHeadTail(text, 100);
    expect(capped.startsWith(text.slice(0, 40))).toBe(true);
    expect(capped.endsWith(text.slice(-60))).toBe(true);
    expect(capped).toMatch(/chars omitted of/);
  });

  it('readFileHeadTail reads only the ends of a big file', () => {
    const file = join(toolOutputDir('s'), 'big.txt');
    writeFileSync(file, 'H'.repeat(100) + 'M'.repeat(1_000_000) + 'T'.repeat(100));
    const r = readFileHeadTail(file, 1_000);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(1_000_200);
    expect(r.text.startsWith('H'.repeat(100))).toBe(true);
    expect(r.text.endsWith('T'.repeat(100))).toBe(true);
    expect(r.text.length).toBeLessThan(1_100);
  });
});
