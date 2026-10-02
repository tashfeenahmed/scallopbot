import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { FileTools } from './tools.js';
import { CheckpointStore, checkpointBeforeDestructive } from './checkpoints.js';
import { registerFileTools, FILE_TOOL_NAMES } from './index.js';
import { SkillRegistry } from '../../skills/registry.js';
import { SkillLoader } from '../../skills/loader.js';
import type { Skill } from '../../skills/types.js';

let ws: string;
let home: string;
let tools: FileTools;
let now: number;

function mk(rel: string, content: string | Buffer): string {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
const readText = (rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8');

function ctx(args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { args, workspace: ws, sessionId: 's1', ...extra };
}

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ws-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-home-'));
  now = 1_000_000;
  tools = new FileTools({
    checkpointStore: new CheckpointStore(home),
    allowedRoots: w => [w],
    now: () => now,
  });
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe('read_file', () => {
  it('returns LINE|CONTENT with a header', async () => {
    mk('a.txt', 'alpha\nbeta\n');
    const r = await tools.read(ctx({ path: 'a.txt' }));
    expect(r.success).toBe(true);
    expect(r.output).toBe('a.txt — lines 1-2 of 2\n1|alpha\n2|beta');
  });

  it('pages at 2,000 lines and says which offset comes next', async () => {
    mk('big.txt', Array.from({ length: 2500 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
    const r = await tools.read(ctx({ path: 'big.txt' }));
    expect(r.output.startsWith('big.txt — lines 1-2000 of 2500')).toBe(true);
    expect(r.output).toContain('2000|row 2000');
    expect(r.output).toContain('[500 more lines — next page: read_file {"path":"big.txt","offset":2001}]');
    const p2 = await tools.read(ctx({ path: 'big.txt', offset: 2001 }));
    expect(p2.output.startsWith('big.txt — lines 2001-2500 of 2500')).toBe(true);
    expect(p2.output).not.toContain('more lines');
  });

  it('returns "unchanged" for an identical re-read, including a sub-range already seen', async () => {
    mk('a.txt', 'one\ntwo\nthree\n');
    await tools.read(ctx({ path: 'a.txt' }));
    const again = await tools.read(ctx({ path: 'a.txt' }));
    expect(JSON.parse(again.output)).toMatchObject({ status: 'unchanged' });
    const sub = await tools.read(ctx({ path: 'a.txt', offset: 2, limit: 1 }));
    expect(JSON.parse(sub.output).status).toBe('unchanged');
    // Other sessions have their own state.
    const other = await tools.read(ctx({ path: 'a.txt' }, { sessionId: 's2' }));
    expect(other.output).toContain('1|one');
  });

  it('re-reads when the file changed on disk and says so', async () => {
    mk('a.txt', 'one\n');
    await tools.read(ctx({ path: 'a.txt' }));
    mk('a.txt', 'uno\n');
    const r = await tools.read(ctx({ path: 'a.txt' }));
    expect(r.output).toContain('changed on disk since your last read');
    expect(r.output).toContain('1|uno');
  });

  it('suggests similar filenames when the path is wrong', async () => {
    mk('src/helpers.ts', 'x');
    mk('src/other/helper.js', 'x');
    const r = await tools.read(ctx({ path: 'src/helper.ts' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Did you mean: /);
    expect(r.error).toContain('src/helpers.ts');
    expect(r.error).toContain('src/other/helper.js');
  });

  it('handles directories, empty files, offsets past the end', async () => {
    mk('d/x.txt', 'x\n');
    mk('empty.txt', '');
    expect((await tools.read(ctx({ path: 'd' }))).error).toMatch(/is a directory/);
    expect((await tools.read(ctx({ path: 'empty.txt' }))).output).toMatch(/empty \(0 lines\)/);
    expect((await tools.read(ctx({ path: 'd/x.txt', offset: 9 }))).error).toMatch(/past the end — d\/x.txt has 1 line/);
  });

  it('gives a short notice for images and binary files', async () => {
    mk('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    mk('blob.bin', Buffer.from([1, 2, 0, 4]));
    expect((await tools.read(ctx({ path: 'pic.png' }))).output).toMatch(/^Image file: pic.png \(PNG/);
    expect((await tools.read(ctx({ path: 'blob.bin' }))).output).toMatch(/^Binary file: blob.bin/);
  });

  it('shows CRLF files without carriage returns', async () => {
    mk('w.txt', 'a\r\nb\r\n');
    expect((await tools.read(ctx({ path: 'w.txt' }))).output).toBe('w.txt — lines 1-2 of 2\n1|a\n2|b');
  });

  it('refuses paths outside the allowed roots', async () => {
    const r = await tools.read(ctx({ path: '/etc/hosts' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside the workspace/);
    const r2 = await tools.read(ctx({ path: '../escape.txt' }));
    expect(r2.error).toMatch(/outside the workspace/);
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe('write_file', () => {
  it('creates files and parent directories, verified', async () => {
    const r = await tools.write(ctx({ path: 'deep/dir/new.txt', content: 'hi\nthere\n' }));
    expect(r.success).toBe(true);
    const head = JSON.parse(r.output.split('\n')[0]);
    expect(head).toMatchObject({ ok: true, path: 'deep/dir/new.txt', bytes: 9, lines: 2, created: true, verified: true });
    expect(head.note).toMatch(/no need to re-read/);
    expect(readText('deep/dir/new.txt')).toBe('hi\nthere\n');
  });

  it('hints (once) before overwriting a file that was not read; the identical second call proceeds', async () => {
    mk('a.txt', 'original\n');
    const first = await tools.write(ctx({ path: 'a.txt', content: 'replaced\n' }));
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/NOT written \(hint, not a block\).*haven't read it/);
    expect(first.error).toMatch(/call write_file again with the same arguments/);
    expect(readText('a.txt')).toBe('original\n');
    const second = await tools.write(ctx({ path: 'a.txt', content: 'replaced\n' }));
    expect(second.success).toBe(true);
    expect(readText('a.txt')).toBe('replaced\n');
  });

  it('overwrite:true proceeds in one step; a read first needs no hint', async () => {
    mk('a.txt', 'v1\n');
    expect((await tools.write(ctx({ path: 'a.txt', content: 'v2\n', overwrite: true }))).success).toBe(true);
    mk('b.txt', 'v1\n');
    await tools.read(ctx({ path: 'b.txt' }));
    expect((await tools.write(ctx({ path: 'b.txt', content: 'v2\n' }))).success).toBe(true);
  });

  it('hints when the file changed on disk since the last read', async () => {
    mk('a.txt', 'v1\n');
    await tools.read(ctx({ path: 'a.txt' }));
    mk('a.txt', 'user edit\n');
    const r = await tools.write(ctx({ path: 'a.txt', content: 'agent\n' }));
    expect(r.error).toMatch(/changed on disk since you last read/);
  });

  it('a different second call is hinted again (not the same arguments)', async () => {
    mk('a.txt', 'v1\n');
    await tools.write(ctx({ path: 'a.txt', content: 'x\n' }));
    const r = await tools.write(ctx({ path: 'a.txt', content: 'y\n' }));
    expect(r.success).toBe(false);
  });

  it('writing identical content is a no-op success', async () => {
    mk('a.txt', 'same\n');
    const r = await tools.write(ctx({ path: 'a.txt', content: 'same\n' }));
    expect(JSON.parse(r.output)).toMatchObject({ ok: true, changed: false });
  });
});

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

describe('patch (string mode)', () => {
  it('applies an exact edit and returns strategy, diff and verification', async () => {
    mk('a.ts', 'const a = 1;\nconst b = 2;\n');
    const r = await tools.patch(ctx({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 3;' }));
    expect(r.success).toBe(true);
    const head = JSON.parse(r.output.split('\n')[0]);
    expect(head).toMatchObject({ ok: true, match: 'exact', replacements: 1, at_lines: [1], verified: true });
    expect(r.output).toContain('diff:\n@@');
    expect(r.output).toContain('-const a = 1;');
    expect(r.output).toContain('+const a = 3;');
    expect(readText('a.ts')).toBe('const a = 3;\nconst b = 2;\n');
  });

  it('preserves CRLF line endings', async () => {
    mk('w.txt', 'one\r\ntwo\r\nthree\r\n');
    const r = await tools.patch(ctx({ path: 'w.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE\nFOUR' }));
    expect(r.success).toBe(true);
    expect(readText('w.txt')).toBe('one\r\nTWO\r\nTHREE\r\nFOUR\r\n');
  });

  it('accepts CRLF in old_string for CRLF files', async () => {
    mk('w.txt', 'one\r\ntwo\r\n');
    await tools.patch(ctx({ path: 'w.txt', old_string: 'one\r\ntwo', new_string: 'uno\r\ndos' }));
    expect(readText('w.txt')).toBe('uno\r\ndos\r\n');
  });

  it('preserves a missing trailing newline and a BOM', async () => {
    mk('n.txt', 'a\nb');
    await tools.patch(ctx({ path: 'n.txt', old_string: 'b', new_string: 'c' }));
    expect(readText('n.txt')).toBe('a\nc');
    mk('bom.txt', '\uFEFFkey=1\n');
    await tools.patch(ctx({ path: 'bom.txt', old_string: 'key=1', new_string: 'key=2' }));
    expect(fs.readFileSync(path.join(ws, 'bom.txt'), 'utf8')).toBe('\uFEFFkey=2\n');
  });

  it('re-indents new_string for an indentation-flexible match and says it was fuzzy', async () => {
    mk('i.py', 'class A:\n    def f(self):\n        return 1\n');
    const r = await tools.patch(ctx({ path: 'i.py', old_string: 'def f(self):\n    return 1', new_string: 'def f(self):\n    return 2' }));
    expect(JSON.parse(r.output.split('\n')[0]).match).toBe('indentation-flexible');
    expect(r.output).toMatch(/wasn't byte-exact/);
    expect(readText('i.py')).toBe('class A:\n    def f(self):\n        return 2\n');
  });

  it('handles unicode files', async () => {
    mk('u.md', '# Café “menu”\n- crème brûlée — £5\n');
    const r = await tools.patch(ctx({ path: 'u.md', old_string: '- crème brûlée - £5', new_string: '- crème brûlée - £6' }));
    expect(r.success).toBe(true);
    expect(readText('u.md')).toBe('# Café “menu”\n- crème brûlée - £6\n');
  });

  it('reports "already applied" without touching the file', async () => {
    mk('a.ts', 'const timeout = 5000;\n');
    const st = fs.statSync(path.join(ws, 'a.ts')).mtimeMs;
    const r = await tools.patch(ctx({ path: 'a.ts', old_string: 'const timeout = 1000;', new_string: 'const timeout = 5000;' }));
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ ok: true, changed: false, already_applied: true });
    expect(fs.statSync(path.join(ws, 'a.ts')).mtimeMs).toBe(st);
  });

  it('lists every match with context when old_string is ambiguous', async () => {
    mk('a.ts', 'x();\nfoo();\ny();\nfoo();\nz();\n');
    const r = await tools.patch(ctx({ path: 'a.ts', old_string: 'foo();', new_string: 'bar();' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/matches 2 places in a.ts \(exact match\), at lines 2, 4/);
    expect(r.error).toContain('--- match at line 4:\n2|foo();\n3|y();\n4|foo();\n5|z();');
    expect(r.error).toMatch(/replace_all: true/);
  });

  it('shows the closest region when nothing matches', async () => {
    mk('a.ts', 'import x from "x";\n\nexport function sum(a: number, b: number) {\n  return a + b;\n}\n');
    const r = await tools.patch(ctx({ path: 'a.ts', old_string: 'export function add(a: number, b: number) {\n  return a - b + 0;\n}\n// trailing', new_string: 'x' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/old_string not found in a.ts\. Closest region: lines 3-6 \(\d+% similar\)/);
    expect(r.error).toContain('3|export function sum');
    expect(r.error).toMatch(/read_file offset 3, limit 4/);
  });

  it('multi-edit is atomic: a failing edit leaves the file untouched', async () => {
    mk('m.ts', 'a = 1\nb = 2\nc = 3\n');
    const r = await tools.patch(ctx({ path: 'm.ts', edits: [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'zzz = 9', new_string: 'q' },
    ] }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Edit 2 of 2 failed — no edits were applied \(all-or-nothing\)/);
    expect(readText('m.ts')).toBe('a = 1\nb = 2\nc = 3\n');
  });

  it('multi-edit applies edits in order', async () => {
    mk('m.ts', 'a = 1\nb = 2\n');
    const r = await tools.patch(ctx({ path: 'm.ts', edits: [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'a = 10\nb = 2', new_string: 'a = 10\nb = 20' },
    ] }));
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output.split('\n')[0]).replacements).toBe(2);
    expect(readText('m.ts')).toBe('a = 10\nb = 20\n');
  });

  it('accepts edits passed as a JSON string', async () => {
    mk('m.ts', 'a = 1\n');
    const r = await tools.patch(ctx({ path: 'm.ts', edits: JSON.stringify([{ old_string: 'a = 1', new_string: 'a = 2' }]) }));
    expect(r.success).toBe(true);
    expect(readText('m.ts')).toBe('a = 2\n');
  });

  it('creates a missing file from an empty old_string, and suggests names otherwise', async () => {
    const r = await tools.patch(ctx({ path: 'new/file.txt', old_string: '', new_string: 'hello\n' }));
    expect(r.success).toBe(true);
    expect(readText('new/file.txt')).toBe('hello\n');
    const miss = await tools.patch(ctx({ path: 'new/fille.txt', old_string: 'a', new_string: 'b' }));
    expect(miss.error).toMatch(/Did you mean: new\/file.txt/);
  });
});

describe('patch (diff mode)', () => {
  it('applies a multi-file unified diff (update, add, delete)', async () => {
    mk('src/a.ts', 'one\ntwo\nthree\n');
    mk('src/old.ts', 'bye\n');
    const patch = [
      '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three',
      '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+hello', '+world',
      '--- a/src/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    ].join('\n');
    const r = await tools.patch(ctx({ patch }));
    expect(r.success).toBe(true);
    expect(readText('src/a.ts')).toBe('one\nTWO\nthree\n');
    expect(readText('src/new.ts')).toBe('hello\nworld\n');
    expect(fs.existsSync(path.join(ws, 'src/old.ts'))).toBe(false);
    const head = JSON.parse(r.output.split('\n')[0]);
    expect(head.files.map((f: { action: string }) => f.action)).toEqual(['updated', 'created', 'deleted']);
    expect(r.output).toContain('diff src/a.ts:');
  });

  it('is all-or-nothing across files', async () => {
    mk('a.txt', 'a\n');
    mk('b.txt', 'b\n');
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+A\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-nope\n+B\n';
    const r = await tools.patch(ctx({ patch }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/File 2 of 2 \(b.txt\), hunk 1 of 1 failed — no files were changed/);
    expect(readText('a.txt')).toBe('a\n');
  });

  it('tolerates stale line numbers and whitespace drift in hunks', async () => {
    mk('c.py', 'import os\n\n\ndef main():\n    print("hi")   \n    return 0\n');
    const patch = '--- a/c.py\n+++ b/c.py\n@@ -1,3 +1,3 @@\n def main():\n-    print("hi")\n+    print("hello")\n     return 0\n';
    const r = await tools.patch(ctx({ patch }));
    expect(r.success).toBe(true);
    expect(readText('c.py')).toBe('import os\n\n\ndef main():\n    print("hello")\n    return 0\n');
  });

  it('applies a Codex *** Begin Patch block with a move', async () => {
    mk('src/a.py', 'a = 1\nb = 2\n');
    const patch = '*** Begin Patch\n*** Update File: src/a.py\n*** Move to: src/b.py\n@@\n-a = 1\n+a = 2\n b = 2\n*** End Patch\n';
    const r = await tools.patch(ctx({ patch }));
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(ws, 'src/a.py'))).toBe(false);
    expect(readText('src/b.py')).toBe('a = 2\nb = 2\n');
  });

  it('reports a diff that is already applied', async () => {
    mk('a.txt', 'const answer = 42;\n');
    const r = await tools.patch(ctx({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-const answer = 41;\n+const answer = 42;\n' }));
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ changed: false });
  });

  it('preserves CRLF in diff mode', async () => {
    mk('w.txt', 'x\r\ny\r\n');
    await tools.patch(ctx({ patch: '--- a/w.txt\n+++ b/w.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n' }));
    expect(readText('w.txt')).toBe('x\r\nz\r\n');
  });
});

// ---------------------------------------------------------------------------
// Lint delta
// ---------------------------------------------------------------------------

describe('lint delta', () => {
  it('reports only new problems (JSON)', async () => {
    mk('c.json', '{"a": 1}\n');
    const broke = await tools.patch(ctx({ path: 'c.json', old_string: '"a": 1', new_string: '"a": 1,' }));
    expect(broke.output).toMatch(/lint: 1 new problem\(s\) from this edit \(json\)/);
    const still = await tools.patch(ctx({ path: 'c.json', old_string: '{"a"', new_string: '{"b"' }));
    expect(still.output).toMatch(/lint: no new problems \(json; 1 pre-existing/);
    const fixed = await tools.patch(ctx({ path: 'c.json', old_string: '1,', new_string: '1' }));
    expect(fixed.output).toMatch(/lint: clean \(json; fixed 1\)/);
  });

  it('runs node --check for JavaScript', async () => {
    mk('s.js', 'const a = 1;\n');
    const ok = await tools.patch(ctx({ path: 's.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }));
    expect(ok.output).toMatch(/lint: clean \(node --check\)/);
    const bad = await tools.patch(ctx({ path: 's.js', old_string: 'const a = 2;', new_string: 'const a = (2;' }));
    expect(bad.output).toMatch(/lint: 1 new problem\(s\).*\n\s+L1: SyntaxError/);
  });

  it('runs bash -n for shell scripts', async () => {
    const r = await tools.write(ctx({ path: 'x.sh', content: 'if true; then\n  echo hi\n' }));
    expect(r.output).toMatch(/lint: 1 new problem/);
  });

  it('runs tsc for TypeScript when a tsconfig and a local typescript exist', async () => {
    const require = createRequire(import.meta.url);
    const tsDir = path.dirname(require.resolve('typescript/package.json'));
    mk('proj/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true, types: [] }, include: ['src'] }));
    fs.mkdirSync(path.join(ws, 'proj/node_modules/.bin'), { recursive: true });
    fs.symlinkSync(path.join(tsDir, 'bin', 'tsc'), path.join(ws, 'proj/node_modules/.bin/tsc'));
    mk('proj/src/other.ts', 'export const unrelated: number = "x";\n');
    mk('proj/src/m.ts', 'export const n: number = 1;\n');
    const r = await tools.patch(ctx({ path: 'proj/src/m.ts', old_string: 'export const n: number = 1;', new_string: 'export const n: number = "one";' }));
    expect(r.output).toMatch(/lint: 1 new problem\(s\) from this edit \(tsc\)/);
    expect(r.output).toMatch(/L1: TS2322/);
    expect(r.output).not.toContain('unrelated');
  }, 60_000);

  it('skips files with no checker', async () => {
    mk('notes.md', 'a\n');
    const r = await tools.patch(ctx({ path: 'notes.md', old_string: 'a', new_string: 'b' }));
    expect(r.output).not.toContain('lint:');
  });
});

// ---------------------------------------------------------------------------
// Checkpoints and undo
// ---------------------------------------------------------------------------

describe('checkpoints and undo', () => {
  it('undo restores files the agent changed and removes files it created', async () => {
    mk('a.txt', 'original\n');
    await tools.read(ctx({ path: 'a.txt' }));
    await tools.patch(ctx({ path: 'a.txt', old_string: 'original', new_string: 'edited' }));
    await tools.patch(ctx({ path: 'a.txt', old_string: 'edited', new_string: 'edited twice' }));
    await tools.write(ctx({ path: 'b/new.txt', content: 'brand new\n' }));
    expect(readText('a.txt')).toBe('edited twice\n');

    const r = await tools.undo(ctx({}));
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/Restored: a.txt/);
    expect(r.output).toMatch(/Removed files the agent had created: b\/new.txt/);
    expect(readText('a.txt')).toBe('original\n');
    expect(fs.existsSync(path.join(ws, 'b/new.txt'))).toBe(false);
  });

  it('leaves files alone when the user changed them after the agent', async () => {
    mk('a.txt', 'v1\n');
    mk('b.txt', 'w1\n');
    await tools.patch(ctx({ path: 'a.txt', old_string: 'v1', new_string: 'v2' }));
    await tools.patch(ctx({ path: 'b.txt', old_string: 'w1', new_string: 'w2' }));
    mk('b.txt', 'user changed this\n');
    const r = await tools.undo(ctx({}));
    expect(r.output).toMatch(/Restored: a.txt/);
    expect(r.output).toMatch(/Skipped \(left as they are\): b.txt — changed since the agent wrote it/);
    expect(readText('a.txt')).toBe('v1\n');
    expect(readText('b.txt')).toBe('user changed this\n');
  });

  it('takes one checkpoint per turn and lists them', async () => {
    mk('a.txt', '1\n');
    await tools.patch(ctx({ path: 'a.txt', old_string: '1', new_string: '2' }, { turnStartedAt: 100 }));
    await tools.patch(ctx({ path: 'a.txt', old_string: '2', new_string: '3' }, { turnStartedAt: 100 }));
    await tools.patch(ctx({ path: 'a.txt', old_string: '3', new_string: '4' }, { turnStartedAt: 200 }));
    const list = await tools.undo(ctx({ list: true }));
    const ids = [...list.output.matchAll(/^(cp-\w+)/gm)].map(m => m[1]);
    expect(ids).toHaveLength(2);
    expect(list.output).toContain('(this session)');

    // Undo newest turn → 3, then the older one → 1.
    await tools.undo(ctx({}));
    expect(readText('a.txt')).toBe('3\n');
    await tools.undo(ctx({}));
    expect(readText('a.txt')).toBe('1\n');
    const done = await tools.undo(ctx({}));
    expect(done.error).toMatch(/already been undone/);
  });

  it('without a turn id, writes close together share a checkpoint and a long gap starts a new one', async () => {
    mk('a.txt', '1\n');
    await tools.patch(ctx({ path: 'a.txt', old_string: '1', new_string: '2' }));
    now += 10_000;
    await tools.patch(ctx({ path: 'a.txt', old_string: '2', new_string: '3' }));
    now += 10 * 60_000;
    await tools.patch(ctx({ path: 'a.txt', old_string: '3', new_string: '4' }));
    const list = await tools.undo(ctx({ list: true }));
    expect([...list.output.matchAll(/^cp-/gm)]).toHaveLength(2);
  });

  it('undo by checkpoint_id and unknown ids', async () => {
    mk('a.txt', '1\n');
    await tools.patch(ctx({ path: 'a.txt', old_string: '1', new_string: '2' }));
    const list = await tools.undo(ctx({ list: true }));
    const id = /^(cp-\w+)/m.exec(list.output)![1];
    expect((await tools.undo(ctx({ checkpoint_id: 'cp-nope' }))).error).toMatch(/No checkpoint "cp-nope"/);
    expect((await tools.undo(ctx({ checkpoint_id: id }))).success).toBe(true);
    expect(readText('a.txt')).toBe('1\n');
  });

  it('never touches the workspace .git', async () => {
    mk('.git/HEAD', 'ref: refs/heads/main\n');
    mk('a.txt', '1\n');
    await tools.patch(ctx({ path: 'a.txt', old_string: '1', new_string: '2' }));
    expect(fs.readdirSync(path.join(ws, '.git'))).toEqual(['HEAD']);
    expect(fs.existsSync(path.join(home, 'checkpoints'))).toBe(true);
  });

  it('checkpointBeforeDestructive snapshots a directory for the shell tool', async () => {
    const store = new CheckpointStore(home);
    mk('dist/a.js', 'a');
    mk('dist/sub/b.js', 'b');
    const cp = await checkpointBeforeDestructive(ws, ['dist'], { store, sessionId: 's1', reason: 'bash: rm -rf dist' });
    expect(cp).not.toBeNull();
    expect(cp!.files.sort()).toEqual(['dist/a.js', 'dist/sub/b.js']);
    fs.rmSync(path.join(ws, 'dist'), { recursive: true });
    await cp!.finalize();
    const r = await store.restore(ws, { id: cp!.id });
    expect('error' in r).toBe(false);
    expect(readText('dist/sub/b.js')).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Project-context hints
// ---------------------------------------------------------------------------

describe('subdirectory hints', () => {
  it('appends AGENTS.md / CLAUDE.md the first time a directory is touched', async () => {
    mk('AGENTS.md', 'root rules (already in the system prompt)');
    mk('pkg/AGENTS.md', 'pkg rules: use tabs');
    mk('pkg/lib/CLAUDE.md', 'lib rules: no default exports');
    mk('pkg/lib/x.ts', 'x\n');
    mk('pkg/lib/y.ts', 'y\n');
    const r = await tools.read(ctx({ path: 'pkg/lib/x.ts' }));
    expect(r.output).toContain('[project-context: pkg/AGENTS.md]\npkg rules: use tabs');
    expect(r.output).toContain('[project-context: pkg/lib/CLAUDE.md]\nlib rules: no default exports');
    expect(r.output).not.toContain('root rules');
    const again = await tools.read(ctx({ path: 'pkg/lib/y.ts' }));
    expect(again.output).not.toContain('project-context');
    const w = await tools.write(ctx({ path: 'pkg/z.ts', content: 'z\n' }));
    expect(w.output).not.toContain('project-context');
  });

  it('caps a hint at 4k characters', async () => {
    mk('big/AGENTS.md', 'x'.repeat(10_000));
    mk('big/f.txt', 'f\n');
    const r = await tools.read(ctx({ path: 'big/f.txt' }));
    expect(r.output).toMatch(/\(truncated; read_file big\/AGENTS.md for the rest\)/);
    expect(r.output.length).toBeLessThan(4300);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerFileTools', () => {
  it('registers native tools that replace same-named disk skills', async () => {
    const registry = new SkillRegistry(new SkillLoader({ workspaceDir: ws }));
    const diskReadFile: Skill = {
      name: 'read_file', description: 'old subprocess read_file', path: '/x/SKILL.md', source: 'bundled',
      frontmatter: { name: 'read_file', description: 'old' }, content: '', available: true, hasScripts: true,
    };
    registry.registerSkill(diskReadFile);
    const ft = registerFileTools(registry, { checkpointStore: new CheckpointStore(home), allowedRoots: w => [w] });
    const names = registry.getToolDefinitions().map(t => t.name);
    for (const n of FILE_TOOL_NAMES) expect(names).toContain(n);
    expect(names.filter(n => n === 'read_file')).toHaveLength(1);
    const skill = registry.getSkill('read_file')!;
    expect(skill.source).toBe('sdk');
    mk('q.txt', 'q\n');
    const res = await skill.handler!({ args: { path: 'q.txt' }, workspace: ws, sessionId: 'z' });
    expect(res.output).toContain('1|q');
    expect(ft.store.size).toBe(1);

    // edit_file is an alias with the old schema.
    const edit = registry.getSkill('edit_file')!;
    expect(edit.frontmatter.inputSchema!.required).toEqual(['path', 'old_string', 'new_string']);
    const er = await edit.handler!({ args: { path: 'q.txt', old_string: 'q', new_string: 'r' }, workspace: ws, sessionId: 'z' });
    expect(er.success).toBe(true);
    expect(readText('q.txt')).toBe('r\n');
  });
});

describe('write_file append', () => {
  it('appends to an unread file without the overwrite hint', async () => {
    const os = await import('os');
    const fsp = await import('fs/promises');
    const pathMod = await import('path');
    const { FileTools } = await import('./tools.js');
    const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'ft-append-'));
    try {
      await fsp.writeFile(pathMod.join(dir, 'log.csv'), 'a,1\n');
      const tools = new FileTools({ allowedRoots: (w: string) => [w], checkpoints: false, lint: false });
      const result = await tools.write({ args: { path: 'log.csv', content: 'b,2\n', append: true }, workspace: dir, sessionId: 's' });
      expect(result.success).toBe(true);
      expect(await fsp.readFile(pathMod.join(dir, 'log.csv'), 'utf8')).toBe('a,1\nb,2\n');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
