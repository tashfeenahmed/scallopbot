import type { ToolEvidenceReceipt } from '../memory/db.js';
import { stripThinkTags } from '../utils/output-safety.js';

export type SubAgentResultStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'timed_out';

export interface SubAgentArtifact {
  type: 'file' | 'patch' | 'url' | 'report' | 'test';
  value: string;
  digest?: string;
}

export interface StructuredSubAgentResult {
  status: SubAgentResultStatus;
  summary: string;
  artifacts: SubAgentArtifact[];
  changedFiles: string[];
  tests: string[];
  blockers: string[];
  nextActions: string[];
  acceptanceCriteria: string[];
  acceptancePassed: boolean;
  evidenceReceipts: ToolEvidenceReceipt[];
}

function stringArray(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseJsonCandidate(text: string): Record<string, unknown> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].at(-1)?.[1];
  const candidates = [fenced, text.trim()].filter((entry): entry is string => !!entry);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Prose fallback below is intentional.
    }
  }
  return null;
}

function artifacts(value: unknown): SubAgentArtifact[] {
  if (!Array.isArray(value)) return [];
  const output: SubAgentArtifact[] = [];
  for (const entry of value.slice(0, 100)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const artifactValue = record.value;
    if (!['file', 'patch', 'url', 'report', 'test'].includes(String(type))) continue;
    if (typeof artifactValue !== 'string' || !artifactValue.trim()) continue;
    output.push({
      type: type as SubAgentArtifact['type'],
      value: artifactValue.trim(),
      ...(typeof record.digest === 'string' && record.digest.trim()
        ? { digest: record.digest.trim() }
        : {}),
    });
  }
  return output;
}

export function buildStructuredSubAgentResult(input: {
  response: string;
  runtimeStatus: SubAgentResultStatus;
  acceptanceCriteria?: readonly string[];
  evidenceReceipts?: readonly ToolEvidenceReceipt[];
  changedFiles?: readonly string[];
  additionalArtifacts?: readonly SubAgentArtifact[];
  additionalBlockers?: readonly string[];
  /** Runtime-owned verification result; never sourced from model prose. */
  verifiedAcceptancePassed?: boolean;
}): StructuredSubAgentResult {
  const cleaned = input.response.replace(/\[DONE\]\s*$/i, '').trim();
  const parsed = parseJsonCandidate(cleaned);
  const requestedCriteria = [...(input.acceptanceCriteria ?? [])].map(item => item.trim()).filter(Boolean);
  const parsedStatus = parsed?.status;
  const declaredStatus = ['succeeded', 'failed', 'blocked', 'cancelled', 'timed_out'].includes(String(parsedStatus))
    ? parsedStatus as SubAgentResultStatus
    : input.runtimeStatus;
  // Runtime failure always wins over model-authored success.
  const status = input.runtimeStatus === 'succeeded' ? declaredStatus : input.runtimeStatus;
  const rawSummary = typeof parsed?.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : cleaned || `Sub-agent ${status}.`;
  const summary = stripThinkTags(rawSummary)
    .replace(/^\s*(?:analysis|internal thoughts?|scratchpad|chain of thought)\s*:\s*.*$/gim, '')
    .trim() || `Sub-agent ${status}.`;
  const blockers = [
    ...stringArray(parsed?.blockers),
    ...(input.additionalBlockers ?? []),
  ].map(item => item.trim()).filter(Boolean);
  const acceptancePassed = status === 'succeeded'
    && blockers.length === 0
    && (input.verifiedAcceptancePassed === true || (requestedCriteria.length === 0
      ? parsed?.acceptancePassed !== false
      : parsed?.acceptancePassed === true));

  return {
    status: acceptancePassed ? 'succeeded' : status === 'succeeded' ? 'blocked' : status,
    summary,
    artifacts: [
      ...artifacts(parsed?.artifacts),
      ...(input.additionalArtifacts ?? []),
    ],
    changedFiles: [...new Set([
      ...stringArray(parsed?.changedFiles),
      ...(input.changedFiles ?? []),
    ])],
    tests: stringArray(parsed?.tests),
    blockers,
    nextActions: stringArray(parsed?.nextActions),
    acceptanceCriteria: requestedCriteria,
    acceptancePassed,
    evidenceReceipts: [...(input.evidenceReceipts ?? [])],
  };
}

export function structuredResultPrompt(acceptanceCriteria: readonly string[]): string {
  return [
    'Return your final answer as one JSON object with this exact shape:',
    '{"status":"succeeded|failed|blocked","summary":"...","artifacts":[{"type":"file|patch|url|report|test","value":"..."}],"changedFiles":[],"tests":[],"blockers":[],"nextActions":[],"acceptancePassed":true}',
    'Do not claim acceptancePassed=true unless every requested criterion is actually satisfied.',
    acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : 'No explicit acceptance criteria were supplied; report concrete evidence and blockers honestly.',
  ].join('\n');
}
