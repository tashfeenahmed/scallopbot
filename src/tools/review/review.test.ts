import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../providers/types.js';
import { buildReviewMessage, changedFilesSince, parseVerdict, reviewNote, reviewOnStop } from './review.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws-'));
}

function touchOld(file: string): void {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
}

function fakeProvider(reply: string, seen: CompletionRequest[] = []): LLMProvider {
  return {
    name: 'fake',
    complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
      seen.push(request);
      return { content: [{ type: 'text', text: reply }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'fake' };
    },
  } as unknown as LLMProvider;
}

describe('changedFilesSince', () => {
  it('returns only text files changed after the turn started, skipping dependency dirs', async () => {
    const ws = workspace();
    try {
      fs.mkdirSync(path.join(ws, 'src'));
      fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'src', 'old.js'), 'old');
      touchOld(path.join(ws, 'src', 'old.js'));
      const since = Date.now() - 1_000;
      fs.writeFileSync(path.join(ws, 'src', 'new.js'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(ws, 'report.json'), '{"ok":true}');
      fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'index.js'), 'ignored');
      fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([1, 0, 2]));
      const files = await changedFilesSince(ws, since);
      expect(files.map(f => f.path).sort()).toEqual(['report.json', path.join('src', 'new.js')].sort());
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('reviewOnStop', () => {
  it('returns null without calling the model when nothing changed', async () => {
    const ws = workspace();
    const seen: CompletionRequest[] = [];
    try {
      const result = await reviewOnStop({ workspace: ws, requests: ['do it'], reply: 'done', turnStartedAt: Date.now(), provider: fakeProvider('1. bug', seen) });
      expect(result).toBeNull();
      expect(seen).toHaveLength(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns null on LGTM and the findings otherwise', async () => {
    const ws = workspace();
    try {
      const since = Date.now() - 1_000;
      fs.writeFileSync(path.join(ws, 'a.js'), 'export const f = () => 1;\n');
      const seen: CompletionRequest[] = [];
      expect(await reviewOnStop({ workspace: ws, requests: ['write f'], reply: 'done', turnStartedAt: since, provider: fakeProvider('Looks fine.\nVERDICT: LGTM', seen) })).toBeNull();
      expect(seen[0]!.purpose).toBe('review');
      expect(seen[0]!.tools).toBeUndefined();
      const body = seen[0]!.messages[0]!.content as string;
      expect(body).toContain('write f');
      expect(body).toContain('=== a.js ===');
      const findings = await reviewOnStop({ workspace: ws, requests: ['write f'], reply: 'done', turnStartedAt: since, provider: fakeProvider('Checked f.\nVERDICT: FINDINGS\n1. f(0) returns 1') });
      expect(findings).toBe('1. f(0) returns 1');
      expect(reviewNote(findings!)).toMatch(/^\[System: review\]/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('never throws when the model call fails', async () => {
    const ws = workspace();
    try {
      fs.writeFileSync(path.join(ws, 'a.js'), 'x');
      const provider = { name: 'x', complete: async () => { throw new Error('down'); } } as unknown as LLMProvider;
      expect(await reviewOnStop({ workspace: ws, requests: ['r'], reply: '', turnStartedAt: 0, provider })).toBeNull();
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('buildReviewMessage', () => {
  it('numbers multiple requests and marks truncated files', () => {
    const text = buildReviewMessage(['first', 'then this'], 'ok', [{ path: 'a.txt', content: 'abc', truncated: true }]);
    expect(text).toContain('(1) first');
    expect(text).toContain('(2) then this');
    expect(text).toContain('=== a.txt (truncated) ===');
  });
});

describe('parseVerdict', () => {
  it('reads the last verdict and ignores replies without one', () => {
    expect(parseVerdict('VERDICT: LGTM')).toBeNull();
    expect(parseVerdict('maybe a bug?')).toBeNull();
    expect(parseVerdict('**VERDICT: FINDINGS**\n1. x')).toBe('1. x');
    expect(parseVerdict('Earlier I wrote VERDICT: FINDINGS but on reflection\nVERDICT: LGTM')).toBeNull();
    expect(parseVerdict('VERDICT: FINDINGS')).toBeNull();
  });
});
