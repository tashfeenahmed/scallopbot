/**
 * Delegation tools: spawn_agent, check_agents, progress_note.
 *
 * spawn_agent is async: it returns a handle at once and tells the parent to
 * end its turn. Results arrive later as [agent-result: name] /
 * [agent-exited: no-reply name] messages — mid-turn via the announce queue,
 * or by waking the idle parent (gateway/wake.ts).
 */

import type { Logger } from 'pino';
import { defineSkill } from '../skills/sdk.js';
import type { Skill } from '../skills/types.js';
import type { SessionManager } from '../agent/session.js';
import type { SubAgentExecutor, SubAgentStatusLine } from './executor.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnAgentInput, SubAgentRun } from './types.js';
import { SPAWN_ACK_INSTRUCTION } from './messages.js';

export const CHECK_AGENTS_MAX_WAIT_SECONDS = 300;

type Tier = 'fast' | 'standard' | 'capable';

export interface SubAgentToolDeps {
  registry: SubAgentRegistry;
  executor: SubAgentExecutor;
  sessionManager: SessionManager;
  logger: Logger;
}

function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(s => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function tier(value: unknown): Tier | undefined {
  return value === 'fast' || value === 'standard' || value === 'capable' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function formatStatusLines(lines: SubAgentStatusLine[]): string {
  if (lines.length === 0) return 'No sub-agents for this session.';
  return lines.map(line => {
    const parts = [
      `id=${line.id}`,
      `name=${line.name}`,
      `status=${line.status}`,
      `elapsed=${line.elapsedSeconds}s`,
      `iterations=${line.iterations}`,
    ];
    if (line.lastProgressNote) parts.push(`note=${JSON.stringify(line.lastProgressNote)}`);
    if (line.reportPath && line.status !== 'running' && line.status !== 'pending') parts.push(`report=${line.reportPath}`);
    return `- ${parts.join(' ')}`;
  }).join('\n');
}

export function createSubAgentSkills(deps: SubAgentToolDeps): Skill[] {
  const { registry, executor, sessionManager, logger } = deps;

  const findRun = (parentSessionId: string, ref: string): SubAgentRun | undefined => {
    const runs = registry.getRunsForParent(parentSessionId);
    return runs.find(run => run.id === ref) ?? [...runs].reverse().find(run => run.label === ref);
  };

  const spawnAgent = defineSkill(
    'spawn_agent',
    'Start a sub-agent on a task in the background (returns at once). It has real tools (read/search/edit/bash/web). '
    + 'Its result arrives later as an [agent-result: name] message — end your turn after spawning, never poll.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the sub-agent should do, with every detail it needs (it does not see this conversation).' },
        name: { type: 'string', description: 'Short unique name, e.g. "fix-tests". Used in [agent-result: name] and the report file name.' },
        model_tier: { type: 'string', enum: ['fast', 'standard', 'capable'], description: 'fast = cheapest, standard (default), capable = hardest tasks.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool allowlist. Default: read_file, grep, glob, ls, patch/edit_file, write_file, bash, process, webfetch, web_search, memory_search, todo (those that exist and your policy allows).' },
        worktree: { type: 'boolean', description: 'Run in an isolated git worktree; changes come back as a conflict-checked .patch.' },
        tasks: {
          type: 'array',
          description: 'Optional atomic fan-out: several {task, name, tools?} started together (all-or-nothing capacity check).',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string' },
              name: { type: 'string' },
              tools: { type: 'array', items: { type: 'string' } },
            },
            required: ['task'],
          },
        },
        context: { type: 'string', description: 'Optional facts the task depends on, kept separate from the instruction.' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Optional testable conditions the sub-agent must report on.' },
      },
      required: [],
    })
    .onNativeExecute(async (ctx) => {
      const args = ctx.args;
      const task = str(args.task);
      const batch = Array.isArray(args.tasks) ? args.tasks as Array<Record<string, unknown>> : [];
      if ((!task || task.length < 5) && batch.length === 0) {
        return { success: false, output: '', error: 'Provide task (or a non-empty tasks batch).' };
      }

      const session = await sessionManager.getSession(ctx.sessionId);
      const canSpawn = registry.canSpawn(ctx.sessionId, session?.metadata as Record<string, unknown> | undefined, batch.length || 1);
      if (!canSpawn.allowed) {
        return { success: false, output: '', error: canSpawn.reason || 'Cannot spawn sub-agent' };
      }

      const worktree = args.worktree === true || args.workspace_mode === 'worktree';
      const common: Omit<SpawnAgentInput, 'task'> = {
        skills: toolList(args.tools ?? args.skills),
        modelTier: tier(args.model_tier),
        context: str(args.context),
        acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? toolList(args.acceptance_criteria) : undefined,
        contextMode: args.context_mode as SpawnAgentInput['contextMode'],
        workspaceMode: worktree ? 'worktree' : 'shared',
        timeoutSeconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : undefined,
        idleTimeoutSeconds: typeof args.idle_timeout_seconds === 'number' ? args.idle_timeout_seconds : undefined,
      };

      try {
        // Legacy, synchronous: isolated implement -> independent review -> patch.
        if (args.workflow === 'coding' && task) {
          const result = await executor.runCodingWorkflow(ctx.sessionId, { ...common, task, label: str(args.name) ?? str(args.label), workspaceMode: 'worktree' });
          return {
            success: result.status === 'succeeded',
            output: JSON.stringify(result),
            ...(result.status === 'succeeded' ? {} : { error: result.blockers.join('; ') || 'Coding workflow blocked' }),
          };
        }
        if (batch.length > 0) {
          const inputs: SpawnAgentInput[] = batch.map(item => ({
            ...common,
            task: String(item.task ?? '').trim(),
            label: str(item.name) ?? str(item.label),
            skills: item.tools !== undefined || item.skills !== undefined ? toolList(item.tools ?? item.skills) : common.skills,
          }));
          if (inputs.some(item => item.task.length < 5)) throw new Error('Every batch task must be at least 5 characters');
          const runs = await executor.spawnBatch(ctx.sessionId, inputs);
          const handles = runs.map(run => ({ id: run.runId, name: run.name, status: 'running' }));
          return { success: true, output: `${JSON.stringify(handles)}\n${SPAWN_ACK_INSTRUCTION}` };
        }
        const { runId, name } = await executor.spawn(ctx.sessionId, {
          ...common,
          task: task!,
          label: str(args.name) ?? str(args.label),
        });
        return {
          success: true,
          output: `${JSON.stringify({ id: runId, name, status: 'running' })}\n${SPAWN_ACK_INSTRUCTION}`,
        };
      } catch (error) {
        logger.error({ error: (error as Error).message }, 'spawn_agent failed');
        return { success: false, output: '', error: `Failed to spawn sub-agent: ${(error as Error).message}` };
      }
    })
    .build();

  const checkAgents = defineSkill(
    'check_agents',
    'Status of your sub-agents (non-blocking by default): id, name, status, elapsed, iterations, last progress note. '
    + 'Also: log, cancel, steer a running one, or follow up. Do not use it to poll — you are woken when they finish.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        timeout: { type: 'number', description: `Seconds to wait for all running sub-agents to finish (0 = return now, default; max ${CHECK_AGENTS_MAX_WAIT_SECONDS}).` },
        action: { type: 'string', enum: ['status', 'log', 'cancel', 'steer', 'followup'], description: 'status (default), log, cancel, steer, or followup' },
        id: { type: 'string', description: 'Sub-agent id or name (for log/cancel/steer/followup)' },
        message: { type: 'string', description: 'Steering or follow-up instruction' },
      },
      required: [],
    })
    .onNativeExecute(async (ctx) => {
      const action = String(ctx.args.action || 'status');
      if (action !== 'status' && action !== 'list') {
        const ref = String(ctx.args.id ?? ctx.args.run_id ?? '');
        const run = findRun(ctx.sessionId, ref);
        if (!run) return { success: false, output: '', error: 'Unknown sub-agent for this session' };
        if (action === 'info') return { success: true, output: JSON.stringify(run.result ?? run, null, 2) };
        if (action === 'log') {
          const log = await executor.getRunLog(run.id);
          return { success: true, output: log.map(entry => `${entry.role}: ${entry.content}`).join('\n\n') || 'No retained log.' };
        }
        if (action === 'cancel') {
          return executor.cancel(run.id)
            ? { success: true, output: `Cancelled ${run.label}.` }
            : { success: false, output: '', error: 'Sub-agent is not active' };
        }
        if (action === 'steer') {
          return executor.steer(run.id, String(ctx.args.message || ''))
            ? { success: true, output: `Steering update queued for ${run.label}.` }
            : { success: false, output: '', error: 'Sub-agent is not active or message is empty' };
        }
        if (action === 'followup' && String(ctx.args.message || '').trim()) {
          const followUp = await executor.followUp(ctx.sessionId, run.id, String(ctx.args.message), false);
          const handle = 'runId' in followUp ? followUp : undefined;
          return {
            success: true,
            output: handle
              ? `${JSON.stringify({ id: handle.runId, name: handle.name, status: 'running' })}\n${SPAWN_ACK_INSTRUCTION}`
              : 'Follow-up finished.',
          };
        }
        return { success: false, output: '', error: 'Unknown action or missing message' };
      }

      const requested = Number(ctx.args.timeout ?? 0);
      const timeoutSeconds = Number.isFinite(requested) ? Math.max(0, Math.min(CHECK_AGENTS_MAX_WAIT_SECONDS, requested)) : 0;
      let waitNote = '';
      if (timeoutSeconds > 0) {
        const done = await executor.waitForChildren(ctx.sessionId, timeoutSeconds * 1000, ctx.signal);
        waitNote = done ? 'All sub-agents have finished.\n' : `Still running after ${timeoutSeconds}s.\n`;
      }
      return { success: true, output: `${waitNote}${formatStatusLines(executor.statusFor(ctx.sessionId))}` };
    })
    .build();

  const progressNote = defineSkill(
    'progress_note',
    'Sub-agents only: post one short line about where you are (at most every 30s). Shown to the parent; does not interrupt it.',
  )
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One short line, e.g. "tests pass, now updating docs"' },
      },
      required: ['text'],
    })
    .onNativeExecute(async (ctx) => {
      // A throttled note is not a failure the loop detector should count.
      const outcome = executor.recordProgressNote(ctx.sessionId, String(ctx.args.text ?? ''));
      return { success: true, output: outcome.message };
    })
    .build();

  return [spawnAgent.skill, checkAgents.skill, progressNote.skill];
}
