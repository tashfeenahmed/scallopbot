import { describe, it, expect } from 'vitest';
import { findMatches, planEdit, STRATEGY_ORDER, levenshtein, similarity, reindent, closestRegion } from './fuzzy.js';

function applied(text: string, old_string: string, new_string: string, replace_all = false) {
  const plan = planEdit(text, { old_string, new_string, replace_all });
  if (plan.kind !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(plan)}`);
  return plan;
}

describe('fuzzy chain order', () => {
  it('has the nine strategies in the documented order', () => {
    expect(STRATEGY_ORDER).toEqual([
      'exact', 'line-trimmed', 'whitespace-normalized', 'indentation-flexible', 'escape-normalized',
      'trimmed-boundary', 'unicode-normalized', 'block-anchor', 'context-similarity',
    ]);
  });
});

describe('one test per strategy', () => {
  it('1. exact', () => {
    const plan = applied('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 10;');
    expect(plan.strategy).toBe('exact');
    expect(plan.text).toBe('const a = 10;\nconst b = 2;\n');
  });

  it('2. line-trimmed (trailing whitespace differs)', () => {
    const plan = applied('foo();   \nbar();\nbaz();\n', 'foo();\nbar();', 'foo2();\nbar();');
    expect(plan.strategy).toBe('line-trimmed');
    expect(plan.text).toBe('foo2();\nbar();\nbaz();\n');
  });

  it('3. whitespace-normalized (internal runs collapsed, indentation kept)', () => {
    const plan = applied('function f() {\n  const x  =   compute(a,  b);\n}\n', 'const x = compute(a, b);', 'const y = 2;');
    expect(plan.strategy).toBe('whitespace-normalized');
    expect(plan.text).toBe('function f() {\n  const y = 2;\n}\n');
  });

  it('4. indentation-flexible (block at a different depth, new_string re-indented)', () => {
    const file = 'class A {\n    method() {\n        return 1;\n    }\n}\n';
    const plan = applied(file, 'method() {\n    return 1;\n}', 'method() {\n    return 2;\n}');
    expect(plan.strategy).toBe('indentation-flexible');
    expect(plan.text).toBe('class A {\n    method() {\n        return 2;\n    }\n}\n');
  });

  it('5. escape-normalized (literal \\n in old_string)', () => {
    const plan = applied('line1\nline2\nline3\n', 'line1\\nline2', 'lineA\\nline2');
    expect(plan.strategy).toBe('escape-normalized');
    expect(plan.text).toBe('lineA\nline2\nline3\n');
  });

  it('5b. escape-normalized (file holds a literal \\n, model wrote a real newline)', () => {
    const plan = applied('msg = "a\\nb";\n', 'msg = "a\nb";', 'msg = "a\nc";');
    expect(plan.strategy).toBe('escape-normalized');
    expect(plan.text).toBe('msg = "a\\nc";\n');
  });

  it('6. trimmed-boundary (stray whitespace around old_string)', () => {
    const plan = applied('x = foo(1);\n', '  foo(1)  ', '  foo(2)  ');
    expect(plan.strategy).toBe('trimmed-boundary');
    expect(plan.text).toBe('x = foo(2);\n');
  });

  it('7. unicode-normalized (smart quotes, dashes, ellipsis)', () => {
    const plan = applied('const s = “hello” – world…;\nnext();\n', 'const s = "hello" - world...;', 'const s = "bye";');
    expect(plan.strategy).toBe('unicode-normalized');
    expect(plan.text).toBe('const s = "bye";\nnext();\n');
  });

  it('7b. unicode-normalized (NBSP)', () => {
    const plan = applied('price: 100 USD\n', 'price: 100 USD', 'price: 200 USD');
    expect(plan.strategy).toBe('unicode-normalized');
    expect(plan.text).toBe('price: 200 USD\n');
  });

  it('8. block-anchor (first/last lines anchor, middle similar)', () => {
    const file = [
      'function calc(a, b) {',
      '  const sum = a + b;',
      '  const difference = a - b;',
      '  return sum * difference;',
      '}',
      '',
    ].join('\n');
    const old = 'function calc(a, b) {\n  const sum = a + b;\n  const diference = a - b;\n  return sum * diference;\n}';
    const plan = applied(file, old, 'function calc(a, b) {\n  return a * b;\n}');
    expect(plan.strategy).toBe('block-anchor');
    expect(plan.text).toBe('function calc(a, b) {\n  return a * b;\n}\n');
  });

  it('9. context-similarity (no anchors, close enough overall)', () => {
    const file = [
      'let total = 0;',
      'for (const item of items) {',
      '  total += item.price * item.qty;',
      '}',
      'console.log(total);',
      '',
    ].join('\n');
    const old = 'for (const item of item) {\n  total += item.price * item.qty;\n }';
    const plan = applied(file, old, 'for (const item of items) total += item.price;');
    expect(plan.strategy).toBe('context-similarity');
    expect(plan.similarity).toBeGreaterThanOrEqual(0.8);
    expect(plan.text).toBe('let total = 0;\nfor (const item of items) total += item.price;\nconsole.log(total);\n');
  });
});

describe('planEdit outcomes', () => {
  it('reports ambiguity with the line number of every match', () => {
    const plan = planEdit('a();\nfoo();\nb();\nfoo();\n', { old_string: 'foo();', new_string: 'bar();' });
    expect(plan).toEqual({ kind: 'ambiguous', strategy: 'exact', lines: [2, 4] });
  });

  it('replace_all changes every match', () => {
    const plan = applied('a();\nfoo();\nb();\nfoo();\n', 'foo();', 'bar();', true);
    expect(plan.count).toBe(2);
    expect(plan.text).toBe('a();\nbar();\nb();\nbar();\n');
  });

  it('uses a line hint to choose among several matches', () => {
    const plan = planEdit('x\nfoo\ny\nfoo\nz\n', { old_string: 'foo\n', new_string: 'bar\n', lineHint: 4 });
    expect(plan.kind).toBe('applied');
    if (plan.kind === 'applied') expect(plan.text).toBe('x\nfoo\ny\nbar\nz\n');
  });

  it('detects an already-applied edit (old gone, new present)', () => {
    expect(planEdit('const timeout = 5000;\n', { old_string: 'const timeout = 1000;', new_string: 'const timeout = 5000;' }))
      .toEqual({ kind: 'already-applied' });
  });

  it('detects an already-applied addition (old is part of new)', () => {
    const file = 'import a from "a";\nimport b from "b";\n';
    expect(planEdit(file, { old_string: 'import a from "a";\n', new_string: 'import a from "a";\nimport b from "b";\n' }))
      .toEqual({ kind: 'already-applied' });
  });

  it('does not call a short, common new_string "already applied"', () => {
    const plan = planEdit('}\n}\n', { old_string: 'return nothing_here;', new_string: '}' });
    expect(plan.kind).toBe('no-match');
  });

  it('no match reports the closest region and its similarity', () => {
    const file = 'alpha\nbeta\nfunction greet(name) {\n  return "hi " + name;\n}\nomega\n';
    const plan = planEdit(file, { old_string: 'function greet(user) {\n  return "hello " + user + "!!";\n}\nextra line here', new_string: 'x' });
    expect(plan.kind).toBe('no-match');
    if (plan.kind === 'no-match') {
      expect(plan.closest).not.toBeNull();
      expect(plan.closest!.firstLine).toBe(2);
      expect(plan.closest!.similarity).toBeGreaterThan(0.3);
    }
  });

  it('rejects identical and empty old_string', () => {
    expect(planEdit('a', { old_string: 'a', new_string: 'a' }).kind).toBe('invalid');
    expect(planEdit('a', { old_string: '', new_string: 'b' }).kind).toBe('invalid');
  });

  it('deleting whole lines removes their newline', () => {
    const plan = applied('a\nremove me\nb\n', 'remove me\n', '');
    expect(plan.text).toBe('a\nb\n');
  });

  it('flexible match at EOF without trailing newline does not add one', () => {
    const plan = applied('a\n  last line   ', 'last line\n', 'final line\n');
    expect(plan.text.endsWith('final line')).toBe(true);
    expect(plan.text.endsWith('\n')).toBe(false);
  });

  it('handles unicode content in exact matches', () => {
    const plan = applied('greeting = "héllo wörld 👋"\n', 'héllo wörld 👋', 'hallo welt 🌍');
    expect(plan.text).toBe('greeting = "hallo welt 🌍"\n');
  });
});

describe('helpers', () => {
  it('levenshtein and similarity', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('a', 'abcdef', 2)).toBe(3);
    expect(similarity('abcd', 'abcd')).toBe(1);
    expect(similarity('abcd', 'abce')).toBe(0.75);
  });

  it('reindent shifts every line by the indentation delta', () => {
    expect(reindent('a\n  b\nc', '', '    ')).toBe('    a\n      b\n    c');
    expect(reindent('    a\n      b', '    ', '  ')).toBe('  a\n    b');
    expect(reindent('\ta\n\t\tb', '\t', '    ')).toBe('    a\n    \tb');
  });

  it('findMatches lineAnchored rejects mid-line matches', () => {
    expect(findMatches('xfoo\nfoo\n', 'foo\n', 'bar\n', { lineAnchored: true })!.matches).toHaveLength(1);
    expect(findMatches('xfoo\n', 'foo\n', 'bar\n', { lineAnchored: true })?.strategy).not.toBe('exact');
  });

  it('closestRegion returns null for empty input', () => {
    expect(closestRegion('abc', '   ')).toBeNull();
  });
});
