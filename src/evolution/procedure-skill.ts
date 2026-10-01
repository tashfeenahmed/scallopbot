/** Safe, observable loader for documentation-only procedural skills. */

import { lstat, readdir, readFile, realpath } from 'fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { defineSkill } from '../skills/sdk.js';
import type { Skill, SkillRegistry } from '../skills/index.js';

const SAFE_PROCEDURE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_PROCEDURE_CHARS = 20_000;
const MAX_RESOURCE_BYTES = 64 * 1024;
const MAX_LISTED_RESOURCES = 50;
const MAX_RESOURCE_DEPTH = 3;
const SKIPPED_RESOURCES = new Set(['SKILL.md', '.version.json']);

/**
 * Bundled files next to SKILL.md (agentskills.io `references/`, `scripts/`,
 * `assets/`, ...). Listed on load so the model can fetch them on demand.
 */
async function listSkillResources(skillDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_RESOURCE_DEPTH || found.length >= MAX_LISTED_RESOURCES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_LISTED_RESOURCES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(skillDir, full).split(sep).join('/');
        if (!SKIPPED_RESOURCES.has(rel)) found.push(rel);
      }
    }
  };
  await walk(skillDir, 0);
  return found;
}

/** Read one bundled text file, confined to the skill directory (no symlink escape). */
async function readSkillResource(skillDir: string, file: string): Promise<string> {
  if (!file || file.length > 512 || isAbsolute(file) || file.includes('\0') ||
      file.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) {
    throw new Error('file must be a relative path inside the skill folder');
  }
  const root = await realpath(skillDir);
  const target = await realpath(join(root, file));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('file must be inside the skill folder');
  }
  const info = await lstat(target);
  if (!info.isFile()) throw new Error('file is not a regular file');
  if (info.size > MAX_RESOURCE_BYTES) {
    throw new Error(`file exceeds ${MAX_RESOURCE_BYTES} bytes; read it with a shell tool if needed`);
  }
  const content = await readFile(target, 'utf8');
  if (content.includes('\0')) throw new Error('file is binary');
  return content;
}

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
        file: {
          type: 'string',
          description: 'Optional bundled file to read instead, relative to the skill folder (e.g. references/guide.md)',
        },
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
      const skillDir = dirname(skill.path);
      const file = typeof context.args.file === 'string' ? context.args.file.trim() : '';
      if (file) {
        try {
          const content = await readSkillResource(skillDir, file);
          const bounded = content.length <= MAX_PROCEDURE_CHARS
            ? content
            : `${content.slice(0, MAX_PROCEDURE_CHARS)}\n[file truncated]`;
          return {
            success: true,
            output: `File "${file}" from procedure "${name}":\n<procedure_file>\n${bounded}\n</procedure_file>`,
          };
        } catch (error) {
          return { success: false, output: '', error: `Cannot read "${file}": ${(error as Error).message}` };
        }
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
      const extras: string[] = [];
      const resources = skill.source === 'sdk' ? [] : await listSkillResources(skillDir);
      if (resources.length > 0) {
        extras.push(
          `Skill folder: ${skillDir}`,
          'Bundled files (load one with load_procedure name + file; run scripts from the skill folder):',
          ...resources.map(resource => `- ${resource}`),
        );
      }
      const allowedTools = skill.frontmatter['allowed-tools'];
      if (allowedTools?.length) {
        extras.push(`Tools this skill expects: ${allowedTools.join(', ')} (normal tool policy still applies)`);
      }
      return {
        success: true,
        output: `Loaded documentation procedure "${name}":\n<procedure>\n${bounded}\n</procedure>` +
          (extras.length > 0 ? `\n${extras.join('\n')}` : ''),
      };
    })
    .build()
    .skill;
}
