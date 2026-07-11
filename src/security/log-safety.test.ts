import { describe, expect, it } from 'vitest';
import { sanitizeLogValue } from './log-safety.js';

describe('structured log safety', () => {
  it('removes message/tool/LLM payloads while retaining bounded diagnostics', () => {
    expect(sanitizeLogValue({
      userId: 'telegram:42',
      message: 'private health update',
      nested: { toolInput: { token: 'secret' }, goal: 'private task goal', count: 3 },
      error: 'Bearer abcdefghijklmnop was rejected',
    })).toEqual(expect.objectContaining({
      userId: expect.stringMatching(/^telegram:id_[a-f0-9]{12}$/),
      message: '[REDACTED_PAYLOAD]',
      nested: { toolInput: '[REDACTED_PAYLOAD]', goal: '[REDACTED_PAYLOAD]', count: 3 },
      error: 'Bearer [REDACTED] was rejected',
    }));
  });
});
