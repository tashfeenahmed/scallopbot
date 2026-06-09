import { describe, it, expect, vi } from 'vitest';
import { judgeMutation, describeMutationForJudge } from './judge.js';
import type { LLMProvider, CompletionResponse } from '../providers/types.js';

function provider(text: string, throws = false): LLMProvider {
  return {
    name: 'judge',
    isAvailable: () => true,
    complete: throws
      ? vi.fn().mockRejectedValue(new Error('boom'))
      : vi.fn().mockResolvedValue({
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'judge',
        } as CompletionResponse),
  };
}

describe('judgeMutation', () => {
  it('approves a clean verdict', async () => {
    const v = await judgeMutation('desc', provider('{"approved":true,"reason":"safe"}'));
    expect(v.approved).toBe(true);
  });

  it('rejects an unsafe verdict', async () => {
    const v = await judgeMutation('desc', provider('{"approved":false,"reason":"rm -rf detected"}'));
    expect(v.approved).toBe(false);
    expect(v.reason).toContain('rm -rf');
  });

  it('fails open when no provider is available', async () => {
    const v = await judgeMutation('desc', undefined);
    expect(v.approved).toBe(true);
    expect(v.reason).toContain('fail-open');
  });

  it('fails open on a provider error', async () => {
    const v = await judgeMutation('desc', provider('', true));
    expect(v.approved).toBe(true);
  });

  it('fails open on an unparseable response', async () => {
    const v = await judgeMutation('desc', provider('the mutation looks fine to me'));
    expect(v.approved).toBe(true);
  });

  it('describeMutationForJudge includes kind, target and payload', () => {
    const d = describeMutationForJudge('patch_skill', 'web_search', 'name: web_search');
    expect(d).toContain('patch_skill');
    expect(d).toContain('web_search');
    expect(d).toContain('name: web_search');
  });
});
