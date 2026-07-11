/**
 * Layer 2 — reflective mutation (the GEPA-style step).
 *
 * Given a cluster of related improvement signals (and, optionally, hydrated
 * trajectories), ask the evolution model to diagnose the root cause and propose
 * one concrete skill mutation. The model it runs on is resolved by the caller via
 * config.models.evolution (PurposeRouter) — model policy is NOT decided here.
 *
 * Output is forced to a strict JSON shape and parsed defensively; any deviation
 * yields null so the optimizer can record a clean "reflect skipped/failed".
 */

import type { LLMProvider, ContentBlock } from '../providers/types.js';
import type { StoredEvolutionSignal, SkillMutation, PromptMutation, SkillFiles } from './types.js';
import { findUnsafeEvolutionContentReason } from './privacy.js';

export interface SignalCluster {
  /** What the cluster is about: a skill name (patch), a synthetic key (new skill), or a prompt fragment. */
  key: string;
  /** Cluster intent → mutation kind. */
  intent: 'patch_skill' | 'create_skill' | 'patch_prompt';
  signals: StoredEvolutionSignal[];
  /** Optional trajectory excerpts that ground the diagnosis. */
  trajectories?: string[];
  /** For patch intent: the current SKILL.md content of the target, if available. */
  currentFiles?: SkillFiles;
}

const SYSTEM_PROMPT =
  'You are a self-improvement optimizer for an autonomous agent. You read execution ' +
  'signals and propose ONE concrete skill mutation that would make the agent more ' +
  'reliable. This runtime accepts machine-authored documentation/procedure skills only. ' +
  'Return exactly one file named SKILL.md (maximum 12 KiB). Its YAML frontmatter must contain ' +
  'exactly three keys: name, description, and user-invocable. The description must be plain ' +
  'single-line text of at most 300 characters, and user-invocable must be false. Do not add ' +
  'inputSchema, triggers, metadata, command fields, scripts, executable code, or shell commands. ' +
  'Respond with STRICT JSON only, no prose, matching:\n' +
  '{"target":"skill_name","rationale":"...","files":{"SKILL.md":"..."}}\n' +
  'Rules: target is lowercase letters/digits/hyphens/underscores, at most 128 characters; ' +
  'SKILL.md must be valid; for a patch, ' +
  'return the FULL updated files (not a diff). ' +
  'Generalize the procedure: NEVER copy personal names, contact details, account IDs, home paths, ' +
  'conversation quotes, credentials, or user-specific facts into a skill.';

/** Provider-enforced shape for a documentation-only skill proposal. */
export const SKILL_MUTATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'rationale', 'files'],
  properties: {
    target: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,127}$' },
    rationale: { type: 'string' },
    files: {
      type: 'object',
      additionalProperties: false,
      required: ['SKILL.md'],
      properties: {
        'SKILL.md': { type: 'string' },
      },
    },
  },
};

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/** Pull the first balanced top-level JSON object out of a model response. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function buildUserPrompt(cluster: SignalCluster): string {
  const lines: string[] = [];
  lines.push(
    cluster.intent === 'patch_skill'
      ? `The skill "${cluster.key}" has been failing. Diagnose why and return a corrected version.`
      : `A multi-step task pattern recurs and should become a reusable skill named after its purpose.`,
  );
  lines.push('');
  lines.push(`Signals (${cluster.signals.length}):`);
  for (const s of cluster.signals.slice(0, 20)) {
    const preview = (s.detail?.preview as string | undefined) ?? '';
    lines.push(`- ${s.type}${s.targetSkill ? ` [${s.targetSkill}]` : ''} score=${s.criticScore ?? '?'} tools=${s.toolCallCount ?? '?'} ${preview}`);
  }
  if (cluster.trajectories?.length) {
    lines.push('');
    lines.push('Trajectory excerpts:');
    for (const t of cluster.trajectories.slice(0, 5)) lines.push(t.slice(0, 1500));
  }
  if (cluster.currentFiles?.['SKILL.md']) {
    lines.push('');
    lines.push('Current SKILL.md:');
    lines.push(cluster.currentFiles['SKILL.md'].slice(0, 3000));
  }
  lines.push('');
  lines.push('Return the JSON mutation now.');
  return lines.join('\n');
}

/** Parse + validate a model response into a SkillMutation. Returns null on any deviation. */
export function parseMutation(text: string, intent: 'create_skill' | 'patch_skill'): SkillMutation | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const target = typeof o.target === 'string' ? o.target.trim() : '';
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  const files = o.files;
  if (!/^[a-z][a-z0-9_-]{0,127}$/.test(target) || !files || typeof files !== 'object') return null;
  const fileMap: SkillFiles = {};
  for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
    if (typeof v === 'string') fileMap[k] = v;
  }
  if (!fileMap['SKILL.md']) return null;
  return { kind: intent, target, rationale, files: fileMap };
}

/** Run one reflection call for a skill cluster. Returns a parsed mutation or null. */
export async function reflectOnCluster(
  cluster: SignalCluster,
  provider: LLMProvider,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<SkillMutation | null> {
  if (cluster.intent === 'patch_prompt') return null;
  const intent = cluster.intent;
  try {
    const response = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(cluster) }],
      maxTokens: opts.maxTokens ?? 2048,
      temperature: 0.4,
      enableThinking: false,
      structuredOutput: {
        name: 'evolution_skill_mutation',
        schema: SKILL_MUTATION_SCHEMA,
        strict: true,
      },
      purpose: 'evolution_reflect',
      signal: opts.signal,
    });
    return parseMutation(extractText(response.content), intent);
  } catch {
    return null;
  }
}

const PROMPT_SYSTEM_PROMPT =
  'You improve an AI assistant by writing a short piece of LEARNED GUIDANCE that will ' +
  'be appended to its system prompt. You are given signals where the assistant produced ' +
  'low-quality answers. Infer the durable lesson and write concise, general guidance ' +
  '(2-5 sentences, imperative voice) that would prevent the failure class. Do NOT include ' +
  'user-specific data, secrets, or one-off facts. Respond with STRICT JSON only:\n' +
  '{"fragmentId":"learned_guidance","rationale":"...","content":"..."}';

const PROMPT_MAX_CONTENT = 1200;
/** Provider-enforced shape for learned prompt guidance. */
export const PROMPT_MUTATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['fragmentId', 'rationale', 'content'],
  properties: {
    fragmentId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
    rationale: { type: 'string' },
    content: { type: 'string', maxLength: PROMPT_MAX_CONTENT },
  },
};
/** Reject guidance that tries to smuggle role markers / tool syntax into the prompt. */
/** Parse + sanity-check a prompt mutation. Returns null on deviation. */
export function parsePromptMutation(text: string, fragmentId: string): PromptMutation | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  if (!content || content.length > PROMPT_MAX_CONTENT) return null;
  const fid = typeof o.fragmentId === 'string' && o.fragmentId ? o.fragmentId : fragmentId;
  if (fid !== fragmentId || !/^[a-z][a-z0-9_-]{0,63}$/.test(fid)) return null;
  if (findUnsafeEvolutionContentReason(`${content}\n${rationale}`)) return null;
  return { kind: 'patch_prompt', fragmentId: fid, content, rationale };
}

/** Run one reflection call for a prompt cluster. Returns a prompt mutation or null. */
export async function reflectOnPromptCluster(
  cluster: SignalCluster,
  provider: LLMProvider,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<PromptMutation | null> {
  try {
    const response = await provider.complete({
      system: PROMPT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(cluster) }],
      maxTokens: opts.maxTokens ?? 1024,
      temperature: 0.4,
      enableThinking: false,
      structuredOutput: {
        name: 'evolution_prompt_mutation',
        schema: PROMPT_MUTATION_SCHEMA,
        strict: true,
      },
      purpose: 'evolution_reflect',
      signal: opts.signal,
    });
    return parsePromptMutation(extractText(response.content), cluster.key || 'learned_guidance');
  } catch {
    return null;
  }
}
