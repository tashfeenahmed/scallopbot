import { describe, expect, it } from 'vitest';
import { buildStructuredSubAgentResult } from './result.js';

describe('structured sub-agent results', () => {
  it('requires explicit acceptance when criteria were requested', () => {
    const result = buildStructuredSubAgentResult({
      response: JSON.stringify({ status: 'succeeded', summary: 'Implemented', acceptancePassed: false }),
      runtimeStatus: 'succeeded',
      acceptanceCriteria: ['tests pass'],
    });
    expect(result.status).toBe('blocked');
    expect(result.acceptancePassed).toBe(false);
  });

  it('never lets model-authored success override a runtime failure', () => {
    const result = buildStructuredSubAgentResult({
      response: JSON.stringify({ status: 'succeeded', summary: 'Everything worked', acceptancePassed: true }),
      runtimeStatus: 'failed',
      additionalBlockers: ['tool execution failed'],
    });
    expect(result.status).toBe('failed');
    expect(result.acceptancePassed).toBe(false);
    expect(result.blockers).toContain('tool execution failed');
  });

  it('removes hidden reasoning before a completion can be pushed to a user', () => {
    const result = buildStructuredSubAgentResult({
      response: '<think>I should send a check-in because...</think>\nThe deployment check passed.',
      runtimeStatus: 'succeeded',
    });
    expect(result.summary).toBe('The deployment check passed.');
    expect(result.summary).not.toContain('I should send');
  });

  it('discards a model planning preamble before a trailing structured result', () => {
    const result = buildStructuredSubAgentResult({
      response: 'I need to calculate 17 plus 25.\n\n{"status":"succeeded","summary":"Calculated 17 + 25 = 42","artifacts":[],"changedFiles":[],"tests":[],"blockers":[],"nextActions":[],"acceptancePassed":true}',
      runtimeStatus: 'succeeded',
    });
    expect(result.summary).toBe('Calculated 17 + 25 = 42');
    expect(result.summary).not.toContain('I need');
  });
});
