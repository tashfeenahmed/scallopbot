/**
 * Proactive Decision Log — observability for "why didn't the bot reach out?"
 *
 * Proactiveness can be silently stopped at ~15 different points (cooldown,
 * budget, no signals, the LLM evaluator skipping, min-gap throttle, send-dedup,
 * quiet hours, no registered channel, …). When nothing fires, there is no way
 * to tell *which* gate closed. This module defines a structured decision record
 * that the gardener and scheduler append at each decision point, plus a pure
 * formatter that turns the recent records into a plain-English explanation for
 * the `why-no-proact` CLI command.
 *
 * The record type is storage-agnostic; persistence lives in ScallopDatabase
 * (proactive_decisions table) so the CLI can read it from a separate process.
 */

/** Where in the pipeline a decision was made. */
export type ProactiveStage = 'evaluate' | 'create' | 'deliver';

export interface ProactiveDecision {
  id?: number;
  userId: string;
  /** Epoch ms when the decision was made. */
  at: number;
  stage: ProactiveStage;
  /** What happened: created | skipped | deduped | suppressed | queued | failed. */
  outcome: string;
  /** Machine reason code (see REASON_EXPLANATIONS), if any. */
  reason?: string | null;
  /** Free-form context (dial, signalsFound, budget, cooldownRemainingMs, …). */
  detail?: Record<string, unknown> | null;
}

/** Plain-English explanation for each known reason code. */
export const REASON_EXPLANATIONS: Record<string, string> = {
  cooldown:
    'A proactive message was sent recently, so the evaluator is in its cooldown window and is not generating new ones.',
  distress:
    "Suppressed because the user's recent affect read as distressed — proactivity pauses until mood recovers.",
  budget_exhausted:
    'The daily proactive budget for the current dial is used up. It resets at local midnight.',
  no_signals:
    'No gap signals (stale goals, stale board items, unresolved threads) and no recent session to follow up on — there was simply nothing to be proactive about.',
  llm_skipped_all:
    'Signals existed, but the LLM evaluator judged that none warranted a nudge (the dial guidance may be too conservative).',
  llm_error: "The evaluator's LLM call failed, so no items were produced.",
  min_gap:
    'An item was ready to send but was suppressed by the min-gap throttle (no two agent sends within the gap window).',
  send_dedup:
    'An item was ready but suppressed as a near-duplicate of a message sent recently (word-overlap dedup).',
  pre_create_dedup:
    'A generated item duplicated an already-pending one, so it was not created.',
  no_trigger_source:
    'A message was ready but no channel was registered to deliver it (e.g. Telegram disabled or not connected).',
  bot_not_running:
    'A message was ready but the delivery channel was not running at send time.',
  created: 'A proactive item was created and scheduled.',
  queued: 'A proactive message was handed to the delivery queue.',
  sent: 'A proactive message was delivered.',
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

function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function describe(d: ProactiveDecision, _now: number): string {
  const base = d.reason ? (REASON_EXPLANATIONS[d.reason] ?? d.reason) : d.outcome;
  let extra = '';
  const detail = d.detail ?? {};
  if (d.reason === 'cooldown' && typeof detail.cooldownRemainingMs === 'number') {
    extra = ` Cooldown clears in ~${formatDuration(detail.cooldownRemainingMs)}.`;
  }
  if (d.reason === 'budget_exhausted' && detail.budgetCap != null) {
    extra = ` (dial '${detail.dial}', cap ${detail.budgetCap}/day, ${detail.todayItemCount ?? '?'} used today).`;
  }
  if (d.reason === 'no_signals' && detail.dial != null) {
    extra = ` (dial '${detail.dial}').`;
  }
  return `${base}${extra}`;
}

/**
 * Turn the recent decision records into a human-readable diagnosis of why
 * proactive messages are / aren't firing. Pure — takes the records and a clock.
 */
export function explainProactiveDecisions(
  decisions: ProactiveDecision[],
  now: number = Date.now()
): string {
  if (decisions.length === 0) {
    return [
      'No proactive decisions have been recorded yet.',
      '',
      'Likely meaning: the deep tick (which evaluates proactivity ~every 72 min) has not run since this build, or the gardener/scheduler is not started.',
      "Check the bot is running and look for 'BackgroundGardener started' and 'UnifiedScheduler started' in the logs.",
    ].join('\n');
  }

  // Newest first.
  const sorted = [...decisions].sort((a, b) => b.at - a.at);
  const lastEvaluate = sorted.find((d) => d.stage === 'evaluate');
  const lastDeliver = sorted.find((d) => d.stage === 'deliver');

  const lines: string[] = ['Proactiveness diagnosis', '======================='];

  if (lastEvaluate) {
    lines.push('');
    lines.push(`Last evaluation: ${formatAgo(now - lastEvaluate.at)} → ${lastEvaluate.outcome}`);
    lines.push(`  ${describe(lastEvaluate, now)}`);
    const det = lastEvaluate.detail ?? {};
    if (det.signalsFound != null || det.itemsCreated != null) {
      lines.push(`  signals=${det.signalsFound ?? '?'}, created=${det.itemsCreated ?? 0}, llmCalled=${det.llmCalled ?? '?'}`);
    }
  } else {
    lines.push('');
    lines.push('No evaluation decisions recorded yet — the deep tick may not have run since start.');
  }

  if (lastDeliver) {
    lines.push('');
    lines.push(`Last delivery decision: ${formatAgo(now - lastDeliver.at)} → ${lastDeliver.outcome}`);
    lines.push(`  ${describe(lastDeliver, now)}`);
  } else {
    lines.push('');
    lines.push('No delivery attempts recorded — nothing has reached the scheduler send path yet.');
  }

  // One-line verdict.
  lines.push('');
  lines.push('Verdict:');
  if (lastEvaluate && lastEvaluate.outcome === 'skipped') {
    lines.push(`  Proactivity is currently GATED at evaluation: ${lastEvaluate.reason ?? 'unknown'}. ${describe(lastEvaluate, now)}`);
  } else if (lastDeliver && lastDeliver.outcome === 'suppressed') {
    lines.push(`  Items are being created but SUPPRESSED at delivery: ${lastDeliver.reason ?? 'unknown'}.`);
  } else if (lastDeliver && (lastDeliver.outcome === 'failed')) {
    lines.push(`  Items reach delivery but FAIL to send: ${lastDeliver.reason ?? 'unknown'}. Check the channel is connected.`);
  } else if (lastEvaluate && lastEvaluate.outcome === 'created') {
    lines.push('  Proactivity is working — items are being created. If you saw nothing, check delivery/quiet-hours timing.');
  } else {
    lines.push('  Inconclusive from the records — see the recent history below.');
  }

  // Recent history tail.
  lines.push('');
  lines.push('Recent decisions (newest first):');
  for (const d of sorted.slice(0, 10)) {
    const reason = d.reason ? ` [${d.reason}]` : '';
    lines.push(`  ${formatAgo(now - d.at).padStart(8)}  ${d.stage.padEnd(8)} ${d.outcome}${reason}`);
  }

  return lines.join('\n');
}
