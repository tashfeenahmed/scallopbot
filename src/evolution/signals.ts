/**
 * Layer 1 — online evolution signal capture.
 *
 * Called once at the end of every agent turn. Pure book-keeping: it applies
 * cheap thresholds and appends rows to evolution_signals. No LLM calls, no
 * blocking — the heavy reflection happens later in the nightly optimizer
 * (Layer 2). Best-effort: any failure is swallowed so it can never break a turn.
 */

import type { Logger } from 'pino';
import { scoreResponseHeuristic } from '../agent/critic.js';
import type { EvolutionConfig } from './config.js';
import type { EvolutionSignal, EvolutionSignalType } from './types.js';
import { sanitizeEvolutionEvidence } from './privacy.js';

/** Narrow persistence surface — keeps the recorder testable without the full DB. */
export interface EvolutionSignalSink {
  recordEvolutionSignal(signal: Omit<EvolutionSignal, 'id'>): void;
}

/** The per-turn facts the recorder needs to decide what (if anything) to capture. */
export interface TurnOutcome {
  userId: string;
  sessionId: string;
  userMessage: string;
  finalResponse: string;
  /** Total tool calls executed across the turn. */
  toolCallCount: number;
  /** Distinct skills that returned an error this turn. */
  failedSkills: string[];
  /** Complexity tier the turn was routed at. */
  complexityTier: 'fast' | 'standard' | 'capable';
  /** Optional precomputed critic score (reused from best-of-N); else computed here. */
  criticScore?: number;
  at?: number;
}

export class EvolutionRecorder {
  constructor(
    private readonly sink: EvolutionSignalSink,
    private readonly config: EvolutionConfig,
    private readonly logger?: Logger,
  ) {}

  /** Derive and persist evolution signals for a completed turn. Never throws. */
  recordTurn(turn: TurnOutcome): void {
    if (!this.config.enabled) return;
    try {
      const at = turn.at ?? Date.now();
      const score =
        turn.criticScore ?? scoreResponseHeuristic(turn.finalResponse, turn.userMessage).score;
      const preview = this.config.includeSessionContent
        ? sanitizeEvolutionEvidence(turn.userMessage).slice(0, 200)
        : undefined;

      const emit = (
        type: EvolutionSignalType,
        fields: { targetSkill?: string; detail?: Record<string, unknown> } = {},
      ): void => {
        this.sink.recordEvolutionSignal({
          userId: turn.userId,
          at,
          type,
          targetSkill: fields.targetSkill ?? null,
          criticScore: score,
          toolCallCount: turn.toolCallCount,
          sessionId: turn.sessionId,
          detail: { ...(preview ? { preview } : {}), ...(fields.detail ?? {}) },
        });
      };

      // 1) Reusable multi-step task — a clean, tool-heavy success worth distilling.
      if (turn.toolCallCount >= this.config.minToolCalls && score >= this.config.reusableScoreBar) {
        emit('reusable_task', { detail: { toolCallCount: turn.toolCallCount } });
      }

      // 2) Skill failures — one candidate per distinct failing skill.
      for (const skill of new Set(turn.failedSkills)) {
        emit('skill_failure', { targetSkill: skill, detail: { skill } });
      }

      // 3) Low-quality capable-tier answer — prompt / tool-description candidate.
      if (turn.complexityTier === 'capable' && score < this.config.lowQualityThreshold) {
        emit('low_quality', { detail: { tier: turn.complexityTier } });
      }
    } catch (err) {
      this.logger?.debug?.(
        { error: (err as Error).message },
        'Evolution signal capture failed (non-fatal)',
      );
    }
  }
}
