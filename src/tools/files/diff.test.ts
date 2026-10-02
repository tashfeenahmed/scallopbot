import { describe, it, expect } from 'vitest';
import { compactDiff, parsePatch } from './diff.js';

describe('compactDiff', () => {
  it('returns empty for identical text', () => {
    expect(compactDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('shows a hunk with context', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    const after = before.replace('line10', 'LINE10');
    const d = compactDiff(before, after);
    expect(d).toContain('@@ -8,5 +8,5 @@');
    expect(d).toContain('-line10');
    expect(d).toContain('+LINE10');
    expect(d).toContain(' line9');
    expect(d).not.toContain('line1\n');
  });

  it('caps output lines', () => {
    const before = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `m${i}`).join('\n');
    const d = compactDiff(before, after, 40);
    expect(d.split('\n').length).toBe(41);
    expect(d).toMatch(/more diff lines\)$/);
  });
});

describe('parsePatch', () => {
  it('parses a multi-file unified diff', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 123..456 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    const files = parsePatch(patch);
    expect(files.map(f => [f.kind, f.path])).toEqual([['update', 'src/a.ts'], ['add', 'src/new.ts'], ['delete', 'src/old.ts']]);
    expect(files[0].hunks[0]).toEqual({ oldStart: 1, oldLines: ['one', 'two', 'three'], newLines: ['one', 'TWO', 'three'] });
    expect(files[1].hunks[0].newLines).toEqual(['hello', 'world']);
  });

  it('uses the default path when headers are missing', () => {
    const files = parsePatch('@@ -1,2 +1,2 @@\n a\n-b\n+c\n', 'x.txt');
    expect(files[0].path).toBe('x.txt');
    expect(files[0].hunks[0].oldLines).toEqual(['a', 'b']);
  });

  it('throws a helpful error when there is nothing to apply', () => {
    expect(() => parsePatch('just some text')).toThrow(/No hunks found/);
    expect(() => parsePatch('@@ -1 +1 @@\n-a\n+b')).toThrow(/no path was given/);
  });

  it('parses a Codex *** Begin Patch block', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.py',
      '@@ def main():',
      ' def main():',
      '-    print("hi")',
      '+    print("hello")',
      '*** Add File: src/util.py',
      '+X = 1',
      '*** Delete File: src/dead.py',
      '*** Update File: src/a.py',
      '*** Move to: src/b.py',
      '@@',
      '-a = 1',
      '+a = 2',
      '*** End Patch',
    ].join('\n');
    const files = parsePatch(patch);
    expect(files.map(f => f.kind)).toEqual(['update', 'add', 'delete', 'update']);
    expect(files[0].hunks[0]).toEqual({ oldLines: ['def main():', '    print("hi")'], newLines: ['def main():', '    print("hello")'] });
    expect(files[1].hunks[0].newLines).toEqual(['X = 1']);
    expect(files[3].moveTo).toBe('src/b.py');
  });
});
