/**
 * Multi Edit Skill Execution Script
 *
 * Applies multiple text replacements atomically to a single file.
 * Validates all edits before writing — all or nothing.
 */

import * as fs from 'fs';
import * as path from 'path';

interface EditOp {
  old_string: string;
  new_string: string;
}

interface MultiEditArgs {
  path: string;
  edits: EditOp[];
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

function validatePath(filePath: string, workspaceRoot: string): { valid: boolean; resolved: string; reason?: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const allowedRoots = [
    workspaceRoot,
    path.join(homeDir, '.scallopbot'),
  ];

  const isAllowed = allowedRoots.some(root => resolved.startsWith(root));
  if (!isAllowed) {
    return { valid: false, resolved, reason: 'Path outside allowed directories' };
  }

  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realAllowed = allowedRoots.some(root => {
        try {
          const realRoot = fs.realpathSync(root);
          return realPath.startsWith(realRoot);
        } catch {
          return false;
        }
      });
      if (!realAllowed) {
        return { valid: false, resolved, reason: 'Symlink escapes allowed directories' };
      }
    }
  } catch {
    // pass
  }

  return { valid: true, resolved };
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;
  const workspaceRoot = process.env.SKILL_CWD || process.cwd();

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: MultiEditArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.path) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: path', exitCode: 1 });
    return;
  }

  if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
    outputResult({ success: false, output: '', error: 'Missing or empty edits array', exitCode: 1 });
    return;
  }

  // Validate each edit has required fields
  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i];
    if (edit.old_string === undefined || edit.old_string === null) {
      outputResult({ success: false, output: '', error: `Edit ${i + 1}: missing old_string`, exitCode: 1 });
      return;
    }
    if (edit.new_string === undefined || edit.new_string === null) {
      outputResult({ success: false, output: '', error: `Edit ${i + 1}: missing new_string`, exitCode: 1 });
      return;
    }
  }

  const validation = validatePath(args.path, workspaceRoot);
  if (!validation.valid) {
    outputResult({ success: false, output: '', error: `Path blocked: ${validation.reason}`, exitCode: 1 });
    return;
  }

  const filePath = validation.resolved;

  if (!fs.existsSync(filePath)) {
    outputResult({ success: false, output: '', error: `File not found: ${args.path}`, exitCode: 1 });
    return;
  }

  if (fs.statSync(filePath).isDirectory()) {
    outputResult({ success: false, output: '', error: `Path is a directory: ${args.path}`, exitCode: 1 });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    outputResult({ success: false, output: '', error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  // Simulate all edits on a copy to validate
  let simulated = content;
  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i];

    if (!simulated.includes(edit.old_string)) {
      const preview = edit.old_string.length > 50 ? edit.old_string.substring(0, 50) + '...' : edit.old_string;
      outputResult({
        success: false,
        output: '',
        error: `Edit ${i + 1}: text not found: "${preview}"`,
        exitCode: 1,
      });
      return;
    }

    // Check for ambiguous matches
    const regex = new RegExp(escapeRegExp(edit.old_string), 'g');
    const matches = simulated.match(regex);
    if (matches && matches.length > 1) {
      outputResult({
        success: false,
        output: '',
        error: `Edit ${i + 1}: found ${matches.length} occurrences. Provide more context to make old_string unique.`,
        exitCode: 1,
      });
      return;
    }

    // Apply edit to simulation
    simulated = simulated.replace(edit.old_string, edit.new_string);
  }

  // All edits validated — write the result
  try {
    fs.writeFileSync(filePath, simulated, 'utf-8');
    outputResult({
      success: true,
      output: `Applied ${args.edits.length} edit(s) to ${args.path}`,
      exitCode: 0,
    });
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }
}

main();
