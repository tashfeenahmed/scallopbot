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
  /** Post-promotion observations watched before a regressing mutation auto-rolls-back. */
  rollbackWindow: number;
  /** Opt-in: run an adversarial LLM-judge safety review before promoting (costs one call). */
  useLlmJudge: boolean;
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  minToolCalls: 5,
  reusableScoreBar: 0.8,
  lowQualityThreshold: 0.5,
  maxProposals: 5,
  fitnessEpsilon: 0.0,
  rollbackWindow: 5,
  useLlmJudge: false,
};
