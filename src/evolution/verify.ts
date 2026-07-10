/**
 * Layer 2 — automatic verification gate.
 *
 * "Fully autonomous" means no human approves a mutation — so these cheap,
 * deterministic checks are what stand between a machine-authored skill and the
 * live registry. A mutation must clear every gate to be promoted:
 *   1. parse   — SKILL.md has valid frontmatter; name is valid and matches target.
 *   2. structure — any script referenced by frontmatter actually exists.
 *   3. safety  — deterministic dangerous-pattern rejection.
 *   4. isolation — executable mutations are rejected until an OS-isolated
 *                  verifier/promotion path exists.
 */

import { parseFrontmatter } from '../skills/parser.js';
import type { SkillMutation } from './types.js';
import { findUnsafeEvolutionContentReason } from './privacy.js';
import yaml from 'js-yaml';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Safe skill-name + directory convention (matches existing names like run_code, web_search). */
const SAFE_SKILL_NAME = /^[a-z][a-z0-9_-]{0,127}$/;
/** Fits in full alongside evaluation prompts across every supported judge model. */
export const MAX_EVOLUTION_ARTIFACT_BYTES = 12 * 1024;
const ALLOWED_DOCUMENTATION_FILES = new Set(['SKILL.md']);
const ALLOWED_DOCUMENTATION_FRONTMATTER = new Set([
  'name',
  'description',
  'user-invocable',
]);
const EXECUTION_FRONTMATTER = new Set([
  'scripts',
  'command-dispatch',
  'command-tool',
  'command-arg-mode',
  'metadata',
]);

export interface VerifyDeps {
  /** Reserved for a future OS-isolated executable verifier adapter. */
  isolation?: never;
}

const DANGEROUS_MUTATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(?:-[a-z]*f[a-z]*\s+)*\/(?:\s|$)|\brm\s+-rf\b/i, label: 'destructive deletion' },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i, label: 'remote shell pipe' },
  { pattern: /(?:node:)?child_process|\bexecSync\s*\(|\bspawnSync\s*\(/i, label: 'process spawning' },
  { pattern: /process\.env\s*(?:\[|\.)/i, label: 'ambient secret access' },
  { pattern: /(?:\.ssh|\.aws|\.gnupg|id_rsa|credentials(?:\.json)?)/i, label: 'credential-file access' },
];

function rawFrontmatter(skillMd: string): Record<string, unknown> | null {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  try {
    const parsed = yaml.load(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function artifactBytes(mutation: SkillMutation): number {
  return Object.entries(mutation.files).reduce(
    (total, [name, content]) => total + Buffer.byteLength(name) + Buffer.byteLength(content),
    0,
  );
}

export async function verifyMutation(mutation: SkillMutation, _deps: VerifyDeps): Promise<VerifyResult> {
  const totalBytes = artifactBytes(mutation);
  if (totalBytes > MAX_EVOLUTION_ARTIFACT_BYTES) {
    return {
      ok: false,
      reason: 'artifact_too_large',
      detail: { bytes: totalBytes, maximum: MAX_EVOLUTION_ARTIFACT_BYTES },
    };
  }
  const fileNames = Object.keys(mutation.files);
  const executableFile = fileNames.find(name => name.startsWith('scripts/'));
  if (executableFile) {
    return {
      ok: false,
      reason: 'executable_requires_isolation',
      detail: { why: `machine-authored executable file '${executableFile}' is forbidden` },
    };
  }
  const unsupportedFile = fileNames.find(name => !ALLOWED_DOCUMENTATION_FILES.has(name));
  if (unsupportedFile) {
    return {
      ok: false,
      reason: 'documentation_only_failed',
      detail: { why: `machine-authored file '${unsupportedFile}' is not allowed` },
    };
  }

  // --- Gate 1: parse + name ---
  const skillMd = mutation.files['SKILL.md'];
  if (!skillMd) return { ok: false, reason: 'parse_failed', detail: { why: 'missing SKILL.md' } };
  let parsed;
  try {
    parsed = parseFrontmatter(skillMd);
  } catch (e) {
    return { ok: false, reason: 'parse_failed', detail: { why: (e as Error).message } };
  }
  const name = parsed.frontmatter.name;
  if (!name || !SAFE_SKILL_NAME.test(name)) {
    return { ok: false, reason: 'parse_failed', detail: { why: `invalid skill name '${name}'` } };
  }
  if (name !== mutation.target) {
    return { ok: false, reason: 'parse_failed', detail: { why: `name '${name}' != target '${mutation.target}'` } };
  }
  if (!parsed.frontmatter.description) {
    return { ok: false, reason: 'parse_failed', detail: { why: 'missing description' } };
  }

  const raw = rawFrontmatter(skillMd);
  if (!raw) return { ok: false, reason: 'parse_failed', detail: { why: 'invalid raw frontmatter' } };
  const executableKey = Object.keys(raw).find(key => EXECUTION_FRONTMATTER.has(key));
  if (executableKey) {
    return {
      ok: false,
      reason: executableKey === 'scripts' ? 'executable_requires_isolation' : 'documentation_only_failed',
      detail: { why: `execution frontmatter '${executableKey}' is forbidden` },
    };
  }
  const unsupportedKey = Object.keys(raw).find(key => !ALLOWED_DOCUMENTATION_FRONTMATTER.has(key));
  if (unsupportedKey) {
    return {
      ok: false,
      reason: 'documentation_only_failed',
      detail: { why: `frontmatter '${unsupportedKey}' is not allowed` },
    };
  }
  if (raw['user-invocable'] !== false) {
    return {
      ok: false,
      reason: 'documentation_only_failed',
      detail: { why: 'machine-authored procedures must set user-invocable: false' },
    };
  }
  const description = raw.description;
  if (
    typeof description !== 'string'
    || description.length === 0
    || description.length > 300
    || /[\r\n\u0000-\u001f\u007f]/.test(description)
    || /(?:^|\s)#{1,6}\s|<\/?(?:system|assistant|developer|tool)\b|^\s*(?:system|assistant|developer|user|tool)\s*:|```|\[INST\]|<<SYS>>/i.test(description)
  ) {
    return {
      ok: false,
      reason: 'documentation_only_failed',
      detail: { why: 'description must be a single-line plain-text summary of at most 300 characters' },
    };
  }

  const combined = Object.entries(mutation.files)
    .map(([name, content]) => `${name}\n${content}`)
    .join('\n');
  const unsafeContent = findUnsafeEvolutionContentReason(
    `${combined}\nmutation rationale\n${mutation.rationale}`,
  );
  if (unsafeContent) {
    const privacy = unsafeContent.startsWith('personal data:');
    return {
      ok: false,
      reason: privacy ? 'privacy_failed' : 'safety_failed',
      detail: { why: unsafeContent },
    };
  }
  for (const check of DANGEROUS_MUTATION_PATTERNS) {
    if (check.pattern.test(combined)) {
      return { ok: false, reason: 'safety_failed', detail: { why: check.label } };
    }
  }

  return { ok: true, detail: { mode: 'documentation-only', bytes: totalBytes } };
}
