import { describe, expect, it } from 'vitest';
import { environmentSecrets, redactSensitiveText } from './redaction.js';

describe('redactSensitiveText', () => {
  it('redacts exact secret environment values without redacting ordinary config', () => {
    const env = {
      API_KEY: 'super-secret-value',
      AGENT_WORKSPACE: '/tmp/workspace',
    } as NodeJS.ProcessEnv;
    expect(environmentSecrets(env)).toEqual(['super-secret-value']);
    expect(redactSensitiveText(
      'key=super-secret-value workspace=/tmp/workspace',
      [],
      env,
    )).toBe('key=[REDACTED] workspace=/tmp/workspace');
  });

  it('redacts common bearer, OpenAI, GitHub and JSON token formats', () => {
    const input = 'Bearer abcdefghijklmnop sk-abcdefghijklmnop ghp_abcdefghijklmnop {"token":"very-private-token"}';
    const output = redactSensitiveText(input, [], {});
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('very-private-token');
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
