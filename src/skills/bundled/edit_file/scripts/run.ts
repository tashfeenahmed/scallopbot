/**
 * Edit File Skill Execution Script
 *
 * Makes targeted edits by finding and replacing text.
 */

import * as fs from 'fs';
import * as path from 'path';

interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
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
  const resolved = path.resolve(workspaceRoot, filePath);

  // Check if path stays within workspace
  if (!resolved.startsWith(workspaceRoot)) {
    return { valid: false, resolved, reason: 'Path escapes workspace' };
  }

  // Block system directories
  const blocked = ['/etc', '/boot', '/sys', '/proc', '/dev', '/bin', '/sbin', '/usr'];
  for (const dir of blocked) {
    if (resolved.startsWith(dir)) {
      return { valid: false, resolved, reason: `Cannot edit system file: ${dir}` };
    }
  }

  // Check symlinks
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realBase = fs.realpathSync(workspaceRoot);
      if (!realPath.startsWith(realBase)) {
        return { valid: false, resolved, reason: 'Symlink escapes workspace' };
      }
    }
  } catch {
    // File doesn't exist
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
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
    return;
  }

  let args: EditFileArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  if (!args.path) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: path',
      exitCode: 1,
    });
    return;
  }

  if (args.old_string === undefined || args.old_string === null) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: old_string',
      exitCode: 1,
    });
    return;
  }

  if (args.new_string === undefined || args.new_string === null) {
    outputResult({
      success: false,
      output: '',
      error: 'Missing required parameter: new_string',
      exitCode: 1,
    });
    return;
  }

  // Validate path
  const validation = validatePath(args.path, workspaceRoot);
  if (!validation.valid) {
    outputResult({
      success: false,
      output: '',
      error: `Path blocked: ${validation.reason}`,
      exitCode: 1,
    });
    return;
  }

  const filePath = validation.resolved;

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    outputResult({
      success: false,
      output: '',
      error: `File not found: ${args.path}. Use write_file to create new files.`,
      exitCode: 1,
    });
    return;
  }

  // Check if it's a directory
  if (fs.statSync(filePath).isDirectory()) {
    outputResult({
      success: false,
      output: '',
      error: `Path is a directory: ${args.path}`,
      exitCode: 1,
    });
    return;
  }

  // Read file
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
    return;
  }

  // Check if old_string exists
  if (!content.includes(args.old_string)) {
    // Provide helpful error with preview
    const preview = args.old_string.length > 50
      ? args.old_string.substring(0, 50) + '...'
      : args.old_string;
    outputResult({
      success: false,
      output: '',
      error: `Text not found in file: "${preview}". Make sure old_string matches exactly (including whitespace).`,
      exitCode: 1,
    });
    return;
  }

  // Check for ambiguous matches (multiple occurrences with single replace)
  const replaceAll = args.replace_all === true;
  if (!replaceAll) {
    const regex = new RegExp(escapeRegExp(args.old_string), 'g');
    const matches = content.match(regex);
    if (matches && matches.length > 1) {
      outputResult({
        success: false,
        output: '',
        error: `Found ${matches.length} occurrences of the text. Use replace_all: true to replace all, or provide more context to make old_string unique.`,
        exitCode: 1,
      });
      return;
    }
  }

  // Perform replacement
  let newContent: string;
  let replacements: number;

  if (replaceAll) {
    const regex = new RegExp(escapeRegExp(args.old_string), 'g');
    const matches = content.match(regex);
    replacements = matches ? matches.length : 0;
    newContent = content.replace(regex, args.new_string);
  } else {
    newContent = content.replace(args.old_string, args.new_string);
    replacements = 1;
  }

  // Check if anything changed
  if (newContent === content) {
    outputResult({
      success: false,
      output: '',
      error: 'No changes made. old_string and new_string may be identical.',
      exitCode: 1,
    });
    return;
  }

  // Write file
  try {
    fs.writeFileSync(filePath, newContent, 'utf-8');

    const replacementText = replacements === 1 ? '1 replacement' : `${replacements} replacements`;
    outputResult({
      success: true,
      output: `Edited file: ${args.path} (${replacementText} made)`,
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
