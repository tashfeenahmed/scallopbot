import { describe, expect, it, vi } from 'vitest';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';
import { evaluateArtifactFitness } from './fitness.js';
import { judgeMutation } from './judge.js';
import { reflectOnCluster, reflectOnPromptCluster, type SignalCluster } from './reflect.js';

function response(text: string): CompletionResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'structured-test',
  };
}

function capturingProvider(outputs: string[]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: 'structured-test',
    requests,
    isAvailable: () => true,
    complete: vi.fn(async request => {
      requests.push(request);
      return response(outputs.shift() ?? '');
    }),
  };
}

const cluster: SignalCluster = {
  key: 'new-skill',
  intent: 'create_skill',
  signals: [{ id: 1, userId: 'synthetic', at: 1, type: 'reusable_task' }],
};

describe('evolution structured-output routes', () => {
  it('requests a strict documentation-skill schema and disables thinking', async () => {
    const provider = capturingProvider([JSON.stringify({
      target: 'synthetic_procedure',
      rationale: 'Repeated synthetic work',
      files: { 'SKILL.md': '---\nname: synthetic_procedure\ndescription: Synthetic procedure\nuser-invocable: false\n---\nUse it.' },
    })]);

    expect(await reflectOnCluster(cluster, provider)).not.toBeNull();
    expect(provider.requests[0]).toMatchObject({
      enableThinking: false,
      purpose: 'evolution_reflect',
      structuredOutput: { name: 'evolution_skill_mutation', strict: true },
    });
    expect(provider.requests[0].structuredOutput?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['target', 'rationale', 'files'],
    });
  });

  it('requests a strict prompt-mutation schema', async () => {
    const provider = capturingProvider([JSON.stringify({
      fragmentId: 'learned_guidance',
      rationale: 'Repeated response issue',
      content: 'Verify the result before claiming success.',
    })]);
    const promptCluster: SignalCluster = {
      ...cluster,
      key: 'learned_guidance',
      intent: 'patch_prompt',
    };

    expect(await reflectOnPromptCluster(promptCluster, provider)).not.toBeNull();
    expect(provider.requests[0].structuredOutput).toMatchObject({
      name: 'evolution_prompt_mutation',
      strict: true,
    });
  });

  it('requests a strict fail-closed safety-verdict schema', async () => {
    const provider = capturingProvider(['{"approved":true,"reason":"safe"}']);
    expect((await judgeMutation('synthetic candidate', provider)).approved).toBe(true);
    expect(provider.requests[0]).toMatchObject({
      enableThinking: false,
      purpose: 'evolution_judge',
      structuredOutput: { name: 'evolution_safety_verdict', strict: true },
    });
  });

  it('requests an exact strict fitness schema for all holdout ids', async () => {
    const provider = capturingProvider([
      'baseline output',
      'candidate output',
      JSON.stringify({
        safe: true,
        reason: 'candidate improves the held-out case',
        cases: [{ id: 'held-out-1', baseline: 0.2, candidate: 0.9, reason: 'correct' }],
      }),
    ]);
    const result = await evaluateArtifactFitness(
      { kind: 'skill', target: 'synthetic', baseline: '', candidate: 'procedure' },
      [{ id: 'held-out-1', task: 'Apply the synthetic convention.' }],
      provider,
      0.1,
    );

    expect(result.passed).toBe(true);
    const request = provider.requests.at(-1)!;
    expect(request).toMatchObject({
      enableThinking: false,
      purpose: 'evolution_fitness',
      structuredOutput: { name: 'evolution_fitness_scores', strict: true },
    });
    expect(request.structuredOutput?.schema).toMatchObject({
      properties: {
        cases: {
          minItems: 1,
          maxItems: 1,
          items: { properties: { id: { enum: ['held-out-1'] } } },
        },
      },
    });
  });
});
