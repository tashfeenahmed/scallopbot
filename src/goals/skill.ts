import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import type { SubAgentExecutor } from '../subagent/executor.js';
import type { Router } from '../routing/router.js';
import type { GoalAcceptanceCriterion, GoalBudget, GoalContract, GoalJudge } from './types.js';
import type { GoalService } from './goal-service.js';

type VerifiedGoalAction = 'run' | 'park' | 'resume' | 'verify' | 'status';

function parseCriteria(raw: unknown): GoalAcceptanceCriterion[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error('acceptance_criteria must be a JSON array');
  return parsed as GoalAcceptanceCriterion[];
}

function createRouterJudge(router?: Pick<Router, 'executeWithFallback'>): GoalJudge | undefined {
  if (!router) return undefined;
  return async ({ goal, output, deterministicResults }) => {
    const response = await router.executeWithFallback({
      system: [
        'You are an independent, strict completion judge for an autonomous agent goal.',
        'Approve only if the supplied result contains concrete evidence that the goal and all constraints are truly satisfied.',
        'Do not trust claims such as "done", self-authored evidence markers, plans, or intentions as proof.',
        'If evidence is missing, ambiguous, unsafe, or unverifiable, reject.',
        'Return strict JSON only: {"passed":true|false,"reason":"short explanation"}.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: JSON.stringify({
          goal: goal.content,
          constraints: goal.metadata.contract?.constraints ?? [],
          deterministicResults,
          workerOutput: output.slice(0, 12_000),
        }),
      }],
      maxTokens: 300,
      temperature: 0,
      purpose: 'goal_judge',
      traceSessionId: `goal:${goal.id}`,
    }, 'capable');
    const text = response.response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('unparseable judge response');
    const parsed = JSON.parse(json) as { passed?: unknown; reason?: unknown };
    return {
      passed: parsed.passed === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'Judge provided no reason',
    };
  };
}

/**
 * Build the runtime-facing verified-goal tool. It delegates each bounded turn
 * to an isolated subagent, while GoalService owns persistence and verification.
 */
export function createVerifiedGoalSkill(
  goalService: GoalService,
  subAgentExecutor: SubAgentExecutor,
  router?: Pick<Router, 'executeWithFallback'>,
): Skill {
  const judge = createRouterJudge(router);
  return defineSkill(
    'execute_goal',
    'Run, park, resume, inspect, or independently verify a persistent goal completion contract.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        action: { type: 'string', description: 'run, park, resume, verify, or status' },
        goal_id: { type: 'string', description: 'Top-level goal ID' },
        acceptance_criteria: { type: 'string', description: 'Optional JSON array of acceptance criteria for configuration' },
        constraints: { type: 'array', description: 'Optional constraints when configuring a contract' },
        max_turns: { type: 'number', description: 'Hard total turn budget when configuring' },
        max_cost_usd: { type: 'number', description: 'Optional hard cost budget when configuring' },
        turn_slice: { type: 'number', description: 'Optional maximum worker turns this invocation; omitted runs until verified or budget exhausted' },
        reason: { type: 'string', description: 'Reason when parking' },
        resume_at: { type: 'number', description: 'Optional epoch-ms automatic resume time' },
        output: { type: 'string', description: 'Observed output to verify without running another worker' },
      },
      required: ['action', 'goal_id'],
    })
    .onNativeExecute(async (context) => {
      try {
        const action = context.args.action as VerifiedGoalAction;
        const goalId = String(context.args.goal_id ?? '').trim();
        if (!goalId) throw new Error('goal_id is required');

        if (action === 'status') {
          const goal = await goalService.getGoal(goalId);
          if (!goal) throw new Error(`Goal ${goalId} not found`);
          return {
            success: true,
            output: JSON.stringify({
              id: goal.id,
              title: goal.content,
              status: goal.metadata.status,
              contract: goal.metadata.contract,
              budget: goal.metadata.budget,
              execution: goal.metadata.execution,
            }),
          };
        }

        if (action === 'park') {
          const goal = await goalService.parkExecution(
            goalId,
            String(context.args.reason ?? 'Waiting for an external condition'),
            context.args.resume_at === undefined ? undefined : Number(context.args.resume_at),
          );
          return { success: true, output: `Goal parked: ${goal.metadata.execution?.parkReason}` };
        }

        if (action === 'resume') {
          const goal = await goalService.resumeExecution(goalId);
          return { success: true, output: `Goal resumed with ${goal.metadata.execution?.turnsUsed ?? 0} turns already used.` };
        }

        if (action === 'verify') {
          const output = String(context.args.output ?? '');
          const verification = await goalService.verifyExecution(
            goalId,
            output,
            // A model tool call is not an independent evidence source. Trusted
            // host integrations can supply manual evidence through GoalService.
            {},
            judge,
          );
          return { success: verification.passed, output: JSON.stringify(verification) };
        }

        if (action !== 'run') throw new Error(`Unknown execute_goal action: ${String(action)}`);

        const criteria = parseCriteria(context.args.acceptance_criteria);
        if (criteria) {
          const contract: GoalContract = {
            acceptanceCriteria: criteria,
            constraints: Array.isArray(context.args.constraints)
              ? context.args.constraints.map(String)
              : undefined,
          };
          const budget: GoalBudget = {
            maxTurns: Math.max(1, Math.floor(Number(context.args.max_turns ?? 10))),
            maxCostUsd: context.args.max_cost_usd === undefined
              ? undefined
              : Number(context.args.max_cost_usd),
          };
          await goalService.configureExecution(goalId, contract, budget);
        }

        const turnSlice = context.args.turn_slice === undefined
          ? undefined
          : Math.max(1, Math.min(10, Math.floor(Number(context.args.turn_slice))));
        const result = await goalService.runUntilVerified(
          goalId,
          async ({ goal, contract, turnNumber, previousOutput }) => {
            const criteriaText = contract.acceptanceCriteria
              .map((criterion) => `- ${criterion.id}: ${criterion.description} (${criterion.kind}${criterion.expected ? `: ${criterion.expected}` : ''})`)
              .join('\n');
            const task = [
              `Work on this persistent goal: ${goal.content}`,
              `This is attempt ${turnNumber}.`,
              '',
              'Acceptance criteria:',
              criteriaText,
              ...(contract.constraints?.length ? ['', 'Constraints:', ...contract.constraints.map((item) => `- ${item}`)] : []),
              ...(previousOutput ? ['', 'Previous attempt output:', previousOutput] : []),
              '',
              'Do the work and report concrete, independently checkable evidence. Manual criteria cannot be satisfied by claims in your own response; they require a separate external verification action.',
            ].join('\n');
            const worker = await subAgentExecutor.spawnAndWait(context.sessionId, {
              task,
              label: `goal:${goal.id.slice(0, 8)}:${turnNumber}`,
              modelTier: 'capable',
              waitForResult: true,
            });
            return {
              output: worker.response,
              costUsd: worker.costUsd,
              taskComplete: worker.taskComplete,
              failureReason: worker.taskComplete
                ? undefined
                : 'Goal sub-agent stopped before completing its assigned turn',
            };
          },
          { maxTurnsThisRun: turnSlice, judge },
        );
        return {
          success: result.state !== 'blocked' && result.state !== 'budget_exhausted',
          output: JSON.stringify({
            state: result.state,
            turnsThisRun: result.turnsThisRun,
            totalTurns: result.goal.metadata.execution?.turnsUsed,
            costUsedUsd: result.goal.metadata.execution?.costUsedUsd,
            reason: result.reason,
            verification: result.verification,
          }),
        };
      } catch (error) {
        return { success: false, output: '', error: (error as Error).message };
      }
    })
    .build().skill;
}
