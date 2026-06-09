/**
 * Layer 2 — automatic verification gate.
 *
 * "Fully autonomous" means no human approves a mutation — so these cheap,
 * deterministic checks are what stand between a machine-authored skill and the
 * live registry. A mutation must clear every gate to be promoted:
 *   1. parse   — SKILL.md has valid frontmatter; name is valid and matches target.
 *   2. structure — any script referenced by frontmatter actually exists.
 *   3. smoke   — the skill loads and runs once without a load/syntax/import crash.
 *
 * (Before/after fitness A/B against the eval harness is layered on in P4; the
 * self-healing auto-rollback in the optimizer is the runtime safety net.)
 */

import type { Logger } from 'pino';
import { parseFrontmatter } from '../skills/parser.js';
import type { SkillLoader } from '../skills/loader.js';
import type { SkillExecutor } from '../skills/executor.js';
import type { SkillMutation } from './types.js';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Safe skill-name + directory convention (matches existing names like run_code, web_search). */
const SAFE_SKILL_NAME = /^[a-z][a-z0-9_-]*$/;

export interface VerifyDeps {
  loader: SkillLoader;
  executor: SkillExecutor;
  /** Absolute path to the staged SKILL.md to smoke-test. */
  stagedSkillMdPath: string;
  /** Args to pass to the smoke run (drawn from a representative trajectory). */
  smokeArgs?: Record<string, unknown>;
  smokeTimeoutMs?: number;
  logger?: Logger;
}

/** Stderr fingerprints that indicate broken code (transform/syntax/import errors). */
const LOAD_ERROR_PATTERNS = [
  /SyntaxError/i,
  /Cannot find module/i,
  /is not defined/i,
  /Unexpected (token|identifier|end of)/i,
  /Expected .* but found/i, // esbuild/tsx transform error
  /Transform failed/i,
  /Build failed/i,
  /TypeError: .*is not a function/i,
  /Cannot read propert/i,
  /ERR_MODULE_NOT_FOUND/i,
  /\bTS\d{3,5}\b/, // tsc/tsx diagnostic codes e.g. TS2304
];

export async function verifyMutation(mutation: SkillMutation, deps: VerifyDeps): Promise<VerifyResult> {
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

  // --- Gate 2: referenced scripts exist in the staged file set ---
  const scripts = parsed.frontmatter.scripts;
  if (scripts) {
    for (const rel of Object.values(scripts)) {
      if (typeof rel === 'string' && !(rel in mutation.files)) {
        return { ok: false, reason: 'parse_failed', detail: { why: `script '${rel}' referenced but not provided` } };
      }
    }
  }

  // A skill with no executable script can't be smoke-tested — parse gate is enough.
  const hasScript =
    !!scripts ||
    Object.keys(mutation.files).some(f => f.startsWith('scripts/'));
  if (!hasScript) {
    return { ok: true, detail: { smoke: 'skipped (no script)' } };
  }

  // --- Gate 3: smoke test (load + run once) ---
  let skill;
  try {
    skill = await deps.loader.loadSkillFile(deps.stagedSkillMdPath, 'local');
  } catch (e) {
    return { ok: false, reason: 'parse_failed', detail: { why: `load failed: ${(e as Error).message}` } };
  }
  if (!skill) {
    return { ok: false, reason: 'parse_failed', detail: { why: 'skill failed to load' } };
  }

  try {
    const result = await deps.executor.execute(skill, {
      skillName: skill.name,
      action: 'run',
      args: deps.smokeArgs ?? {},
      userId: 'evolution-smoke',
      sessionId: 'evolution-smoke',
    });
    // A machine-authored skill passes the smoke gate only if it loaded and ran:
    // either it exited 0, or it produced structured JSON output (a graceful
    // arg-related error). A transform/syntax/import error yields neither — fail.
    const stderr = result.error ?? '';
    const stdout = (result.output ?? '').trim();
    const producedJson = stdout.startsWith('{') || /"success"\s*:/.test(stdout);
    const loadError =
      LOAD_ERROR_PATTERNS.some(p => p.test(stderr)) ||
      (!result.success && !producedJson);
    if (loadError) {
      return { ok: false, reason: 'smoke_failed', detail: { stderr: stderr.slice(0, 500), exitCode: result.exitCode } };
    }
    return { ok: true, detail: { smoke: result.success ? 'ran' : 'ran-with-arg-error' } };
  } catch (e) {
    return { ok: false, reason: 'smoke_failed', detail: { why: (e as Error).message } };
  }
}
