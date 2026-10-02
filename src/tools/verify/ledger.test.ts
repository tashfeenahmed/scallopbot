import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLedger, detectVerifyCommands, isCodePath, recordEdit, recordShellResult,
  suggestVerifyCommands, verifyOnStopNudge,
} from './ledger.js';

describe('verification ledger', () => {
  let root: string;
  beforeEach(() => {
    clearLedger();
    root = mkdtempSync(join(tmpdir(), 'ledger-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('detects verify commands', () => {
    for (const cmd of [
      'npm test', 'pnpm test', 'yarn test', 'npx vitest run src/x.test.ts', 'vitest run', 'npx jest',
      'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test', 'npx tsc --noEmit', 'tsc -p .',
      'npx eslint src', 'ruff check .', 'make test', 'make check', 'npm run build', 'npm run lint', 'npm run typecheck',
    ]) {
      expect(detectVerifyCommands(cmd), cmd).toHaveLength(1);
    }
    expect(detectVerifyCommands('cd app && npm test')).toEqual(['npm test']);
    for (const cmd of ['ls', 'git status', 'npm install', 'echo test', 'cat tsconfig.json', 'make']) {
      expect(detectVerifyCommands(cmd), cmd).toEqual([]);
    }
  });

  it('only code paths count as edits', () => {
    expect(isCodePath('src/a.ts')).toBe(true);
    expect(isCodePath('main.py')).toBe(true);
    expect(isCodePath('package.json')).toBe(true);
    expect(isCodePath('README.md')).toBe(false);
    expect(isCodePath('notes.txt')).toBe(false);
  });

  it('no nudge without edits, or after a passing run that follows the edit', () => {
    expect(verifyOnStopNudge('s')).toBeNull();
    recordShellResult('s', 'npm test', 1);
    expect(verifyOnStopNudge('s')).toBeNull();
    recordEdit('s', '/p/src/a.ts');
    recordShellResult('s', 'npx vitest run', 0);
    expect(verifyOnStopNudge('s')).toBeNull();
  });

  it('nudges when code changed after the last passing run, naming the verify commands', () => {
    recordShellResult('s', 'npx vitest run', 0);
    recordEdit('s', '/p/src/a.ts');
    const nudge = verifyOnStopNudge('s');
    expect(nudge).toMatch(/^\[verify\] You edited code \(a\.ts\)/);
    expect(nudge).toContain('`npx vitest run`');
    expect(nudge!.split('\n')).toHaveLength(1);
  });

  it('a failing or masked run after the edit still nudges, and says so', () => {
    recordEdit('s', '/p/src/a.ts');
    recordShellResult('s', 'npm test', 1);
    expect(verifyOnStopNudge('s')).toMatch(/last run of `npm test` exited 1/);
    recordShellResult('s', 'npm test 2>&1 | tail -5', 0);
    expect(verifyOnStopNudge('s')).toMatch(/hid its exit code/);
    recordShellResult('s', 'set -o pipefail; npm test 2>&1 | tail -5', 0);
    expect(verifyOnStopNudge('s')).toBeNull();
  });

  it('edits of non-code files never nudge', () => {
    recordEdit('s', '/p/README.md');
    expect(verifyOnStopNudge('s')).toBeNull();
  });

  it('shell writes to code files count as edits', () => {
    recordShellResult('s', "sed -i 's/a/b/' src/x.ts", 0, root);
    expect(verifyOnStopNudge('s')).not.toBeNull();
    clearLedger();
    recordShellResult('s', "cat > lib/util.py <<'EOF'\nx=1\nEOF", 0, root);
    expect(verifyOnStopNudge('s')).not.toBeNull();
    clearLedger();
    recordShellResult('s', 'echo hi > out.log 2>&1', 0, root);
    expect(verifyOnStopNudge('s')).toBeNull();
  });

  it('suggests likely verify commands from package.json when none ran', () => {
    const pkg = join(root, 'app');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint src', build: 'tsc' } }));
    writeFileSync(join(pkg, 'tsconfig.json'), '{}');
    expect(suggestVerifyCommands(join(pkg, 'src'))).toEqual(['npx tsc --noEmit', 'npx vitest run', 'npm run lint', 'npm run build']);

    recordEdit('s', join(pkg, 'src', 'index.ts'));
    const nudge = verifyOnStopNudge('s');
    expect(nudge).toContain('`npx tsc --noEmit`');
    expect(nudge).toContain('`npx vitest run`');
  });

  it('falls back to marker files and a generic suggestion', () => {
    writeFileSync(join(root, 'pyproject.toml'), '');
    expect(suggestVerifyCommands(root)).toEqual(['pytest']);
    const empty = mkdtempSync(join(tmpdir(), 'ledger-empty-'));
    try {
      recordEdit('g', join(empty, 'x.ts'));
      expect(verifyOnStopNudge('g')).toMatch(/the project's tests or type check/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
