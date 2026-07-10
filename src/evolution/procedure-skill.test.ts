import { describe, expect, it, vi } from 'vitest';
import type { Skill } from '../skills/types.js';
import { createLoadProcedureSkill } from './procedure-skill.js';

function procedure(name = 'evidence_research'): Skill {
  return {
    name,
    description: 'Reusable evidence-first research procedure',
    path: `/tmp/${name}/SKILL.md`,
    source: 'local',
    frontmatter: { name, description: 'Reusable evidence-first research procedure' },
    content: '# Evidence research\nUse primary sources and state uncertainty.',
    available: true,
    hasScripts: false,
  };
}

describe('load_procedure skill', () => {
  it('loads a documentation procedure and records explicit use', async () => {
    const onUse = vi.fn();
    const skill = createLoadProcedureSkill({ getDocumentationSkills: () => [procedure()] }, onUse);
    const result = await skill.handler!({
      args: { name: 'evidence_research' },
      workspace: '/tmp',
      sessionId: 'session',
      userId: 'user',
    });

    expect(result).toMatchObject({ success: true });
    expect(result.output).toContain('<procedure>');
    expect(result.output).toContain('Use primary sources');
    expect(onUse).toHaveBeenCalledWith('evidence_research');
  });

  it('does not expose executable, missing, or malformed procedure names', async () => {
    const executable = { ...procedure('unsafe'), hasScripts: true };
    const registry = { getDocumentationSkills: () => [procedure(), executable] };
    const loader = createLoadProcedureSkill(registry);
    const context = { workspace: '/tmp', sessionId: 'session', userId: 'user' };

    await expect(loader.handler!({ ...context, args: { name: '../escape' } }))
      .resolves.toMatchObject({ success: false });
    await expect(loader.handler!({ ...context, args: { name: 'unsafe' } }))
      .resolves.toMatchObject({ success: false });
    await expect(loader.handler!({ ...context, args: { name: 'missing' } }))
      .resolves.toMatchObject({ success: false });
  });

  it('keeps loading when usage telemetry is temporarily unavailable', async () => {
    const loader = createLoadProcedureSkill(
      { getDocumentationSkills: () => [procedure()] },
      async () => { throw new Error('sidecar unavailable'); },
    );
    await expect(loader.handler!({
      args: { name: 'evidence_research' },
      workspace: '/tmp',
      sessionId: 'session',
      userId: 'user',
    })).resolves.toMatchObject({ success: true });
  });
});
