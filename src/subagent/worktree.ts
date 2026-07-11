import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SubAgentArtifact } from './result.js';

const execFileAsync = promisify(execFile);

export interface SubAgentWorktree {
  repoRoot: string;
  path: string;
  baseHead: string;
}

export interface SubAgentWorktreeResult {
  changedFiles: string[];
  artifacts: SubAgentArtifact[];
  conflicts: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout.trimEnd();
}

export async function createSubAgentWorktree(workspace: string, runId: string): Promise<SubAgentWorktree> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Unsafe sub-agent run id');
  const repoRoot = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
  const baseHead = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const worktreeRoot = path.join(repoRoot, '.scallopbot', 'subagent-worktrees');
  const worktreePath = path.join(worktreeRoot, runId);
  await mkdir(worktreeRoot, { recursive: true });
  await rm(worktreePath, { recursive: true, force: true });
  await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseHead]);
  return { repoRoot, path: worktreePath, baseHead };
}

export async function finalizeSubAgentWorktree(
  worktree: SubAgentWorktree,
  runId: string,
): Promise<SubAgentWorktreeResult> {
  const status = await git(worktree.path, ['status', '--porcelain=v1']);
  const committedChanges = await git(worktree.path, ['diff', '--name-only', worktree.baseHead, 'HEAD', '--']);
  const changedFiles = [...status
    .split('\n')
    .map(line => line.slice(3).trim())
    .filter(Boolean)
    .map(file => file.includes(' -> ') ? file.split(' -> ').at(-1)! : file),
    ...committedChanges.split('\n').map(file => file.trim()).filter(Boolean)];

  if (changedFiles.length === 0) {
    await git(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
    return { changedFiles: [], artifacts: [], conflicts: [] };
  }

  // Intent-to-add makes untracked files appear in a binary-capable diff
  // without committing or creating a branch in the public repository.
  await git(worktree.path, ['add', '-N', '--', '.']);
  const patch = await git(worktree.path, ['diff', '--binary', '--no-ext-diff', worktree.baseHead, '--']);
  const resultDir = path.join(worktree.repoRoot, '.scallopbot', 'subagent-results');
  const patchPath = path.join(resultDir, `${runId}.patch`);
  await mkdir(resultDir, { recursive: true });
  const patchContent = patch.endsWith('\n') ? patch : `${patch}\n`;
  await writeFile(patchPath, patchContent, { encoding: 'utf8', mode: 0o600 });
  const digest = createHash('sha256').update(patchContent).digest('hex');
  const conflicts: string[] = [];
  try {
    await execFileAsync('git', ['apply', '--check', patchPath], {
      cwd: worktree.repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error
      ? String((error as Error & { stderr?: string }).stderr || error.message).trim()
      : error instanceof Error ? error.message : String(error);
    conflicts.push(`The generated patch no longer applies cleanly to the parent workspace${detail ? `: ${detail}` : '.'}`);
  }
  await git(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
  return {
    changedFiles: [...new Set(changedFiles)],
    artifacts: [{ type: 'patch', value: patchPath, digest }],
    conflicts,
  };
}
