/** Safe, observable loader for documentation-only procedural skills. */

import { defineSkill } from '../skills/sdk.js';
import type { Skill, SkillRegistry } from '../skills/index.js';

const SAFE_PROCEDURE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PROCEDURE_CHARS = 20_000;

export interface ProcedureRegistry {
  getDocumentationSkills(): Skill[];
}

/**
 * Documentation-only learned skills cannot execute code. This native tool lets
 * the model explicitly select one, load its instructions, and emit a genuine
 * usage event for lifecycle curation.
 */
export function createLoadProcedureSkill(
  registry: ProcedureRegistry | SkillRegistry,
  onUse?: (name: string) => void | Promise<void>,
): Skill {
  return defineSkill(
    'load_procedure',
    'Load the full instructions for a documentation-only procedural skill. Use this before following a listed learned procedure.',
  )
    .userInvocable(false)
    .inputSchema({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact procedure name from the procedural-skills list' },
      },
      required: ['name'],
    })
    .onNativeExecute(async context => {
      const name = typeof context.args.name === 'string' ? context.args.name.trim() : '';
      if (!SAFE_PROCEDURE_NAME.test(name)) {
        return { success: false, output: '', error: 'A valid procedure name is required.' };
      }
      const skill = registry.getDocumentationSkills().find(
        candidate => candidate.name === name && !candidate.hasScripts,
      );
      if (!skill || !skill.available) {
        return { success: false, output: '', error: `Documentation procedure "${name}" is not available.` };
      }
      const instructions = skill.content.trim();
      if (!instructions) {
        return { success: false, output: '', error: `Procedure "${name}" has no instructions.` };
      }

      // Telemetry is best-effort and must never prevent a valid procedure load.
      try {
        await onUse?.(name);
      } catch {
        // Ignore sidecar failures; the procedure itself remains usable.
      }
      const bounded = instructions.length <= MAX_PROCEDURE_CHARS
        ? instructions
        : `${instructions.slice(0, MAX_PROCEDURE_CHARS)}\n[procedure truncated]`;
      return {
        success: true,
        output: `Loaded documentation procedure "${name}":\n<procedure>\n${bounded}\n</procedure>`,
      };
    })
    .build()
    .skill;
}
