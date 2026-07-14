import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import type { SafeWorkflowExecutor } from './executor.js';
import type { WorkflowRequest } from './types.js';

/** Build the native tool; the gateway only needs to register the returned skill. */
export function createExecuteWorkflowSkill(executor: SafeWorkflowExecutor): Skill {
  return defineSkill(
    'execute_workflow',
    'Run a bounded DAG of allowlisted tools while keeping unselected intermediate outputs out of model context.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        steps: { type: 'array', description: 'Workflow steps with id, tool, args, dependsOn, and expose fields' },
        stopOnError: { type: 'boolean', description: 'Stop after the first failure (default true)' },
        maxConcurrency: { type: 'number', description: 'Parallelism for independent steps (bounded by server policy)' },
      },
      required: ['steps'],
    })
    .onNativeExecute(async (context) => {
      try {
        const report = await executor.execute(context.args as unknown as WorkflowRequest, {
          workspace: context.workspace,
          sessionId: context.sessionId,
          userId: context.userId,
          userMessage: context.userMessage,
          previousAssistantMessage: context.previousAssistantMessage,
          turnStartedAt: context.turnStartedAt,
        });
        return { success: report.success, output: JSON.stringify(report) };
      } catch (error) {
        return { success: false, output: '', error: (error as Error).message };
      }
    })
    .build().skill;
}
