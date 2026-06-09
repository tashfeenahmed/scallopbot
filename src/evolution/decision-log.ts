/**
 * Evolution Decision Log — observability for "what is the engine learning?"
 *
 * Mirrors src/proactive/decision-log.ts. The optimizer appends an EvolutionDecision
 * at each pipeline step (harvest/reflect/verify/promote/rollback); this module turns
 * the recent records — plus the current signal corpus — into a plain-English report
 * for the `why-evolution` CLI command. Pure: takes the data and a clock.
 */

import type { EvolutionDecision, EvolutionSignal, EvolutionSignalType } from './types.js';

/** Plain-English explanation for each known reason code. */
export const EVOLUTION_REASONS: Record<string, string> = {
  disabled: 'The self-evolution engine is turned off (config.evolution.enabled = false).',
  no_signals: 'No improvement signals have been captured yet — nothing to learn from.',
  no_free_provider: 'No provider is available for the reflection step.',
  below_threshold: 'A proposed mutation did not beat the current version by the required margin, so it was rejected.',
  parse_failed: 'A proposed skill failed to parse/validate and was discarded.',
  smoke_failed: 'A proposed skill failed its sandboxed smoke test and was discarded.',
  judge_rejected: 'A mutation passed automated checks but the adversarial safety judge rejected it (possibly unsafe or net-negative).',
  regressed: 'A promoted mutation regressed in use and was automatically rolled back.',
  promoted: 'A mutation passed all gates and was promoted live.',
  proposed: 'A candidate mutation was generated and staged for verification.',
};

const SIGNAL_LABELS: Record<EvolutionSignalType, string> = {
  reusable_task: 'reusable multi-step tasks (new-skill candidates)',
  skill_failure: 'skill failures (patch candidates)',
  low_quality: 'low-quality answers (prompt/desc candidates)',
  negative_affect: 'negative-affect turns',
};

function formatAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Diagnose the state of the self-evolution engine from its signal corpus and
 * recent decision records.
 */
export function explainEvolution(
  signals: EvolutionSignal[],
  decisions: EvolutionDecision[],
  now: number = Date.now(),
): string {
  const lines: string[] = ['Self-evolution diagnosis', '========================'];

  // --- Corpus summary ---
  lines.push('');
  if (signals.length === 0) {
    lines.push('Signal corpus: empty — no improvement opportunities captured yet.');
    lines.push('  Meaning: turns have not yet triggered any capture rule (≥minToolCalls success,');
    lines.push('  skill failure, or low-quality capable answer), or the engine is disabled.');
  } else {
    const counts = new Map<EvolutionSignalType, number>();
    for (const s of signals) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    const newest = signals.reduce((a, b) => (b.at > a.at ? b : a));
    lines.push(`Signal corpus: ${signals.length} captured (most recent ${formatAgo(now - newest.at)}).`);
    for (const [type, label] of Object.entries(SIGNAL_LABELS) as [EvolutionSignalType, string][]) {
      const n = counts.get(type) ?? 0;
      if (n > 0) lines.push(`  ${String(n).padStart(4)}  ${label}`);
    }
  }

  // --- Decision summary ---
  lines.push('');
  if (decisions.length === 0) {
    lines.push('Optimizer: has not run yet — no mutations proposed, verified, or promoted.');
    lines.push('  The nightly optimizer runs during the gardener sleep tick (quiet hours).');
  } else {
    const sorted = [...decisions].sort((a, b) => b.at - a.at);
    const last = sorted[0];
    lines.push(`Optimizer: last activity ${formatAgo(now - last.at)} → ${last.stage}/${last.outcome}.`);
    lines.push('');
    lines.push('Recent decisions (newest first):');
    for (const d of sorted.slice(0, 10)) {
      const reason = d.reason ? ` [${d.reason}]` : '';
      const target = d.target ? ` ${d.target}` : '';
      lines.push(`  ${formatAgo(now - d.at).padStart(8)}  ${d.stage.padEnd(8)} ${d.outcome}${target}${reason}`);
    }
  }

  return lines.join('\n');
}
