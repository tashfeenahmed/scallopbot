import { beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { defineSkill } from '../skills/sdk.js';
import { createSkillRegistry } from '../skills/registry.js';
import { createSkillExecutor } from '../skills/executor.js';
import { SafeWorkflowExecutor } from './executor.js';

const logger = pino({ level: 'silent' });

describe('SafeWorkflowExecutor', () => {
  let registry: ReturnType<typeof createSkillRegistry>;
  let executor: SafeWorkflowExecutor;
  const downstream = vi.fn();

  beforeEach(async () => {
    downstream.mockReset();
    registry = createSkillRegistry('/tmp/workflow-empty-skills', logger);
    await registry.initialize();

    registry.registerSkill(defineSkill('source', 'test source')
      .onNativeExecute(async () => ({ success: true, output: `private:${'x'.repeat(2_000)}` }))
      .build().skill);
    registry.registerSkill(defineSkill('transform', 'test transform')
      .onNativeExecute(async (context) => {
        downstream(context.args);
        return { success: true, output: `processed:${String(context.args.value).slice(0, 20)}` };
      })
      .build().skill);
    registry.registerSkill(defineSkill('failure', 'test failure')
      .onNativeExecute(async () => ({ success: false, output: '', error: 'expected failure' }))
      .build().skill);
    registry.registerSkill(defineSkill('leaky_failure', 'failure containing private tool content')
      .onNativeExecute(async () => ({
        success: false,
        output: 'private-output-must-not-leak',
        error: `private-error-must-not-leak:${'🔒'.repeat(10_000)}`,
      }))
      .build().skill);
    registry.registerSkill(defineSkill('bash', 'unsafe test tool')
      .onNativeExecute(async () => ({ success: true, output: 'should never run' }))
      .build().skill);

    executor = new SafeWorkflowExecutor({
      skillRegistry: registry,
      skillExecutor: createSkillExecutor(logger),
      logger,
      allowlist: ['source', 'transform', 'failure'],
      maxExposedOutputBytes: 1_024,
    });
  });

  it('passes hidden intermediate output to a dependent tool without returning it to the model', async () => {
    const report = await executor.execute({
      steps: [
        { id: 'fetch', tool: 'source', expose: false },
        {
          id: 'summarize',
          tool: 'transform',
          args: { value: '{{fetch.output}}' },
          dependsOn: ['fetch'],
          expose: true,
        },
      ],
    }, { workspace: '/tmp', sessionId: 'session-1' });

    expect(report.success).toBe(true);
    expect(downstream).toHaveBeenCalledWith(expect.objectContaining({ value: expect.stringContaining('private:') }));
    expect(report.steps[0].output).toBeUndefined();
    expect(report.steps[1].output).toContain('processed:private:');
    expect(JSON.stringify(report)).not.toContain('x'.repeat(100));
    expect(report.suppressedOutputBytes).toBeGreaterThan(1_900);
  });

  it('honors explicit expose=false for a leaf while preserving implicit leaf output', async () => {
    const hidden = await executor.execute({
      steps: [{ id: 'only', tool: 'source', expose: false }],
    }, { workspace: '/tmp', sessionId: 'session-1' });
    expect(hidden.steps[0].output).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain('private:');
    expect(hidden.suppressedOutputBytes).toBeGreaterThan(2_000);

    const implicit = await executor.execute({
      steps: [{ id: 'only', tool: 'source' }],
    }, { workspace: '/tmp', sessionId: 'session-1' });
    expect(implicit.steps[0].output).toContain('private:');
    expect(implicit.exposedOutputBytes).toBeLessThanOrEqual(1_024);
  });

  it('hides private failure content and strictly bounds every visible error', async () => {
    const bounded = new SafeWorkflowExecutor({
      skillRegistry: registry,
      skillExecutor: createSkillExecutor(logger),
      logger,
      allowlist: ['leaky_failure'],
      maxErrorBytes: 96,
    });
    const hidden = await bounded.execute({
      steps: [{ id: 'hidden', tool: 'leaky_failure', expose: false }],
    }, { workspace: '/tmp', sessionId: 'session-1' });
    const serialized = JSON.stringify(hidden);
    expect(serialized).not.toContain('private-output-must-not-leak');
    expect(serialized).not.toContain('private-error-must-not-leak');
    expect(hidden.steps[0].error).toContain('details hidden');
    expect(Buffer.byteLength(hidden.steps[0].error!)).toBeLessThanOrEqual(96);

    const exposed = await bounded.execute({
      steps: [{ id: 'visible', tool: 'leaky_failure', expose: true }],
    }, { workspace: '/tmp', sessionId: 'session-1' });
    expect(Buffer.byteLength(exposed.steps[0].error!)).toBeLessThanOrEqual(96);
    expect(exposed.steps[0].error).toContain('[workflow error truncated]');

    let validationError: Error | undefined;
    try {
      await bounded.execute({
        steps: [{ id: 'invalid', tool: `unknown-${'x'.repeat(10_000)}` }],
      }, { workspace: '/tmp', sessionId: 'session-1' });
    } catch (error) {
      validationError = error as Error;
    }
    expect(validationError).toBeDefined();
    expect(Buffer.byteLength(validationError!.message)).toBeLessThanOrEqual(96);
    expect(validationError!.message).toContain('[workflow error truncated]');
  });

  it('rejects a non-allowlisted tool before executing any step', async () => {
    await expect(executor.execute({
      steps: [{ id: 'shell', tool: 'bash', args: { command: 'rm -rf /' } }],
    }, { workspace: '/tmp', sessionId: 'session-1' })).rejects.toThrow('not allowed');
  });

  it('rechecks the active session policy instead of trusting the workflow allowlist', async () => {
    const policyExecutor = new SafeWorkflowExecutor({
      skillRegistry: registry,
      skillExecutor: createSkillExecutor(logger),
      logger,
      allowlist: ['source'],
      isToolAllowed: async () => false,
    });
    await expect(policyExecutor.execute({
      steps: [{ id: 'read', tool: 'source' }],
    }, { workspace: '/tmp', sessionId: 'restricted-session' }))
      .rejects.toThrow(/active session policy/);
  });

  it('rechecks policy immediately before dispatch and fails closed on a changed decision', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'must not execute' });
    registry.registerSkill(defineSkill('policy_target', 'policy recheck target')
      .onNativeExecute(handler)
      .build().skill);
    const policy = vi.fn()
      .mockResolvedValueOnce(true) // Preflight validation.
      .mockResolvedValueOnce(false); // Immediate dispatch recheck.
    const policyExecutor = new SafeWorkflowExecutor({
      skillRegistry: registry,
      skillExecutor: createSkillExecutor(logger),
      logger,
      allowlist: ['policy_target'],
      isToolAllowed: policy,
    });

    const report = await policyExecutor.execute({
      steps: [{ id: 'guarded', tool: 'policy_target' }],
    }, { workspace: '/tmp', sessionId: 'restricted-session' });
    expect(policy).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(report).toMatchObject({ success: false, executedSteps: 1 });
    expect(report.steps[0].error).toContain('denied by the active session policy at dispatch');
  });

  it('sends every resolved workflow step through the shared outcome authorization hook', async () => {
    const authorizeStep = vi.fn().mockResolvedValue(true);
    const brainExecutor = new SafeWorkflowExecutor({
      skillRegistry: registry,
      skillExecutor: createSkillExecutor(logger),
      logger,
      allowlist: ['source', 'transform'],
      authorizeStep,
    });

    const report = await brainExecutor.execute({
      steps: [
        { id: 'first', tool: 'source', expose: false },
        { id: 'second', tool: 'transform', dependsOn: ['first'], args: { value: '{{first.output}}' } },
      ],
    }, {
      workspace: '/tmp',
      sessionId: 'session-1',
      userId: 'user-1',
      userMessage: 'Run both steps',
    });

    expect(report.success).toBe(true);
    expect(authorizeStep).toHaveBeenCalledTimes(2);
    expect(authorizeStep.mock.calls[1][0]).toMatchObject({
      type: 'tool_use',
      name: 'transform',
      input: { value: expect.stringContaining('private:') },
    });
    expect(authorizeStep.mock.calls[1][2]).toMatchObject({
      sessionId: 'session-1',
      userMessage: 'Run both steps',
    });
  });

  it('rejects cycles and implicit output references before execution', async () => {
    await expect(executor.execute({
      steps: [
        { id: 'one', tool: 'source', dependsOn: ['two'] },
        { id: 'two', tool: 'transform', dependsOn: ['one'] },
      ],
    }, { workspace: '/tmp', sessionId: 'session-1' })).rejects.toThrow('cycle');

    await expect(executor.execute({
      steps: [
        { id: 'one', tool: 'source' },
        { id: 'two', tool: 'transform', args: { value: '{{one.output}}' } },
      ],
    }, { workspace: '/tmp', sessionId: 'session-1' })).rejects.toThrow('must depend');
  });

  it('stops downstream work on failure and returns an auditable skipped step', async () => {
    const report = await executor.execute({
      steps: [
        { id: 'bad', tool: 'failure' },
        { id: 'later', tool: 'transform', dependsOn: ['bad'], args: { value: 'unused' } },
      ],
    }, { workspace: '/tmp', sessionId: 'session-1' });

    expect(report.success).toBe(false);
    expect(report.executedSteps).toBe(1);
    expect(report.failedSteps).toBe(2);
    expect(report.steps[1]).toMatchObject({ skipped: true, success: false });
    expect(downstream).not.toHaveBeenCalled();
  });
});
