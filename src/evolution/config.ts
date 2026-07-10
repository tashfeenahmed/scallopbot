/**
 * Self-evolution engine configuration.
 *
 * Dependency-free (types + defaults only) so the central config in
 * src/config/config.ts can import it without a cycle. The model the engine's
 * reflective optimizer runs on is NOT here — it lives in config.models.evolution
 * (see src/config/model-routing.ts), so model choice stays in the one place.
 */

export interface EvolutionConfig {
  /** Master switch. When false, no signals are captured and no optimizer runs. */
  enabled: boolean;
  // ---- Online signal-capture thresholds (Layer 1) ----
  /** Tool calls in a turn at/above which a successful turn becomes a "reusable task" candidate. */
  minToolCalls: number;
  /** Critic score a multi-step turn must reach to count as a clean reusable pattern. */
  reusableScoreBar: number;
  /** Critic score below which a capable-tier turn is flagged low-quality (prompt/desc candidate). */
  lowQualityThreshold: number;
  // ---- Offline optimizer knobs (Layer 2 — consumed in later phases) ----
  /** Max mutation proposals materialized per nightly run. */
  maxProposals: number;
  /** Minimum fitness delta a mutation must show to be promoted (non-regression margin). */
  fitnessEpsilon: number;
  /** Required invariant: autonomous promotion always needs before/after holdout evaluation. */
  requireFitnessGate: boolean;
  /** Explicit consent to include redacted conversation excerpts in reflection. */
  includeSessionContent: boolean;
  /** Permit holdout evidence to be sent to a provider distinct from evolution. */
  allowSeparateEvalProvider: boolean;
  /** Post-promotion observations watched before a regressing mutation auto-rolls-back. */
  rollbackWindow: number;
  /** Run a fail-closed adversarial LLM safety review before promotion. */
  useLlmJudge: boolean;
  /** Maintain usage/provenance and archive unused agent-created skills. */
  curatorEnabled: boolean;
  /** Days without use before an agent-created skill is marked stale. */
  curatorStaleDays: number;
  /** Days without use before an agent-created skill is recoverably archived. */
  curatorArchiveDays: number;
  /** Number of pre-curation backups to retain. */
  curatorBackupKeep: number;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: false,
  minToolCalls: 5,
  reusableScoreBar: 0.8,
  lowQualityThreshold: 0.5,
  maxProposals: 5,
  fitnessEpsilon: 0.05,
  requireFitnessGate: true,
  includeSessionContent: false,
  allowSeparateEvalProvider: false,
  rollbackWindow: 5,
  useLlmJudge: true,
  curatorEnabled: true,
  curatorStaleDays: 30,
  curatorArchiveDays: 90,
  curatorBackupKeep: 5,
};
