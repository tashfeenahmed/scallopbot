import { describe, expect, it } from 'vitest';
import { SkillRegistry } from './registry.js';
import { SkillLoader } from './loader.js';
import { defineSkill } from './sdk.js';
import type { Skill } from './types.js';
import { SKILL_INDEX_HEADER, buildSkillIndex, getIndexableSkills, truncateTrigger } from './skill-index.js';

function docSkill(name: string, description: string, extra: Partial<Skill> = {}): Skill {
  return {
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    source: 'local',
    frontmatter: { name, description },
    content: `# ${name}\nsteps`,
    available: true,
    hasScripts: false,
    ...extra,
  };
}

function registryWith(skills: Skill[]): SkillRegistry {
  const registry = new SkillRegistry(new SkillLoader({}));
  for (const skill of skills) registry.registerSkill(skill);
  return registry;
}

describe('buildSkillIndex', () => {
  it('lists only procedural skills (tools are excluded) with the Hermes header', () => {
    const tool = defineSkill('send_message', 'Send a message to the user').onNativeExecute(async () => ({ success: true, output: '' })).build().skill;
    const registry = registryWith([
      tool,
      docSkill('deploy_static_site', 'Deploy a static site to Cloudflare Pages with wrangler'),
      docSkill('bash_helper', 'Bash helper docs', { hasScripts: true, frontmatter: { name: 'bash_helper', description: 'x', 'disable-model-invocation': true } }),
      docSkill('hidden', 'Hidden', { frontmatter: { name: 'hidden', description: 'Hidden', 'disable-model-invocation': true } }),
      docSkill('offline', 'Unavailable', { available: false }),
    ]);
    const index = buildSkillIndex(registry);
    expect(index.split('\n')).toEqual([
      '# Skills',
      SKILL_INDEX_HEADER,
      '- deploy_static_site: Deploy a static site to Cloudflare Pages with wrangler',
    ]);
    expect(SKILL_INDEX_HEADER).toContain('load it with load_procedure first');
    expect(SKILL_INDEX_HEADER).toContain('update it before finishing');
    expect(getIndexableSkills(registry).map(skill => skill.name)).toEqual(['deploy_static_site']);
  });

  it('cuts descriptions to 57 chars at a word boundary and sorts by name', () => {
    const long = 'Plan, book and track multi-city trips including flights, hotels, visas and travel insurance';
    const registry = registryWith([docSkill('zeta', long), docSkill('alpha', 'Short one')]);
    const lines = buildSkillIndex(registry).split('\n').slice(2);
    expect(lines[0]).toBe('- alpha: Short one');
    const trigger = lines[1].replace('- zeta: ', '');
    expect(trigger.length).toBeLessThanOrEqual(57);
    expect(trigger.endsWith('…')).toBe(true);
    expect(truncateTrigger('a'.repeat(100)).length).toBe(57);
  });

  it('is empty when there are no procedural skills, and is much smaller than generateSkillPrompt', () => {
    expect(buildSkillIndex(registryWith([]))).toBe('');
    const skills = Array.from({ length: 30 }, (_, i) => docSkill(`skill_${i}`, `Detailed description number ${i} explaining exactly when and how to use this procedure in practice`));
    const registry = registryWith(skills);
    expect(buildSkillIndex(registry).length).toBeLessThan(registry.generateSkillPrompt().length / 1.5);
  });
});
