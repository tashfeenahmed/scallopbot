/**
 * The "always on" assistant: goal mode, agent-created heartbeats and the wake
 * runtime they share. The gateway calls `setupAlwaysOn()` once after the
 * Agent exists; it registers the `goal_complete` and `heartbeat` native tools
 * and installs the runtime behind `wakeSession()`.
 */

import type { Logger } from 'pino';
import type { Agent } from '../agent/agent.js';
import type { SessionManager } from '../agent/session.js';
import type { InterruptQueue } from '../agent/interrupt-queue.js';
import { laneIsActive } from '../agent/command-queue.js';
import type { ScallopDatabase } from '../memory/db.js';
import type { CostTracker } from '../routing/cost.js';
import type { BoardService } from '../board/board-service.js';
import type { SkillRegistry } from '../skills/registry.js';
import {
  GoalModeController,
  boardGoalLink,
  createGoalCompleteSkill,
  createSessionProgressProbe,
  DEFAULT_GOAL_MAX_TURNS,
} from '../goals/goal-mode.js';
import { HeartbeatService, createHeartbeatSkill } from '../proactive/heartbeats.js';
import { configureWake } from './wake.js';

export interface AlwaysOnDeps {
  agent: Pick<Agent, 'processMessage'>;
  sessionManager: Pick<SessionManager, 'getSession'>;
  db: Pick<ScallopDatabase, 'getSessionMessages' | 'findSessionByUserId'> & ConstructorParameters<typeof HeartbeatService>[0]['store'];
  interruptQueue?: Pick<InterruptQueue, 'enqueue'> | null;
  costTracker?: Pick<CostTracker, 'canMakeRequest'> | null;
  boardService?: Pick<BoardService, 'createItem' | 'markDone' | 'moveItem'> | null;
  /** Send text to a (channel-prefixed) user. */
  deliver: (userId: string, text: string) => Promise<boolean>;
  goalMaxTurns?: number;
  logger: Logger;
}

export interface AlwaysOn {
  goalMode: GoalModeController;
  heartbeats: HeartbeatService;
}

export function setupAlwaysOn(registry: Pick<SkillRegistry, 'registerSkill'>, deps: AlwaysOnDeps): AlwaysOn {
  const logger = deps.logger.child({ module: 'always-on' });
  const canSpend = deps.costTracker ? () => deps.costTracker!.canMakeRequest() : undefined;

  configureWake({
    async resolveSession(sessionId, userId) {
      const session = await deps.sessionManager.getSession(sessionId);
      if (session) {
        const owner = typeof session.metadata?.userId === 'string' ? session.metadata.userId : userId;
        return { sessionId, ...(owner ? { userId: owner } : {}) };
      }
      // The session was closed (/new): follow the owner to their current one.
      if (!userId) return null;
      const current = deps.db.findSessionByUserId(userId);
      return current ? { sessionId: current.id, userId } : null;
    },
    isBusy: (sessionId) => laneIsActive(`session:${sessionId}`),
    steer: (sessionId, text) => deps.interruptQueue?.enqueue({ sessionId, text, timestamp: Date.now() }),
    async runTurn(sessionId, message) {
      const result = await deps.agent.processMessage(sessionId, message);
      return { response: result.response };
    },
    deliver: deps.deliver,
  });

  const goalMode = new GoalModeController({
    runTurn: async (sessionId, message, shouldStop) => {
      const result = await deps.agent.processMessage(sessionId, message, undefined, undefined, shouldStop);
      return { response: result.response, completionReason: result.completionReason };
    },
    probe: createSessionProgressProbe(deps.db),
    canSpend,
    board: deps.boardService ? boardGoalLink(deps.boardService) : undefined,
    maxTurns: deps.goalMaxTurns ?? DEFAULT_GOAL_MAX_TURNS,
    logger,
  });

  const heartbeats = new HeartbeatService({ store: deps.db, canSpend, logger });

  registry.registerSkill(createGoalCompleteSkill(goalMode));
  registry.registerSkill(createHeartbeatSkill(heartbeats));

  return { goalMode, heartbeats };
}

/** Gateway shutdown: wakes after this report `unavailable`. */
export function shutdownAlwaysOn(): void {
  configureWake(null);
}
