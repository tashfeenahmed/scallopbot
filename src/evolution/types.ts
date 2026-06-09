/**
 * Core types for the self-evolution engine.
 *
 * Storage-agnostic — persistence lives in ScallopDatabase (evolution_* tables).
 */

/** What kind of improvement opportunity an online signal represents. */
export type EvolutionSignalType =
  /** A successful multi-step turn that could be distilled into a reusable skill. */
  | 'reusable_task'
  /** A skill that errored or got stuck — candidate for patching. */
  | 'skill_failure'
  /** A capable-tier turn whose answer scored low — prompt/tool-description candidate. */
  | 'low_quality'
  /** User affect swung negative right after a response. */
  | 'negative_affect';

/** One captured improvement opportunity (Layer 1, zero-LLM-cost). */
export interface EvolutionSignal {
  id?: number;
  userId: string;
  /** Epoch ms when captured. */
  at: number;
  type: EvolutionSignalType;
  /** For skill_failure: the skill that underperformed. */
  targetSkill?: string | null;
  /** Heuristic critic score of the turn's final answer, [0,1]. */
  criticScore?: number | null;
  /** Tool calls used in the turn. */
  toolCallCount?: number | null;
  /** Session the turn belongs to (lets the optimizer hydrate the trajectory). */
  sessionId?: string | null;
  /** Free-form context (user message preview, failing tool count, etc.). */
  detail?: Record<string, unknown> | null;
}

/** A signal as read back from the DB (type widened to string, id present). */
export interface StoredEvolutionSignal {
  id: number;
  userId: string;
  at: number;
  type: string;
  targetSkill?: string | null;
  criticScore?: number | null;
  toolCallCount?: number | null;
  sessionId?: string | null;
  detail?: Record<string, unknown> | null;
}

/** A flat map of relative path -> file content for a skill (e.g. 'SKILL.md', 'scripts/run.ts'). */
export type SkillFiles = Record<string, string>;

/** Kinds of mutation the optimizer can propose. P2 implements the skill kinds. */
export type MutationKind = 'create_skill' | 'patch_skill' | 'patch_prompt' | 'patch_tool_desc';

/** A reflective-mutation proposal produced from clustered signals. */
export interface SkillMutation {
  kind: 'create_skill' | 'patch_skill';
  /** The skill name being created or patched. */
  target: string;
  /** Why the optimizer proposed this (for the decision log). */
  rationale: string;
  /** The complete skill files to write (SKILL.md + any scripts/). */
  files: SkillFiles;
}

/** A prompt-fragment mutation: learned guidance appended to the system prompt. */
export interface PromptMutation {
  kind: 'patch_prompt';
  /** The prompt fragment id (e.g. 'learned_guidance'). */
  fragmentId: string;
  /** The new guidance content. */
  content: string;
  rationale: string;
}

/** Where in the evolution pipeline a decision was made (observability). */
export type EvolutionStage = 'capture' | 'harvest' | 'reflect' | 'verify' | 'promote' | 'rollback';

/** A structured decision record powering the `why-evolution` diagnostic. */
export interface EvolutionDecision {
  id?: number;
  at: number;
  stage: EvolutionStage;
  /** What happened: captured | proposed | verified | promoted | rejected | rolled_back | skipped | failed. */
  outcome: string;
  /** Machine reason code. */
  reason?: string | null;
  /** What the decision was about (skill name, prompt fragment id, …). */
  target?: string | null;
  detail?: Record<string, unknown> | null;
}
