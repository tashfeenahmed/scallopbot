/**
 * Compact, Hermes-style index of procedural skills for the frozen system prompt.
 *
 * Replaces generateSkillPrompt() in the agent prompt: executable skills are
 * already described by their tool schemas, so listing them again in prose only
 * cost 3-5k tokens per call. The index keeps instruction-only (documentation)
 * skills, one line each, with descriptions cut to 57 characters. The full text
 * is loaded on demand through load_procedure.
 */

import type { Skill } from './types.js';

export const SKILL_INDEX_HEADER =
  'If a skill matches or is even partially relevant, load it with load_procedure first. ' +
  'If it was missing steps, update it before finishing.';

export const SKILL_INDEX_DESCRIPTION_CHARS = 57;

export interface SkillIndexRegistry {
  getDocumentationSkills(): Skill[];
  getExecutableSkills(): Skill[];
}

/** Single-line description cut to `max` chars (ellipsis included). */
export function truncateTrigger(description: string, max: number = SKILL_INDEX_DESCRIPTION_CHARS): string {
  const line = description.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return `${(atWord.length >= max * 0.6 ? atWord : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** Procedural skills that load_procedure can serve and that are not tools. */
export function getIndexableSkills(registry: SkillIndexRegistry): Skill[] {
  const toolNames = new Set(registry.getExecutableSkills().map(skill => skill.name));
  return registry.getDocumentationSkills()
    .filter(skill =>
      skill.available
      && !skill.hasScripts
      && !toolNames.has(skill.name)
      && skill.frontmatter['disable-model-invocation'] !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the skills index:
 *
 *   # Skills
 *   If a skill matches or is even partially relevant, load it with load_procedure first. ...
 *   - name: <≤57-char trigger>
 *
 * Returns '' when there are no procedural skills. Byte-stable for a given
 * registry state (sorted by name) so it can live in the cached prompt prefix.
 */
export function buildSkillIndex(registry: SkillIndexRegistry, options: { heading?: string } = {}): string {
  const skills = getIndexableSkills(registry);
  if (skills.length === 0) return '';
  const lines = skills.map(skill => `- ${skill.name}: ${truncateTrigger(skill.description || skill.name)}`);
  return [`${options.heading ?? '# Skills'}`, SKILL_INDEX_HEADER, ...lines].join('\n');
}
