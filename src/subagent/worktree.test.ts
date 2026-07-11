import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubAgentWorktree, finalizeSubAgentWorktree } from './worktree.js';

const roots: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('isolated coding worktrees', () => {
  it('captures committed and uncommitted child changes as a conflict-checked patch', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scallop-worktree-'));
    roots.push(root);
    git(root, 'init');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(path.join(root, 'a.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');

    const worktree = await createSubAgentWorktree(root, 'test-run');
    writeFileSync(path.join(worktree.path, 'a.txt'), 'implemented\n');
    git(worktree.path, 'add', 'a.txt');
    git(worktree.path, 'commit', '-m', 'child commit');
    writeFileSync(path.join(worktree.path, 'b.txt'), 'new file\n');

    const result = await finalizeSubAgentWorktree(worktree, 'test-run');
    expect(result.conflicts).toEqual([]);
    expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect(result.artifacts[0]?.type).toBe('patch');
    expect(readFileSync(result.artifacts[0].value, 'utf8')).toContain('implemented');
    expect(existsSync(worktree.path)).toBe(false);
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('base\n');
  });
});
