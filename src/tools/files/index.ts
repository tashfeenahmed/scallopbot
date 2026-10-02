/**
 * Native file tools (Hermes-style ergonomics).
 *
 *   read_file   numbered pages, "unchanged" on identical re-reads, did-you-mean
 *   write_file  read-before-overwrite hint, verified write, lint delta
 *   patch       fuzzy old/new replace, atomic multi-edit, unified/Codex diffs
 *   edit_file   alias of patch (single old_string → new_string)
 *   undo        restore shadow-git checkpoints of the agent's edits
 *
 * `registerFileTools(registry)` registers them as in-process SDK skills; a
 * same-named disk skill is replaced (SkillRegistry.registerSkill overrides by
 * name and SDK skills survive reloadFromDisk()).
 */

import type { Skill } from '../../skills/types.js';
import { defineSkill } from '../../skills/sdk.js';
import { FileTools, type FileToolsDeps } from './tools.js';

export { FileTools, type FileToolsDeps } from './tools.js';
export { FileStateStore } from './state.js';
export { CheckpointStore, checkpointBeforeDestructive, defaultCheckpointStore } from './checkpoints.js';
export { planEdit, findMatches, STRATEGY_ORDER, type StrategyName } from './fuzzy.js';

/** Names registered by registerFileTools. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'patch', 'edit_file', 'undo'] as const;
/** File tools that never mutate anything (safe to run in parallel). */
export const READ_ONLY_FILE_TOOLS = ['read_file'] as const;

const editProps = {
  old_string: { type: 'string', description: 'Text to replace, copied from the file. Include enough surrounding lines to match one place. Whitespace/indentation/quote differences are tolerated.' },
  new_string: { type: 'string', description: 'Replacement text (indentation is adapted to the file when the match was flexible).' },
  replace_all: { type: 'boolean', description: 'Replace every match instead of requiring exactly one (default false).' },
};

export function buildFileToolSkills(tools: FileTools): Skill[] {
  const readFile = defineSkill(
    'read_file',
    'Read a text file. Returns numbered LINE|CONTENT lines, 2,000 lines per page — use offset to continue. Re-reading an unchanged file returns {"status":"unchanged"}: use what you already have.',
  )
    .userInvocable(false)
    .safety({ readOnly: true })
    .inputSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace (or absolute inside it).' },
        offset: { type: 'number', description: '1-based line to start from (default 1).' },
        limit: { type: 'number', description: 'Max lines to return (default and max 2000).' },
      },
      required: ['path'],
    })
    .onNativeExecute(ctx => tools.read(ctx))
    .build();

  const writeFile = defineSkill(
    'write_file',
    'Create a file or replace it entirely (parent directories are created). To change part of an existing file use patch. Overwriting a file you have not read this session (or that changed on disk) is refused once with the reason — repeat the call or pass overwrite:true to proceed.',
  )
    .userInvocable(false)
    .safety({ localWrite: true })
    .inputSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'The complete file content.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file even if you have not read it this session (default false).' },
        append: { type: 'boolean', description: 'Add content to the end of the file instead of replacing it (creates the file if missing).' },
      },
      required: ['path', 'content'],
    })
    .onNativeExecute(ctx => tools.write(ctx))
    .build();

  const patch = defineSkill(
    'patch',
    'Edit files — the main editor. Either old_string → new_string (fuzzy matching tolerates whitespace, indentation, escaping and smart-quote differences), edits:[…] for several all-or-nothing replacements in one file, or patch:"<unified diff or *** Begin Patch block>" for multi-file diffs. Returns a diff, verification and only NEW lint problems — no need to re-read.',
  )
    .userInvocable(false)
    .safety({ localWrite: true })
    .inputSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit. Optional in diff mode when the diff has file headers.' },
        ...editProps,
        edits: {
          type: 'array',
          description: 'Several replacements for the same file, applied in order; if any fails none are applied.',
          items: {
            type: 'object',
            properties: editProps,
            required: ['old_string', 'new_string'],
          },
        },
        patch: { type: 'string', description: 'Diff mode: a unified diff (--- a/f, +++ b/f, @@ hunks) or a "*** Begin Patch" block. May touch several files; all-or-nothing.' },
      },
      required: [],
    })
    .onNativeExecute(ctx => tools.patch(ctx))
    .build();

  const editFile = defineSkill(
    'edit_file',
    'Replace old_string with new_string in a file (alias of patch; same fuzzy matching and result).',
  )
    .userInvocable(false)
    .safety({ localWrite: true })
    .inputSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit, relative to the workspace.' },
        ...editProps,
      },
      required: ['path', 'old_string', 'new_string'],
    })
    .onNativeExecute(ctx => tools.patch({ ...ctx, args: { path: ctx.args.path, old_string: ctx.args.old_string, new_string: ctx.args.new_string, replace_all: ctx.args.replace_all } }))
    .build();

  const undo = defineSkill(
    'undo',
    "Undo the agent's file changes. With no arguments restores the latest checkpoint from this session (one is taken before the first edit of each file per turn); checkpoint_id restores a specific one; list:true shows recent checkpoints. Files changed since by someone else are left alone.",
  )
    .userInvocable(false)
    .safety({ localWrite: true })
    .inputSchema({
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'Checkpoint to restore (from list). Default: the latest from this session.' },
        list: { type: 'boolean', description: 'List recent checkpoints instead of restoring.' },
      },
      required: [],
    })
    .onNativeExecute(ctx => tools.undo(ctx))
    .build();

  return [readFile.skill, writeFile.skill, patch.skill, editFile.skill, undo.skill];
}

/**
 * Register the native file tools on a skill registry. Returns the FileTools
 * instance so callers can reach its state, e.g. `tools.store.resetReads(sessionId)`
 * after context compaction.
 */
export function registerFileTools(registry: { registerSkill(skill: Skill): void }, deps: FileToolsDeps = {}): FileTools {
  const tools = new FileTools(deps);
  for (const skill of buildFileToolSkills(tools)) registry.registerSkill(skill);
  return tools;
}
