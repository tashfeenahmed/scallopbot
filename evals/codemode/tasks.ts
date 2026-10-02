/**
 * Seeded multi-step tasks for the code-mode A/B. Each task writes a small
 * deterministic repo into a fresh directory and verifies the end state from
 * the filesystem (never from the model's own report).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface BenchTask {
  id: string;
  prompt: string;
  seed(dir: string): void;
  verify(dir: string): { pass: boolean; detail: string };
}

/** mulberry32: small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function write(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

// ── 1. TODO counts → CSV ─────────────────────────────────────────────────────

const MODULES = ['core', 'util', 'api', 'ui', 'data'];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

function todoExpected(): Array<[string, number]> {
  const rand = rng(42);
  const rows: Array<[string, number]> = [];
  for (const mod of MODULES) {
    for (const word of WORDS) {
      const file = `src/${mod}/${word}.ts`;
      const count = Math.floor(rand() * 6); // 0..5
      rows.push([file, count]);
    }
  }
  return rows;
}

export const todoCsvTask: BenchTask = {
  id: 'todo-csv',
  prompt:
    'In this repository, count the TODO comments in every .ts file under src/. A TODO comment is a line that contains the exact text "// TODO". ' +
    'Write todo_counts.csv in the repository root with the header line "file,count" and one row per file that has at least one TODO comment, ' +
    'where file is the path relative to the repository root (like src/core/alpha.ts). Sort rows by count descending, then by file path ascending. ' +
    'Files with zero TODO comments must not appear.',
  seed(dir) {
    const rand = rng(7);
    for (const [file, count] of todoExpected()) {
      const lines: string[] = [`// ${file}`, `export const todoList = [];  // not a TODO comment: no marker`];
      let placed = 0;
      const total = 25 + Math.floor(rand() * 40);
      for (let i = 0; i < total; i++) {
        if (placed < count && rand() < (count - placed) / (total - i)) {
          lines.push(`  // TODO: handle case ${i} in ${path.basename(file, '.ts')}`);
          placed++;
        } else if (rand() < 0.1) {
          lines.push(`  const note${i} = "TODO later";  // a string, not a comment marker`);
        } else {
          lines.push(`  const v${i} = ${Math.floor(rand() * 1000)};`);
        }
      }
      while (placed < count) {
        lines.push('// TODO: tail item');
        placed++;
      }
      write(dir, file, lines.join('\n') + '\n');
    }
  },
  verify(dir) {
    const file = path.join(dir, 'todo_counts.csv');
    if (!existsSync(file)) return { pass: false, detail: 'todo_counts.csv missing' };
    const expected = todoExpected()
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([f, n]) => `${f},${n}`);
    const actual = readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => line.trim().replace(/^\.\//, '').replace(/"/g, ''));
    if (actual[0] !== 'file,count') return { pass: false, detail: `bad header: ${actual[0]}` };
    const rows = actual.slice(1).filter(Boolean);
    const same = rows.length === expected.length && rows.every((row, i) => row === expected[i]);
    return { pass: same, detail: same ? `${rows.length} rows exact` : `rows differ: got ${rows.length}, expected ${expected.length}; first diff at ${rows.findIndex((r, i) => r !== expected[i])}` };
  },
};

// ── 2. Three largest functions ──────────────────────────────────────────────

const FN_FILES = 12;

function functionsLayout(): Array<{ file: string; fns: Array<{ name: string; length: number }> }> {
  const rand = rng(1234);
  const used = new Set<number>();
  const pickLength = () => {
    for (;;) {
      const n = 3 + Math.floor(rand() * 70);
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
  const layout: Array<{ file: string; fns: Array<{ name: string; length: number }> }> = [];
  let counter = 0;
  for (let f = 0; f < FN_FILES; f++) {
    const fns: Array<{ name: string; length: number }> = [];
    const k = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < k; i++) fns.push({ name: `${WORDS[(f + i) % WORDS.length]}Handler${++counter}`, length: pickLength() });
    layout.push({ file: `lib/module${String(f + 1).padStart(2, '0')}.js`, fns });
  }
  return layout;
}

export const largestFunctionsTask: BenchTask = {
  id: 'largest-functions',
  prompt:
    'Find the 3 longest top-level function declarations across all .js files in lib/. Length = number of lines from the line with the "function" keyword ' +
    'to the line with its closing brace, inclusive. Write their names to largest.txt in the repository root, one name per line, longest first.',
  seed(dir) {
    for (const { file, fns } of functionsLayout()) {
      const parts: string[] = ["'use strict';", ''];
      for (const fn of fns) {
        parts.push(`function ${fn.name}(input) {`);
        for (let i = 0; i < fn.length - 2; i++) parts.push(`  const step${i} = input + ${i}; // work`);
        parts.push('}');
        parts.push('');
      }
      parts.push(`module.exports = { ${fns.map(fn => fn.name).join(', ')} };`);
      write(dir, file, parts.join('\n') + '\n');
    }
  },
  verify(dir) {
    const file = path.join(dir, 'largest.txt');
    if (!existsSync(file)) return { pass: false, detail: 'largest.txt missing' };
    const expected = functionsLayout().flatMap(entry => entry.fns).sort((a, b) => b.length - a.length).slice(0, 3).map(fn => fn.name);
    const actual = readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const pass = actual.length === 3 && actual.every((name, i) => name === expected[i]);
    return { pass, detail: pass ? 'exact' : `got [${actual.join(', ')}], expected [${expected.join(', ')}]` };
  },
};

// ── 3. Rename a symbol across files and run the tests ───────────────────────

export const renameAndTestTask: BenchTask = {
  id: 'rename-and-test',
  prompt:
    'Rename the function computeTotal to sumAll in every .js file of this project: its definition, its imports and every call site. ' +
    'Do not rename other identifiers that merely start with the same letters (computeTotalTax must stay as it is). ' +
    'Then run `node test.js` from the repository root and make sure it prints ALL TESTS PASSED.',
  seed(dir) {
    write(dir, 'package.json', JSON.stringify({ name: 'shop', type: 'module', private: true }, null, 2) + '\n');
    write(dir, 'src/math.js', [
      'export function computeTotal(items) {',
      '  return items.reduce((sum, item) => sum + item.price * item.qty, 0);',
      '}',
      '',
      'export function computeTotalTax(items, rate) {',
      '  return Math.round(computeTotal(items) * rate * 100) / 100;',
      '}',
      '',
    ].join('\n'));
    write(dir, 'src/cart.js', [
      "import { computeTotal } from './math.js';",
      '',
      'export function cartSummary(items) {',
      '  const total = computeTotal(items);',
      '  return `${items.length} items, total ${total}`;',
      '}',
      '',
    ].join('\n'));
    write(dir, 'src/report.js', [
      "import { computeTotal, computeTotalTax } from './math.js';",
      '',
      'export function report(orders) {',
      '  return orders.map(order => ({',
      '    id: order.id,',
      '    total: computeTotal(order.items),',
      '    tax: computeTotalTax(order.items, 0.2),',
      '  }));',
      '}',
      '',
      'export function grandTotal(orders) {',
      '  return orders.reduce((acc, order) => acc + computeTotal(order.items), 0);',
      '}',
      '',
    ].join('\n'));
    write(dir, 'src/invoice.js', [
      "import * as math from './math.js';",
      '',
      'export function invoiceLine(order) {',
      '  return `Order ${order.id}: ${math.computeTotal(order.items)}`;',
      '}',
      '',
    ].join('\n'));
    write(dir, 'test.js', [
      "import assert from 'node:assert/strict';",
      "import * as math from './src/math.js';",
      "import { cartSummary } from './src/cart.js';",
      "import { report, grandTotal } from './src/report.js';",
      "import { invoiceLine } from './src/invoice.js';",
      '',
      "const items = [{ price: 2, qty: 3 }, { price: 5, qty: 1 }];",
      "const orders = [{ id: 'a', items }, { id: 'b', items: [{ price: 1, qty: 1 }] }];",
      "assert.equal(typeof math.sumAll, 'function', 'sumAll must be exported from src/math.js');",
      "assert.deepEqual(Object.keys(math).sort(), ['computeTotalTax', 'sumAll'], 'math.js must export exactly sumAll and computeTotalTax');",
      "assert.equal(math.sumAll(items), 11);",
      "assert.equal(cartSummary(items), '2 items, total 11');",
      "assert.deepEqual(report(orders)[0], { id: 'a', total: 11, tax: 2.2 });",
      "assert.equal(grandTotal(orders), 12);",
      "assert.equal(invoiceLine(orders[1]), 'Order b: 1');",
      "console.log('ALL TESTS PASSED');",
      '',
    ].join('\n'));
  },
  verify(dir) {
    const leftovers = walk(dir)
      .filter(file => file.endsWith('.js'))
      .filter(file => /\bcomputeTotal\b/.test(readFileSync(path.join(dir, file), 'utf8')));
    if (leftovers.length) return { pass: false, detail: `computeTotal still in ${leftovers.join(', ')}` };
    try {
      const out = execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
      return { pass: out.includes('ALL TESTS PASSED'), detail: out.trim().slice(0, 200) };
    } catch (error) {
      return { pass: false, detail: `node test.js failed: ${String((error as { stderr?: string }).stderr ?? error).slice(0, 300)}` };
    }
  },
};

export const TASKS: BenchTask[] = [todoCsvTask, largestFunctionsTask, renameAndTestTask];
