/**
 * Small coding tasks with hidden tests. The workspace holds a stub or buggy
 * module plus a couple of visible tests; the scorer runs a broader hidden
 * test file (written outside the workspace, never shown to the model).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchTask, ScoreResult } from '../types.js';
import { checks, nodeProject, readText, run, sha256, writeFiles } from './util.js';

interface CodingSpec {
  id: string;
  title: string;
  prompt: string;
  module: string;
  starter: string;
  visibleTest: string;
  /** Hidden test source; `@module` is replaced with the module's file URL. */
  hiddenTest: string;
  solution: string;
}

async function scoreCoding(ws: string, spec: CodingSpec): Promise<ScoreResult> {
  const hiddenDir = path.join(path.dirname(ws), 'hidden');
  await mkdir(hiddenDir, { recursive: true });
  const hiddenFile = path.join(hiddenDir, `${spec.id}.test.mjs`);
  const moduleUrl = pathToFileURL(path.join(ws, spec.module)).href;
  await writeFile(hiddenFile, spec.hiddenTest.replaceAll('@module', moduleUrl));
  const hidden = await run('node', ['--test', hiddenFile], hiddenDir);
  const visible = await run('node', ['--test'], ws);
  const testName = `test/${path.basename(spec.module, '.js')}.test.js`;
  const visibleSource = await readText(ws, testName);
  const failing = /(?:#|ℹ) fail (\d+)/.exec(hidden.stdout)?.[1];
  return checks([
    [`hidden tests pass${failing ? ` (${failing} failing)` : ''}`, hidden.code === 0],
    ['visible tests pass', visible.code === 0],
    ['visible tests untouched', visibleSource !== null && sha256(visibleSource) === sha256(spec.visibleTest)],
  ]);
}

function codingTask(spec: CodingSpec): BenchTask {
  const testName = `test/${path.basename(spec.module, '.js')}.test.js`;
  return {
    id: spec.id,
    category: 'coding',
    title: spec.title,
    prompt: [spec.prompt],
    setup: ws => writeFiles(ws, nodeProject(spec.id, { [spec.module]: spec.starter, [testName]: spec.visibleTest })),
    score: ws => scoreCoding(ws, spec),
    reference: [{
      steps: [
        // Read first: write_file refuses a blind overwrite of an unread file.
        [{ name: 'read_file', input: { path: spec.module } }],
        [{ name: 'write_file', input: { path: spec.module, content: spec.solution } }],
        [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -8' } }],
      ],
      reply: `Implemented ${spec.module}; npm test passes.`,
    }],
  };
}

const test = (imports: string, body: string) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ${imports} } from '@module';

${body}
`;

const visible = (imports: string, module: string, body: string) => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ${imports} } from '../${module}';

${body}
`;

const SLUGIFY: CodingSpec = {
  id: 'coding-slugify',
  title: 'implement slugify with diacritics',
  module: 'src/slugify.js',
  prompt: 'Implement `slugify(text)` in src/slugify.js: lowercase, strip accents (é → e), turn every run of non-alphanumeric characters into a single "-", and trim leading/trailing dashes. Empty or symbol-only input returns "". Make `npm test` pass.',
  starter: "export function slugify(text) {\n  throw new Error('not implemented');\n}\n",
  visibleTest: visible('slugify', 'src/slugify.js', "test('basic', () => {\n  assert.equal(slugify('Hello World'), 'hello-world');\n});\n"),
  hiddenTest: test('slugify', `test('accents', () => assert.equal(slugify('Crème Brûlée'), 'creme-brulee'));
test('runs collapse', () => assert.equal(slugify('  a -- b__c  '), 'a-b-c'));
test('trim dashes', () => assert.equal(slugify('--Rock & Roll!--'), 'rock-roll'));
test('digits kept', () => assert.equal(slugify('Top 10 Tips'), 'top-10-tips'));
test('empty', () => { assert.equal(slugify(''), ''); assert.equal(slugify('!!!'), ''); });`),
  solution: `export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
};

const LRU: CodingSpec = {
  id: 'coding-lru-cache',
  title: 'implement an LRU cache',
  module: 'src/lru.js',
  prompt: 'Implement `LRUCache` in src/lru.js: `new LRUCache(capacity)`, `get(key)` (returns undefined when missing and marks the key most recently used), `set(key, value)` (inserts or updates, marks most recently used, evicts the least recently used entry when over capacity) and a `size` getter. Make `npm test` pass.',
  starter: "export class LRUCache {\n  constructor(capacity) {\n    throw new Error('not implemented');\n  }\n}\n",
  visibleTest: visible('LRUCache', 'src/lru.js', "test('stores values', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  assert.equal(c.get('a'), 1);\n});\n"),
  hiddenTest: test('LRUCache', `test('evicts least recently used', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1); assert.equal(c.get('c'), 3);
});
test('update refreshes recency', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.set('a', 10); c.set('c', 3);
  assert.equal(c.get('a'), 10); assert.equal(c.get('b'), undefined);
});
test('size', () => {
  const c = new LRUCache(3);
  c.set('a', 1); c.set('b', 2); c.set('a', 3);
  assert.equal(c.size, 2);
  c.set('c', 1); c.set('d', 1);
  assert.equal(c.size, 3);
});
test('missing key', () => assert.equal(new LRUCache(1).get('x'), undefined));
test('falsy values are stored', () => { const c = new LRUCache(1); c.set('z', 0); assert.equal(c.get('z'), 0); });`),
  solution: `export class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }

  get size() {
    return this.map.size;
  }
}
`,
};

const DURATION: CodingSpec = {
  id: 'coding-parse-duration',
  title: 'fix parseDuration for compound units',
  module: 'src/duration.js',
  prompt: '`parseDuration` in src/duration.js only handles a single unit. It must accept compound strings like "1h30m", "2h", "45s", "1h30m15s" and "500ms" (units: h, m, s, ms) and return milliseconds. Anything else (empty string, unknown unit, garbage) must throw. Fix it so `npm test` passes.',
  starter: `const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

export function parseDuration(text) {
  const match = /^(\\d+)(h|m|s|ms)$/.exec(text);
  if (!match) throw new Error(\`bad duration: \${text}\`);
  return Number(match[1]) * UNITS[match[2]];
}
`,
  visibleTest: visible('parseDuration', 'src/duration.js', "test('single unit', () => {\n  assert.equal(parseDuration('2h'), 7200000);\n});\n\ntest('compound', () => {\n  assert.equal(parseDuration('1h30m'), 5400000);\n});\n"),
  hiddenTest: test('parseDuration', `test('seconds', () => assert.equal(parseDuration('45s'), 45000));
test('ms not minutes', () => assert.equal(parseDuration('500ms'), 500));
test('three parts', () => assert.equal(parseDuration('1h30m15s'), 5415000));
test('minutes and ms', () => assert.equal(parseDuration('2m250ms'), 120250));
test('rejects junk', () => {
  for (const bad of ['', 'abc', '10x', '1h 30m', 'h1']) assert.throws(() => parseDuration(bad), undefined, bad);
});`),
  solution: `const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

export function parseDuration(text) {
  if (typeof text !== 'string' || !/^(?:\\d+(?:ms|h|m|s))+$/.test(text)) {
    throw new Error(\`bad duration: \${text}\`);
  }
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\\d+)(ms|h|m|s)/g)) total += Number(amount) * UNITS[unit];
  return total;
}
`,
};

const CSV_LINE: CodingSpec = {
  id: 'coding-csv-line',
  title: 'parse a CSV line with quoted fields',
  module: 'src/csv.js',
  prompt: 'Implement `parseCsvLine(line)` in src/csv.js. It returns the array of fields of one CSV line: fields are separated by commas, a field may be wrapped in double quotes (then it can contain commas), and inside a quoted field `""` means a literal `"`. Empty fields are empty strings. Make `npm test` pass.',
  starter: "export function parseCsvLine(line) {\n  return line.split(',');\n}\n",
  visibleTest: visible('parseCsvLine', 'src/csv.js', "test('plain', () => {\n  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);\n});\n"),
  hiddenTest: test('parseCsvLine', `test('quoted comma', () => assert.deepEqual(parseCsvLine('1,"Smith, John",x'), ['1', 'Smith, John', 'x']));
test('escaped quote', () => assert.deepEqual(parseCsvLine('"say ""hi""",2'), ['say "hi"', '2']));
test('empty fields', () => assert.deepEqual(parseCsvLine('a,,c,'), ['a', '', 'c', '']));
test('empty quoted', () => assert.deepEqual(parseCsvLine('"",b'), ['', 'b']));
test('single field', () => assert.deepEqual(parseCsvLine('only'), ['only']));`),
  solution: `export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { fields.push(field); field = ''; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}
`,
};

const DEEP_MERGE: CodingSpec = {
  id: 'coding-deep-merge',
  title: 'fix deepMerge (mutation + arrays)',
  module: 'src/merge.js',
  prompt: '`deepMerge(base, override)` in src/merge.js has bugs. It must return a new object without mutating either input, merge nested plain objects recursively, and let arrays and primitives from `override` replace (not merge with) the base value. Fix it so `npm test` passes.',
  starter: `export function deepMerge(base, override) {
  for (const key of Object.keys(override)) {
    if (typeof override[key] === 'object' && typeof base[key] === 'object') {
      base[key] = deepMerge(base[key], override[key]);
    } else {
      base[key] = override[key];
    }
  }
  return base;
}
`,
  visibleTest: visible('deepMerge', 'src/merge.js', "test('nested', () => {\n  assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: { y: 2 } }), { a: { x: 1, y: 2 } });\n});\n"),
  hiddenTest: test('deepMerge', `test('does not mutate', () => {
  const base = { a: { x: 1 } }; const over = { a: { y: 2 } };
  deepMerge(base, over);
  assert.deepEqual(base, { a: { x: 1 } }); assert.deepEqual(over, { a: { y: 2 } });
});
test('arrays replace', () => assert.deepEqual(deepMerge({ list: [1, 2, 3] }, { list: [9] }), { list: [9] }));
test('null overrides', () => assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: null }), { a: null }));
test('object over primitive', () => assert.deepEqual(deepMerge({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } }));
test('result is not the base', () => { const base = { a: 1 }; assert.notEqual(deepMerge(base, {}), base); });`),
  solution: `const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}
`,
};

const ROMAN: CodingSpec = {
  id: 'coding-roman',
  title: 'roman numerals both ways',
  module: 'src/roman.js',
  prompt: 'Implement `toRoman(n)` and `fromRoman(s)` in src/roman.js for 1..3999 using standard subtractive notation (IV, IX, XL, XC, CD, CM). `toRoman` throws a RangeError outside 1..3999; `fromRoman` throws on invalid input. Make `npm test` pass.',
  starter: "export function toRoman(n) {\n  throw new Error('not implemented');\n}\n\nexport function fromRoman(s) {\n  throw new Error('not implemented');\n}\n",
  visibleTest: visible('toRoman, fromRoman', 'src/roman.js', "test('small', () => {\n  assert.equal(toRoman(4), 'IV');\n  assert.equal(fromRoman('IX'), 9);\n});\n"),
  hiddenTest: test('toRoman, fromRoman', `test('to', () => {
  assert.equal(toRoman(1994), 'MCMXCIV'); assert.equal(toRoman(3999), 'MMMCMXCIX'); assert.equal(toRoman(40), 'XL');
});
test('from', () => { assert.equal(fromRoman('MCMXCIV'), 1994); assert.equal(fromRoman('CDXLIV'), 444); });
test('round trip', () => { for (let n = 1; n < 4000; n += 37) assert.equal(fromRoman(toRoman(n)), n); });
test('range', () => { assert.throws(() => toRoman(0), RangeError); assert.throws(() => toRoman(4000), RangeError); });
test('invalid', () => { assert.throws(() => fromRoman('ABC')); assert.throws(() => fromRoman('')); assert.throws(() => fromRoman('IIII')); });`),
  solution: `const TABLE = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError(\`out of range: \${n}\`);
  let out = '';
  for (const [value, symbol] of TABLE) {
    while (n >= value) { out += symbol; n -= value; }
  }
  return out;
}

export function fromRoman(s) {
  if (typeof s !== 'string' || !/^[MDCLXVI]+$/.test(s)) throw new Error(\`invalid numeral: \${s}\`);
  let total = 0;
  let rest = s;
  for (const [value, symbol] of TABLE) {
    while (rest.startsWith(symbol)) { total += value; rest = rest.slice(symbol.length); }
  }
  if (rest || toRoman(total) !== s) throw new Error(\`invalid numeral: \${s}\`);
  return total;
}
`,
};

export const CODING_TASKS: BenchTask[] = [SLUGIFY, LRU, DURATION, CSV_LINE, DEEP_MERGE, ROMAN].map(codingTask);

/** Exposed for tests: starter code must fail the hidden tests. */
export const CODING_SPECS = { SLUGIFY, LRU, DURATION, CSV_LINE, DEEP_MERGE, ROMAN };
