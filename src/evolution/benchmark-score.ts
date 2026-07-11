/** Deterministic score used by the isolated provider-backed evolution benchmark. */
export interface EvolutionTrialEvidence {
  correct: boolean;
  verifierCalls: number;
  successfulLoadBeforeCorrectVerification: boolean;
}

export interface EvolutionTrialScore {
  correctness: number;
  toolUse: number;
  total: number;
}

export function scoreEvolutionTrial(evidence: EvolutionTrialEvidence): EvolutionTrialScore {
  const correctness = evidence.correct ? 1 : 0;
  const toolUse =
    (evidence.successfulLoadBeforeCorrectVerification ? 0.5 : 0)
    + (evidence.correct ? 0.35 : 0)
    + (evidence.verifierCalls === 1 ? 0.15 : 0);
  return { correctness, toolUse, total: correctness + toolUse };
}

/** Fail closed unless correctness is proven and tool use measurably improves. */
export function hasMeasuredEvolutionImprovement(
  baseline: EvolutionTrialScore,
  candidate: EvolutionTrialScore,
  candidateCorrect: boolean,
  loadedPromotedProcedure: boolean,
  minimumDelta = 0.5,
): boolean {
  return candidateCorrect
    && loadedPromotedProcedure
    && candidate.toolUse > baseline.toolUse
    && candidate.total - baseline.total >= minimumDelta;
}
