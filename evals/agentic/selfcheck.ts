/**
 * Scorer self-check: run a task's reference solution straight through the
 * real bundled skills (no Agent, no model) and score it. A task whose scorer
 * rejects its own reference — or accepts the untouched workspace — is broken.
 */

import { rm } from 'node:fs/promises';
import pino from 'pino';
import { createBenchSkills, createSandbox } from './harness.js';
import type { BenchTask, ScoreResult, TaskTrace, ToolCallTrace, TurnTrace } from './types.js';

function emptyTurn(turn: number, userMessage: string, response: string): TurnTrace {
  return {
    turn, userMessage, response, completionReason: 'reference', iterationsUsed: 0, totalMs: 0,
    timeToFirstReplyMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    toolCalls: 0, toolErrors: 0, blockedCalls: 0, progressToolStarts: 0, progressToolErrors: 0,
    systemNudges: 0, cannedRefusal: false,
  };
}

export async function scoreReference(task: BenchTask, options: { applySteps?: boolean } = {}): Promise<ScoreResult> {
  delete process.env.AGENT_WORKSPACE;
  const logger = pino({ level: 'silent' });
  const sandbox = await createSandbox(`${task.id}-ref`);
  try {
    await task.setup(sandbox.workspace);
    const { registry, executor } = await createBenchSkills(sandbox, logger);
    const trace: TaskTrace = { turns: [], llmCalls: [], toolCalls: [], sentMessages: [], finalResponse: '', allResponses: '' };
    const applySteps = options.applySteps ?? true;

    for (let turn = 0; turn < task.prompt.length; turn++) {
      const reference = task.reference[turn];
      const reply = applySteps ? (reference?.reply ?? '') : '';
      for (const batch of applySteps ? reference?.steps ?? [] : []) {
        for (const [index, call] of batch.entries()) {
          const skill = registry.getSkill(call.name);
          if (!skill) throw new Error(`reference uses unknown skill ${call.name}`);
          const result = skill.handler
            ? await skill.handler({ args: call.input, workspace: sandbox.workspace, sessionId: 'reference' })
            : await executor.execute(skill, { skillName: call.name, args: call.input, cwd: sandbox.workspace });
          const record: ToolCallTrace = {
            turn,
            id: `ref-${turn}-${trace.toolCalls.length}-${index}`,
            name: call.name,
            input: call.input,
            isError: !result.success,
            result: (result.output || result.error || '').slice(0, 2000),
          };
          trace.toolCalls.push(record);
        }
      }
      trace.turns.push(emptyTurn(turn, task.prompt[turn]!, reply));
    }
    trace.finalResponse = trace.turns[trace.turns.length - 1]?.response ?? '';
    trace.allResponses = trace.turns.map(turn => turn.response).join('\n\n');
    return await task.score(sandbox.workspace, trace);
  } finally {
    await rm(sandbox.root, { recursive: true, force: true });
  }
}
