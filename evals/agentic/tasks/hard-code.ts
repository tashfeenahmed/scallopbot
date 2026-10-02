/**
 * Hard tasks, code side: long dependent chains, refactors with hidden tests,
 * error recovery and precise edits. Every scorer reads only the workspace and
 * the replies, so the same scorer judges any agent (see BASELINES.md,
 * cross-agent mode). Each task is built so a careless agent fails it: a
 * decoy that a naive grep picks, a sed that also hits a longer name, a crash
 * whose fix needs a second, silent fix, a module that must survive a split.
 */

import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchTask } from '../types.js';
import {
  changedSeedFiles,
  checks,
  countWord,
  exists,
  fail,
  nodeProject,
  prng,
  readText,
  run,
  runHiddenTest,
  visibleText,
  withTempDir,
  writeFiles,
} from './util.js';

/** Run `expr` (an expression over `m`, the imported module) and return its JSON. */
async function probe(root: string, modulePath: string, expr: string): Promise<string> {
  const url = pathToFileURL(path.join(root, modulePath)).href;
  const result = await run('node', ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(url)});
    console.log(JSON.stringify(${expr}));
  `], root);
  return result.code === 0 ? result.stdout.trim() : `ERROR ${result.stderr.trim().split('\n').slice(0, 3).join(' ')}`;
}

// ---------------------------------------------------------------------------
// hard-rename-most-called: search → count real call sites → rename → test

type Helper = 'toSlug' | 'parseId' | 'toSlugPath' | 'titleCase' | 'padLeft';

const HELPER_MODULE: Record<Helper, string> = {
  toSlug: '../lib/text.js', toSlugPath: '../lib/text.js', titleCase: '../lib/text.js',
  padLeft: '../lib/format.js', parseId: '../lib/ids.js',
};
const HELPER_CALLS: Record<Helper, string[]> = {
  toSlug: ['toSlug(input.title)', 'toSlug(input.owner)'],
  parseId: ['String(parseId(input.id))'],
  toSlugPath: ['toSlugPath(input.path)'],
  titleCase: ['titleCase(input.owner)'],
  padLeft: ['padLeft(String(input.n), 6)'],
};

/**
 * 34 feature modules. Real call sites: toSlug 13 (+1 inside toSlugPath),
 * parseId 9, titleCase 7, toSlugPath 6, padLeft 5. Comments mention
 * `parseId()` seven more times, so counting `parseId(` with grep picks the
 * wrong function; a sed on `toSlug` also renames `toSlugPath`.
 */
const FEATURE_PLAN: Array<{ calls: Helper[]; comment?: boolean }> = [
  { calls: ['toSlug', 'padLeft'] }, { calls: ['toSlug'], comment: true }, { calls: ['toSlug', 'toSlug'] },
  { calls: ['toSlug'] }, { calls: ['toSlug'], comment: true }, { calls: ['toSlug'] },
  { calls: ['toSlug', 'toSlug'] }, { calls: ['toSlug'], comment: true }, { calls: ['toSlug'] },
  { calls: ['toSlug'] }, { calls: ['toSlug'] },
  { calls: ['parseId', 'padLeft'] }, ...Array.from({ length: 8 }, () => ({ calls: ['parseId'] as Helper[] })),
  { calls: ['toSlugPath', 'padLeft'] }, { calls: ['toSlugPath'], comment: true },
  ...Array.from({ length: 4 }, () => ({ calls: ['toSlugPath'] as Helper[] })),
  { calls: ['titleCase', 'padLeft'] }, { calls: ['titleCase'], comment: true }, { calls: ['titleCase'] },
  { calls: ['titleCase'] }, { calls: ['titleCase'], comment: true }, { calls: ['titleCase'] }, { calls: ['titleCase'] },
  { calls: ['padLeft'] },
];

const RENAME_INPUT = { title: 'Hello World, Again!', owner: 'ada LOVELACE', id: 'INV-0042', path: 'Docs/Getting Started/Intro', n: 42 };

function featureSource(index: number, plan: { calls: Helper[]; comment?: boolean }): string {
  const name = `feature${String(index + 1).padStart(2, '0')}`;
  const byModule = new Map<string, Set<Helper>>();
  for (const helper of plan.calls) {
    const module = HELPER_MODULE[helper];
    byModule.set(module, (byModule.get(module) ?? new Set()).add(helper));
  }
  const imports = [...byModule].map(([module, helpers]) => `import { ${[...helpers].join(', ')} } from '${module}';`);
  const seen: Record<string, number> = {};
  const exprs = plan.calls.map((helper) => {
    const n = seen[helper] = (seen[helper] ?? -1) + 1;
    return HELPER_CALLS[helper][n % HELPER_CALLS[helper].length]!;
  });
  return [
    ...imports,
    '',
    ...(plan.comment ? ['// TODO: stop calling parseId() from features once v2 ids ship.'] : []),
    `export function ${name}(input) {`,
    '  return [',
    ...exprs.map(expr => `    ${expr},`),
    `  ].join(' | ');`,
    '}',
    '',
  ].join('\n');
}

const RENAME_FILES: Record<string, string> = (() => {
  const features = FEATURE_PLAN.map((plan, i) => [`src/features/f${String(i + 1).padStart(2, '0')}.js`, featureSource(i, plan)] as const);
  const names = FEATURE_PLAN.map((_, i) => `feature${String(i + 1).padStart(2, '0')}`);
  return {
    'README.md': '# feature-kit\n\nShared helpers live in `src/lib/`. Every module in `src/features/` builds one line of the dashboard from them.\n\nRun `npm test`.\n',
    'src/lib/text.js': `/** URL slug: lowercase, every run of non-alphanumerics becomes one "-". */
export function toSlug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Slug every segment of a path. Unlike parseId(), this never throws. */
export function toSlugPath(value) {
  return String(value).split('/').map(segment => toSlug(segment)).join('/');
}

export function titleCase(text) {
  return String(text).toLowerCase().replace(/\\b[a-z]/g, c => c.toUpperCase());
}
`,
    'src/lib/ids.js': `/** "INV-0042" → 42. Throws on anything else; see parseId() callers in features/. */
export function parseId(raw) {
  const match = /^([A-Z]+)-(\\d+)$/.exec(String(raw).trim());
  if (!match) throw new Error(\`bad id: \${raw}\`);
  return Number(match[2]);
}
`,
    'src/lib/format.js': `export function padLeft(text, width, fill = ' ') {
  return String(text).padStart(width, fill);
}
`,
    'src/index.js': [
      ...names.map((name, i) => `import { ${name} } from './features/f${String(i + 1).padStart(2, '0')}.js';`),
      '',
      `export const FEATURES = [${names.join(', ')}];`,
      '',
      'export function runAll(input) {',
      '  return FEATURES.map(feature => feature(input));',
      '}',
      '',
    ].join('\n'),
    ...Object.fromEntries(features),
    'test/text.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlug, toSlugPath, titleCase } from '../src/lib/text.js';

test('toSlug', () => {
  assert.equal(toSlug('Hello, World!'), 'hello-world');
});

test('toSlugPath', () => {
  assert.equal(toSlugPath('A B/C d'), 'a-b/c-d');
});

test('titleCase', () => {
  assert.equal(titleCase('ada LOVELACE'), 'Ada Lovelace');
});
`,
    'test/features.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/index.js';

test('every feature renders', () => {
  const lines = runAll({ title: 'T', owner: 'o', id: 'A-1', path: 'x/y', n: 1 });
  assert.equal(lines.length, ${names.length});
  for (const line of lines) assert.ok(line.length > 0);
});
`,
  };
})();

const setupRename = (ws: string) => writeFiles(ws, nodeProject('feature-kit', RENAME_FILES));
const RUN_ALL_EXPR = `m.runAll(${JSON.stringify(RENAME_INPUT)})`;

const renameMostCalled: BenchTask = {
  id: 'hard-rename-most-called',
  category: 'hard',
  title: 'find the most-called function in a 40-file repo, rename it everywhere, keep tests green',
  prompt: [
    'Which function in src/ is called from the most places? Count real call sites in code, not mentions in comments. Rename that function to `centralHelper` everywhere it is used (definition, imports, calls, tests), keep `npm test` passing, and tell me which function it was.',
  ],
  timeoutMs: 600_000,
  setup: setupRename,
  async score(ws, trace) {
    const before = await withTempDir('rename-pristine', async (dir) => {
      await setupRename(dir);
      return {
        output: await probe(dir, 'src/index.js', RUN_ALL_EXPR),
        toSlugPath: await countWord(dir, ['src', 'test'], 'toSlugPath'),
        parseId: await countWord(dir, ['src', 'test'], 'parseId'),
      };
    });
    const tests = await run('node', ['--test'], ws);
    const hidden = await runHiddenTest(ws, 'rename', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as text from '@ws/src/lib/text.js';
import { parseId } from '@ws/src/lib/ids.js';

test('centralHelper is the old toSlug', () => {
  assert.equal(text.centralHelper('Hello, World!'), 'hello-world');
  assert.equal(text.toSlug, undefined);
});
test('neighbours untouched', () => {
  assert.equal(text.toSlugPath('A B/C d'), 'a-b/c-d');
  assert.equal(text.titleCase('x y'), 'X Y');
  assert.equal(parseId('INV-0042'), 42);
});
`);
    return checks([
      ['npm test passes', tests.code === 0],
      ['hidden: centralHelper exported, toSlug gone, neighbours intact', hidden.code === 0],
      ['no `toSlug` identifier left in src/ or test/', await countWord(ws, ['src', 'test'], 'toSlug') === 0],
      ['toSlugPath not renamed (every use intact)', await countWord(ws, ['src', 'test'], 'toSlugPath') === before.toSlugPath],
      ['parseId untouched', await countWord(ws, ['src', 'test'], 'parseId') === before.parseId],
      ['runAll output unchanged', await probe(ws, 'src/index.js', RUN_ALL_EXPR) === before.output],
      ['reply names toSlug', /\btoSlug\b/.test(visibleText(trace))],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: "grep -rnoE '\\b(toSlug|toSlugPath|parseId|titleCase|padLeft)\\(' src | grep -v '//' | awk -F: '{print $NF}' | sort | uniq -c | sort -rn" } }],
      [{ name: 'bash', input: { command: "grep -rlw toSlug src test | xargs perl -pi -e 's/\\btoSlug\\b/centralHelper/g' && npm test 2>&1 | tail -5" } }],
    ],
    reply: '`toSlug` (src/lib/text.js) has the most call sites: 13 in src/features plus one inside toSlugPath. `parseId` only looks bigger because comments mention it. Renamed it to `centralHelper` everywhere (toSlugPath left alone); npm test passes.',
  }],
};

// ---------------------------------------------------------------------------
// hard-env-report: a misleading crash, then a silent second failure

const SALES_REGIONS = ['north', 'south', 'east', 'west'] as const;
const SALES = (() => {
  const random = prng(314);
  return Array.from({ length: 48 }, (_, i) => ({
    id: `s-${1000 + i}`,
    region: SALES_REGIONS[Math.floor(random() * SALES_REGIONS.length)]!,
    amount_usd: Math.round(random() * 90_000) / 100,
  }));
})();
const RATES = { USD: 1, EUR: 0.92, GBP: 0.79 };
const EXPECTED_REPORT = `${['north', 'east', 'west'].map((region) => {
  const total = SALES.filter(s => s.region === region).reduce((sum, s) => sum + s.amount_usd, 0);
  return `${region}: ${(total * RATES.EUR).toFixed(2)} EUR`;
}).join('\n')}\n`;

const ENV_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'sales-report', version: '1.0.0', type: 'module', scripts: { report: 'node scripts/report.mjs' } }, null, 2)}\n`,
  'README.md': '# sales-report\n\n`npm run report` writes out/report.txt with the total sales per region.\n\nConfiguration comes from the environment (a `.env` file in the project root is loaded if present). See `.env.example`.\n',
  '.env.example': '# Copy to .env and adjust. Never commit .env.\nREPORT_REGIONS=north,south\nREPORT_CURRENCY=USD\n',
  '.gitignore': '.env\nout/\n',
  'scripts/env.mjs': `import { existsSync, readFileSync } from 'node:fs';

/** Load KEY=VALUE lines from a dotenv file into process.env (values already set win). */
export function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\\n')) {
    if (line.trim().startsWith('#')) continue;
    const match = /^\\s*(?:export\\s+)?([A-Z0-9_]+)\\s*=\\s*(.*?)\\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
`,
  'scripts/report.mjs': `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
loadEnv(\`\${root}/.env\`);

const sales = JSON.parse(readFileSync(\`\${root}/data/sales.json\`, 'utf8'));
const rates = JSON.parse(readFileSync(\`\${root}/data/rates.json\`, 'utf8'));

function regionList(raw) {
  return raw.split(',').map(region => region.trim().toLowerCase()).filter(Boolean);
}

function convert(amountUsd, currency) {
  return amountUsd * rates[currency];
}

const regions = regionList(process.env.REPORT_REGIONS);
const currency = process.env.REPORT_CURRENCY;
const lines = regions.map((region) => {
  const total = sales.filter(sale => sale.region === region).reduce((sum, sale) => sum + sale.amount_usd, 0);
  return \`\${region}: \${convert(total, currency).toFixed(2)} \${currency}\`;
});

mkdirSync(\`\${root}/out\`, { recursive: true });
writeFileSync(\`\${root}/out/report.txt\`, \`\${lines.join('\\n')}\\n\`);
console.log(\`wrote out/report.txt (\${lines.length} regions)\`);
`,
  'data/sales.json': `${JSON.stringify(SALES, null, 2)}\n`,
  'data/rates.json': `${JSON.stringify(RATES, null, 2)}\n`,
};
const setupEnvReport = (ws: string) => writeFiles(ws, ENV_FILES);

/** Copy a workspace (without node_modules/out) somewhere else, for a clean re-run. */
async function copyWorkspace(ws: string, target: string, skip: string[] = ['node_modules']): Promise<void> {
  await cp(ws, target, {
    recursive: true,
    filter: source => !skip.includes(path.relative(ws, source).split(path.sep)[0]!),
  });
}

const envReport: BenchTask = {
  id: 'hard-env-report',
  category: 'hard',
  title: 'misleading crash (missing env config), then a silent NaN; fix the cause, not the script',
  prompt: [
    '`npm run report` crashes. I need out/report.txt covering the north, east and west regions, with amounts in EUR. Don\'t edit anything under scripts/ — those files are shared with other teams.',
  ],
  timeoutMs: 600_000,
  setup: setupEnvReport,
  async score(ws) {
    const produced = await readText(ws, 'out/report.txt');
    // Re-run from a clean copy with a bare environment: the fix must live in the project.
    const rerun = await withTempDir('env-rerun', async (dir) => {
      await copyWorkspace(ws, dir, ['node_modules', 'out']);
      const result = await run('npm', ['run', '--silent', 'report'], dir, 60_000, { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' });
      return { code: result.code, report: await readText(dir, 'out/report.txt') };
    });
    const changed = await changedSeedFiles(ws, setupEnvReport);
    return checks([
      ['out/report.txt in the workspace is right', produced === EXPECTED_REPORT],
      [`a clean \`npm run report\` (bare env) reproduces it (exit ${rerun.code})`, rerun.code === 0 && rerun.report === EXPECTED_REPORT],
      [`scripts/ untouched${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`, !changed.some(file => file.startsWith('scripts/'))],
      ['data untouched', !changed.some(file => file.startsWith('data/'))],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: 'npm run report 2>&1 | tail -15; cat .env.example' } }],
      [{ name: 'write_file', input: { path: '.env', content: 'REPORT_REGIONS=north,east,west\nREPORT_CURRENCY=EUR\n' } }],
      [{ name: 'bash', input: { command: 'npm run report && cat out/report.txt' } }],
    ],
    reply: 'The crash was REPORT_REGIONS being unset (the script calls .split on it), and REPORT_CURRENCY was missing too, which would have printed NaN. Created .env with REPORT_REGIONS=north,east,west and REPORT_CURRENCY=EUR; out/report.txt now has the three regions in EUR. scripts/ untouched.',
  }],
};

// ---------------------------------------------------------------------------
// hard-vendor-offline: dependency must come from a local tarball (no network)

const strcaseSource = (withKebab: boolean) => `const words = text => String(text).trim().split(/[\\s_-]+/).filter(Boolean);

export function titleCase(text) {
  return words(text).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export function camel(text) {
  return words(text).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
${withKebab ? `
export function kebab(text) {
  return words(text).map(w => w.toLowerCase()).join('-');
}
` : ''}`;

async function writeStrcaseTarball(ws: string, version: string, withKebab: boolean): Promise<void> {
  await withTempDir('strcase', async (dir) => {
    await writeFiles(path.join(dir, 'package'), {
      'package.json': `${JSON.stringify({ name: '@scallopbench/strcase', version, type: 'module', main: 'index.js', exports: './index.js', license: 'MIT' }, null, 2)}\n`,
      'index.js': strcaseSource(withKebab),
      'README.md': `# @scallopbench/strcase ${version}\n\nString case helpers${withKebab ? ' (titleCase, camel, kebab)' : ' (titleCase, camel)'}.\n`,
    });
    const target = path.join(ws, 'vendor', `scallopbench-strcase-${version}.tgz`);
    await mkdir(path.dirname(target), { recursive: true });
    // COPYFILE_DISABLE keeps macOS tar from adding ._ AppleDouble entries.
    const result = await run('tar', ['-czf', target, '-C', dir, 'package'], dir, 30_000, { ...process.env, COPYFILE_DISABLE: '1' });
    if (result.code !== 0) throw new Error(`tar failed: ${result.stderr}`);
  });
}

const setupVendor = async (ws: string) => {
  await writeFiles(ws, {
    'package.json': `${JSON.stringify({
      name: 'greeter', version: '1.0.0', type: 'module',
      scripts: { test: 'node --test', start: 'node app.mjs' },
      dependencies: { '@scallopbench/strcase': '^1.2.0' },
    }, null, 2)}\n`,
    'app.mjs': `import { titleCase, kebab } from '@scallopbench/strcase';

export function label(text) {
  return \`\${titleCase(text)} (\${kebab(text)})\`;
}

if (import.meta.url === \`file://\${process.argv[1]}\`) console.log(label(process.argv[2] ?? 'hello world'));
`,
    'test/app.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { label } from '../app.mjs';

test('label', () => {
  assert.equal(label('hello big world'), 'Hello Big World (hello-big-world)');
});
`,
    'vendor/README.md': 'Offline mirror of our internal packages (this build machine has no registry access).\n',
  });
  await writeStrcaseTarball(ws, '1.1.0', false);
  await writeStrcaseTarball(ws, '1.2.0', true);
};

const vendorOffline: BenchTask = {
  id: 'hard-vendor-offline',
  category: 'hard',
  title: 'missing dependency must be installed from the right local tarball; fresh offline install must work',
  prompt: [
    '`npm test` fails in this project. Fix it. This machine has no internet access, and a fresh `npm install` here has to keep working offline afterwards.',
  ],
  timeoutMs: 600_000,
  setup: setupVendor,
  async score(ws) {
    const tests = await run('node', ['--test'], ws);
    const installed = await readText(ws, 'node_modules/@scallopbench/strcase/package.json');
    const version = installed ? (JSON.parse(installed) as { version?: string }).version : undefined;
    const fresh = await withTempDir('vendor-fresh', async (dir) => {
      await copyWorkspace(ws, dir);
      const env = {
        ...process.env,
        npm_config_registry: 'http://127.0.0.1:9/',
        npm_config_cache: path.join(dir, '.npm-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      };
      const install = await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], dir, 120_000, env);
      const test = install.code === 0 ? await run('node', ['--test'], dir) : { code: 1 };
      return { install: install.code, test: test.code };
    });
    // Tarballs embed mtimes, so they are checked for presence rather than by hash.
    const tarballs = ['1.1.0', '1.2.0'].map(v => `vendor/scallopbench-strcase-${v}.tgz`);
    const changed = await changedSeedFiles(ws, setupVendor, ['package.json', ...tarballs]);
    return checks([
      ['vendor tarballs kept', tarballs.every(file => exists(ws, file))],
      ['npm test passes', tests.code === 0],
      [`strcase 1.2.0 installed (saw ${version ?? 'none'})`, version === '1.2.0'],
      [`fresh offline npm install + test works (install exit ${fresh.install}, test exit ${fresh.test})`, fresh.install === 0 && fresh.test === 0],
      [`app, tests and vendor/ untouched${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`, changed.length === 0],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -5; ls vendor' } }],
      [{ name: 'bash', input: { command: 'npm install --offline --no-audit --no-fund ./vendor/scallopbench-strcase-1.2.0.tgz 2>&1 | tail -3 && npm test 2>&1 | tail -4' } }],
    ],
    reply: 'The dependency @scallopbench/strcase was never installed and is not on any registry; vendor/ has it. Installed 1.2.0 from vendor/scallopbench-strcase-1.2.0.tgz (1.1.0 lacks `kebab`), so package.json now points at the tarball and a fresh offline `npm install` works. Tests pass.',
  }],
};

// ---------------------------------------------------------------------------
// hard-split-money: split a module + change a signature used in 10 places

const MONEY_JS = `const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

/** formatPrice(amount, currency = 'USD', locale = 'en') → "$1,234.50" / "1.234,50 €". */
export function formatPrice(amount, currency = 'USD', locale = 'en') {
  const symbol = SYMBOLS[currency] ?? \`\${currency} \`;
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
  const group = locale === 'de' ? '.' : ',';
  const decimal = locale === 'de' ? ',' : '.';
  const digits = \`\${whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, group)}\${decimal}\${cents}\`;
  const sign = amount < 0 ? '-' : '';
  return locale === 'de' ? \`\${sign}\${digits} \${symbol.trim()}\` : \`\${sign}\${symbol}\${digits}\`;
}

/** Parse "$1,234.50" or "1.234,50 €" back into { amount, currency }. */
export function parsePrice(text) {
  const trimmed = String(text).trim();
  const currency = Object.keys(SYMBOLS).find(code => trimmed.includes(SYMBOLS[code])) ?? 'USD';
  const german = /,\\d{2}(?:\\s*\\S*)$/.test(trimmed);
  const digits = trimmed.replace(/[^\\d,.-]/g, '');
  const normalized = german ? digits.replace(/\\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  return { amount: Number(normalized), currency };
}

export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}
`;

const MONEY_FILES: Record<string, string> = {
  'src/money.js': MONEY_JS,
  'src/invoice.js': `import { formatPrice } from './money.js';

export function invoiceLine(item) {
  return \`\${item.name} x\${item.qty}: \${formatPrice(item.price * item.qty, item.currency)}\`;
}
`,
  'src/cart.js': `import { formatPrice, roundCents } from './money.js';

export function cartSummary(items) {
  const total = roundCents(items.reduce((sum, item) => sum + item.price * item.qty, 0));
  return \`\${items.length} items, subtotal \${formatPrice(total)} (approx. \${formatPrice(total * 0.92, 'EUR', 'de')})\`;
}
`,
  'src/receipt.js': `import { formatPrice } from './money.js';

export function receiptFooter(amount) {
  return \`Paid: \${formatPrice(amount, 'GBP')}. Thank you!\`;
}
`,
  'src/email.js': `import { formatPrice } from './money.js';

export function orderEmail(order) {
  return \`Hi \${order.name}, your order total is \${formatPrice(order.total, order.currency, order.locale)}.\`;
}
`,
  'src/report.js': `import { formatPrice } from './money.js';

export function germanColumn(rows) {
  return rows.map(row => formatPrice(row.amount, undefined, 'de'));
}
`,
  'src/admin/refunds.js': `import { formatPrice, parsePrice } from '../money.js';

export function refundLine(refund) {
  return \`refund #\${refund.id}: \${formatPrice(-refund.amount, refund.currency)}\`;
}

export function parseRefund(text) {
  return parsePrice(text);
}
`,
  'src/admin/payouts.js': `import { formatPrice } from '../money.js';

export function payoutLines(payouts) {
  return payouts.map(p => \`\${p.to}: \${formatPrice(p.amount, 'EUR')}\`);
}
`,
  'src/widgets/badge.js': `import { formatPrice } from '../money.js';

export function priceBadge(price) {
  return \`[\${formatPrice(price, 'JPY')}]\`;
}
`,
  'src/widgets/ticker.js': `import { formatPrice } from '../money.js';

export function tick(value, currency) {
  return formatPrice(value, currency, 'en');
}
`,
  'test/money.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, parsePrice } from '../src/money.js';

test('formats', () => {
  assert.equal(formatPrice(1234.5), '$1,234.50');
});

test('parses', () => {
  assert.deepEqual(parsePrice('£12.00'), { amount: 12, currency: 'GBP' });
});
`,
};
const setupMoney = (ws: string) => writeFiles(ws, nodeProject('shop', MONEY_FILES));

const MONEY_PROBE = `{
  invoice: m.invoice.invoiceLine({ name: 'Mug', qty: 3, price: 1499.5, currency: 'EUR' }),
  invoiceDefault: m.invoice.invoiceLine({ name: 'Pen', qty: 2, price: 1.25 }),
  cart: m.cart.cartSummary([{ price: 1200, qty: 2 }, { price: 3.333, qty: 3 }]),
  receipt: m.receipt.receiptFooter(1234567.891),
  email: m.email.orderEmail({ name: 'Ana', total: 2500, currency: 'EUR', locale: 'de' }),
  emailDefault: m.email.orderEmail({ name: 'Bo', total: 99.999 }),
  report: m.report.germanColumn([{ amount: 1000 }, { amount: -5.5 }]),
  refund: m.refunds.refundLine({ id: 7, amount: 15.25, currency: 'GBP' }),
  parse: [m.refunds.parseRefund('1.234,50 €'), m.refunds.parseRefund('$9,999.99')],
  payouts: m.payouts.payoutLines([{ to: 'acme', amount: 1000000 }]),
  badge: m.badge.priceBadge(5000),
  tick: [m.ticker.tick(42, 'USD'), m.ticker.tick(42, undefined)],
}`;

/** A probe module (outside the workspace) that imports every caller. */
async function moneyProbe(root: string): Promise<string> {
  return withTempDir('money-probe', async (dir) => {
    const url = (rel: string) => JSON.stringify(pathToFileURL(path.join(root, rel)).href);
    await writeFiles(dir, {
      'probe.mjs': `const m = {
  invoice: await import(${url('src/invoice.js')}),
  cart: await import(${url('src/cart.js')}),
  receipt: await import(${url('src/receipt.js')}),
  email: await import(${url('src/email.js')}),
  report: await import(${url('src/report.js')}),
  refunds: await import(${url('src/admin/refunds.js')}),
  payouts: await import(${url('src/admin/payouts.js')}),
  badge: await import(${url('src/widgets/badge.js')}),
  ticker: await import(${url('src/widgets/ticker.js')}),
};
console.log(JSON.stringify(${MONEY_PROBE}));
`,
    });
    const result = await run('node', [path.join(dir, 'probe.mjs')], dir);
    return result.code === 0 ? result.stdout.trim() : `ERROR ${result.stderr.trim().split('\n').slice(0, 3).join(' ')}`;
  });
}

const MONEY_HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as money from '@ws/src/money/index.js';
import * as format from '@ws/src/money/format.js';
import * as parse from '@ws/src/money/parse.js';

test('new options signature', () => {
  assert.equal(money.formatPrice(1234.5), '$1,234.50');
  assert.equal(money.formatPrice(1234.5, { currency: 'EUR', locale: 'de' }), '1.234,50 €');
  assert.equal(money.formatPrice(3, { locale: 'de' }), '3,00 $');
  assert.equal(money.formatPrice(-2, { currency: 'GBP' }), '-£2.00');
  assert.equal(money.formatPrice(10, { currency: 'CHF' }), 'CHF 10.00');
  assert.equal(money.formatPrice(10, {}), '$10.00');
});
test('index re-exports the split modules', () => {
  assert.equal(money.formatPrice, format.formatPrice);
  assert.equal(money.parsePrice, parse.parsePrice);
  assert.equal(typeof money.roundCents, 'function');
  assert.equal(money.roundCents(1.234), 1.23);
});
test('parse still works', () => {
  assert.deepEqual(money.parsePrice('1.234,50 €'), { amount: 1234.5, currency: 'EUR' });
  assert.deepEqual(money.parsePrice('£12.00'), { amount: 12, currency: 'GBP' });
});
`;

const MONEY_FORMAT_JS = `import { SYMBOLS } from './symbols.js';

/** formatPrice(amount, { currency = 'USD', locale = 'en' } = {}) → "$1,234.50" / "1.234,50 €". */
export function formatPrice(amount, { currency = 'USD', locale = 'en' } = {}) {
  const symbol = SYMBOLS[currency] ?? \`\${currency} \`;
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.');
  const group = locale === 'de' ? '.' : ',';
  const decimal = locale === 'de' ? ',' : '.';
  const digits = \`\${whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, group)}\${decimal}\${cents}\`;
  const sign = amount < 0 ? '-' : '';
  return locale === 'de' ? \`\${sign}\${digits} \${symbol.trim()}\` : \`\${sign}\${symbol}\${digits}\`;
}
`;
const MONEY_PARSE_JS = `import { SYMBOLS } from './symbols.js';

/** Parse "$1,234.50" or "1.234,50 €" back into { amount, currency }. */
export function parsePrice(text) {
  const trimmed = String(text).trim();
  const currency = Object.keys(SYMBOLS).find(code => trimmed.includes(SYMBOLS[code])) ?? 'USD';
  const german = /,\\d{2}(?:\\s*\\S*)$/.test(trimmed);
  const digits = trimmed.replace(/[^\\d,.-]/g, '');
  const normalized = german ? digits.replace(/\\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  return { amount: Number(normalized), currency };
}

export function roundCents(amount) {
  return Math.round(amount * 100) / 100;
}
`;

const splitMoney: BenchTask = {
  id: 'hard-split-money',
  category: 'hard',
  title: 'split a module into a package and change a signature used in 10 call sites (hidden tests)',
  prompt: [
    [
      'Refactor the money helpers:',
      '1. Split src/money.js into src/money/format.js (formatPrice) and src/money/parse.js (parsePrice and roundCents), with src/money/index.js re-exporting all three. Delete src/money.js and update every import.',
      "2. Change formatPrice(amount, currency, locale) to formatPrice(amount, { currency = 'USD', locale = 'en' } = {}) and update every caller.",
      'Behaviour must not change anywhere, and npm test must pass.',
    ].join('\n'),
  ],
  timeoutMs: 900_000,
  setup: setupMoney,
  async score(ws) {
    const expected = await withTempDir('money-pristine', async (dir) => {
      await setupMoney(dir);
      return moneyProbe(dir);
    });
    const actual = await moneyProbe(ws);
    const hidden = await runHiddenTest(ws, 'money', MONEY_HIDDEN);
    const tests = await run('node', ['--test'], ws);
    const stale = (await run('grep', ['-rlE', "from '(\\.\\./|\\./)+money\\.js'", 'src', 'test'], ws)).stdout.trim();
    return checks([
      ['src/money.js deleted', !exists(ws, 'src/money.js')],
      ['src/money/{index,format,parse}.js exist', ['index', 'format', 'parse'].every(name => exists(ws, `src/money/${name}.js`))],
      ['hidden tests (new signature, re-exports) pass', hidden.code === 0],
      [`every caller behaves exactly as before${actual === expected ? '' : ` (got ${actual.slice(0, 160)})`}`, actual === expected],
      [`no import of money.js left${stale ? ` (${stale.replace(/\n/g, ', ')})` : ''}`, stale === ''],
      ['npm test passes', tests.code === 0],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: "grep -rn 'formatPrice(\\|money.js' src test" } }],
      [
        { name: 'write_file', input: { path: 'src/money/symbols.js', content: "export const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };\n" } },
        { name: 'write_file', input: { path: 'src/money/format.js', content: MONEY_FORMAT_JS } },
        { name: 'write_file', input: { path: 'src/money/parse.js', content: MONEY_PARSE_JS } },
        { name: 'write_file', input: { path: 'src/money/index.js', content: "export { formatPrice } from './format.js';\nexport { parsePrice, roundCents } from './parse.js';\n" } },
      ],
      [{
        name: 'bash',
        input: {
          command: [
            'rm src/money.js',
            "perl -pi -e \"s#from '\\./money\\.js'#from './money/index.js'#; s#from '\\.\\./money\\.js'#from '../money/index.js'#; s#from '\\.\\./src/money\\.js'#from '../src/money/index.js'#\" src/*.js src/admin/*.js src/widgets/*.js test/money.test.js",
          ].join(' && '),
        },
      }],
      [
        { name: 'edit_file', input: { path: 'src/invoice.js', old_string: 'formatPrice(item.price * item.qty, item.currency)', new_string: 'formatPrice(item.price * item.qty, { currency: item.currency })' } },
        { name: 'edit_file', input: { path: 'src/cart.js', old_string: "formatPrice(total * 0.92, 'EUR', 'de')", new_string: "formatPrice(total * 0.92, { currency: 'EUR', locale: 'de' })" } },
        { name: 'edit_file', input: { path: 'src/receipt.js', old_string: "formatPrice(amount, 'GBP')", new_string: "formatPrice(amount, { currency: 'GBP' })" } },
        { name: 'edit_file', input: { path: 'src/email.js', old_string: 'formatPrice(order.total, order.currency, order.locale)', new_string: 'formatPrice(order.total, { currency: order.currency, locale: order.locale })' } },
        { name: 'edit_file', input: { path: 'src/report.js', old_string: "formatPrice(row.amount, undefined, 'de')", new_string: "formatPrice(row.amount, { locale: 'de' })" } },
        { name: 'edit_file', input: { path: 'src/admin/refunds.js', old_string: 'formatPrice(-refund.amount, refund.currency)', new_string: 'formatPrice(-refund.amount, { currency: refund.currency })' } },
        { name: 'edit_file', input: { path: 'src/admin/payouts.js', old_string: "formatPrice(p.amount, 'EUR')", new_string: "formatPrice(p.amount, { currency: 'EUR' })" } },
        { name: 'edit_file', input: { path: 'src/widgets/badge.js', old_string: "formatPrice(price, 'JPY')", new_string: "formatPrice(price, { currency: 'JPY' })" } },
        { name: 'edit_file', input: { path: 'src/widgets/ticker.js', old_string: "formatPrice(value, currency, 'en')", new_string: "formatPrice(value, { currency, locale: 'en' })" } },
      ],
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -5' } }],
    ],
    reply: 'Split src/money.js into src/money/format.js and src/money/parse.js (shared SYMBOLS in symbols.js), with src/money/index.js re-exporting formatPrice, parsePrice and roundCents. formatPrice now takes { currency, locale }; all 10 call sites updated (an explicit `undefined` currency became just `{ locale }`). npm test passes.',
  }],
};

// ---------------------------------------------------------------------------
// hard-precise-edit: two lines in a ~3,000-line checksummed file

const REGISTRY_TARGET = 'svc-0217';
const REGISTRY_LINES = (() => {
  const random = prng(2026);
  const regions = ['eu-west', 'eu-central', 'us-east', 'us-west', 'ap-south'];
  const places = ['Zürich gateway', 'São Paulo edge', 'Kraków batch', 'Malmö relay'];
  const lines = [
    '// Service registry. Generated once, hand-maintained since.',
    '// Checksummed by deploy/verify.sh: keep formatting exactly as it is.',
    "export const VERSION = '7.3.1';",
    '',
    'export const SERVICES = [',
  ];
  for (let i = 1; i <= 372; i++) {
    const id = `svc-${String(i).padStart(4, '0')}`;
    const name = i % 41 === 0 ? places[(i / 41) % places.length]! : `Service ${String(i).padStart(4, '0')}`;
    const forced = id === REGISTRY_TARGET || id === 'svc-0271';
    const timeout = forced ? 3000 : [3000, 3000, 3000, 5000, 2500][Math.floor(random() * 5)]!;
    const retries = 1 + Math.floor(random() * 4);
    const tags = random() < 0.5 ? "'core'" : "'edge', 'beta'";
    lines.push(
      '  {',
      `    id: '${id}',`,
      `    name: '${name}',${i % 17 === 0 ? '   ' : ''}`,
      `    region: '${regions[Math.floor(random() * regions.length)]}',`,
      `    timeout: ${timeout},`,
      i % 23 === 0 ? `    retries: ${retries},\t// tuned by hand` : `    retries: ${retries},`,
      `    tags: [${tags}],`,
      '  },',
    );
  }
  lines.push('];', '', `// ${REGISTRY_TARGET} and svc-0271 are easy to confuse; check the id twice.`, 'export default SERVICES;');
  return lines;
})();
// No trailing newline at EOF, on purpose.
const REGISTRY = REGISTRY_LINES.join('\n');
const REGISTRY_BLOCK_START = REGISTRY_LINES.indexOf(`    id: '${REGISTRY_TARGET}',`);
const REGISTRY_OLD_BLOCK = REGISTRY_LINES.slice(REGISTRY_BLOCK_START, REGISTRY_BLOCK_START + 4).join('\n');
const REGISTRY_NEW_BLOCK = REGISTRY_OLD_BLOCK.replace('timeout: 3000,', 'timeout: 4500,');
const REGISTRY_EXPECTED = REGISTRY.replace(REGISTRY_OLD_BLOCK, REGISTRY_NEW_BLOCK).replace("VERSION = '7.3.1'", "VERSION = '7.3.2'");

const preciseEdit: BenchTask = {
  id: 'hard-precise-edit',
  category: 'hard',
  title: 'change two lines in a ~3,000-line file; every other byte must survive',
  prompt: [
    `In data/registry.js, set the timeout of service ${REGISTRY_TARGET} to 4500 and bump VERSION to 7.3.2. Change nothing else: our deploy checksums this file, so every other byte (whitespace included) must stay exactly as it is.`,
  ],
  timeoutMs: 600_000,
  setup: ws => writeFiles(ws, {
    'data/registry.js': REGISTRY,
    'README.md': '# registry\n\n`data/registry.js` is verified byte-for-byte at deploy time.\n',
  }),
  async score(ws) {
    const content = await readText(ws, 'data/registry.js');
    if (content === null) return fail('data/registry.js missing');
    const got = content.split('\n');
    const want = REGISTRY_EXPECTED.split('\n');
    const firstDiff = want.findIndex((line, i) => got[i] !== line);
    return checks([
      [`file is byte-identical to the expected edit${content === REGISTRY_EXPECTED ? '' : ` (${got.length} vs ${want.length} lines, first difference at line ${firstDiff === -1 ? want.length + 1 : firstDiff + 1})`}`, content === REGISTRY_EXPECTED],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: `grep -n "${REGISTRY_TARGET}\\|VERSION" data/registry.js` } }],
      [
        { name: 'edit_file', input: { path: 'data/registry.js', old_string: REGISTRY_OLD_BLOCK, new_string: REGISTRY_NEW_BLOCK } },
        { name: 'edit_file', input: { path: 'data/registry.js', old_string: "export const VERSION = '7.3.1';", new_string: "export const VERSION = '7.3.2';" } },
      ],
    ],
    reply: `Set ${REGISTRY_TARGET}'s timeout to 4500 and VERSION to 7.3.2; nothing else in data/registry.js changed.`,
  }],
};

// ---------------------------------------------------------------------------
// hard-date-bug: "fix the date bug" — find it by reading, don't ask

const DATE_FILES: Record<string, string> = {
  'src/dates.js': `const DAY_MS = 24 * 60 * 60 * 1000;

/** New date \`n\` days after \`date\` (does not mutate). */
export function addDays(date, n) {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

/** Whole calendar days from a to b (negative when b is earlier). */
export function daysBetween(a, b) {
  const start = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const end = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((end - start) / DAY_MS);
}

/** YYYY-MM-DD in local time. getMonth() is 0-based, hence the + 1. */
export function formatISODate(date) {
  const pad = n => String(n).padStart(2, '0');
  return \`\${date.getFullYear()}-\${pad(date.getMonth() + 1)}-\${pad(date.getDate())}\`;
}

/** Saturday or Sunday. */
export function isWeekend(date) {
  const day = date.getDay();
  return day === 6 || day === 7;
}

// TODO(tz): accept an IANA timezone once the scheduler needs one.
/** First day of the month, local midnight. */
export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
`,
  'src/pricing.js': `import { isWeekend } from './dates.js';

/** Weekend bookings cost 20% more. */
export function nightlyRate(date, base) {
  return isWeekend(date) ? Math.round(base * 120) / 100 : base;
}
`,
  'src/strings.js': `// Looks odd but is intentional: only ASCII spaces are trimmed (tabs are data here).
export function trimSpaces(text) {
  return String(text).replace(/^ +| +$/g, '');
}

export function initials(name) {
  return String(name).split(/\\s+/).filter(Boolean).map(part => part[0].toUpperCase()).join('');
}
`,
  'src/money.js': `export function toCents(amount) {
  return Math.round(amount * 100);
}
`,
  'test/dates.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, formatISODate, isWeekend } from '../src/dates.js';

test('addDays', () => {
  assert.equal(formatISODate(addDays(new Date(2026, 0, 30), 3)), '2026-02-02');
});

test('weekend', () => {
  assert.equal(isWeekend(new Date(2026, 9, 3)), true); // Saturday
  assert.equal(isWeekend(new Date(2026, 9, 7)), false); // Wednesday
});
`,
  'test/strings.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimSpaces, initials } from '../src/strings.js';

test('strings', () => {
  assert.equal(trimSpaces('  a b  '), 'a b');
  assert.equal(initials('ada  lovelace'), 'AL');
});
`,
};
const setupDates = (ws: string) => writeFiles(ws, nodeProject('bookings', DATE_FILES));

const DATE_HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, formatISODate, isWeekend, startOfMonth } from '@ws/src/dates.js';
import { nightlyRate } from '@ws/src/pricing.js';

test('sunday is a weekend day', () => {
  assert.equal(isWeekend(new Date(2026, 9, 4)), true);
  assert.equal(isWeekend(new Date(2026, 9, 3)), true);
  for (const day of [5, 6, 7, 8, 9]) assert.equal(isWeekend(new Date(2026, 9, day)), false);
  assert.equal(nightlyRate(new Date(2026, 9, 4), 100), 120);
  assert.equal(nightlyRate(new Date(2026, 9, 5), 100), 100);
});
test('the rest still works', () => {
  const start = new Date(2026, 1, 27);
  assert.equal(formatISODate(addDays(start, 2)), '2026-03-01');
  assert.equal(formatISODate(start), '2026-02-27');
  assert.equal(daysBetween(new Date(2026, 0, 1), new Date(2026, 11, 31)), 364);
  assert.equal(daysBetween(new Date(2026, 2, 1), new Date(2026, 1, 1)), -28);
  assert.equal(formatISODate(startOfMonth(new Date(2026, 6, 19))), '2026-07-01');
  const d = new Date(2026, 4, 5);
  addDays(d, 10);
  assert.equal(formatISODate(d), '2026-05-05');
});
`;

const dateBug: BenchTask = {
  id: 'hard-date-bug',
  category: 'hard',
  title: '"fix the date bug" — the one real bug must be found by inspection, not by asking',
  prompt: ['There is a date bug somewhere in this project. Please fix it.'],
  timeoutMs: 600_000,
  setup: setupDates,
  async score(ws) {
    const hidden = await runHiddenTest(ws, 'dates', DATE_HIDDEN);
    const tests = await run('node', ['--test'], ws);
    const changed = await changedSeedFiles(ws, setupDates, ['src/dates.js', 'test/dates.test.js']);
    return checks([
      ['hidden date tests pass (Sunday is a weekend day; nothing else broke)', hidden.code === 0],
      ['npm test passes', tests.code === 0],
      [`only the date code changed${changed.length ? ` (also changed: ${changed.join(', ')})` : ''}`, changed.length === 0],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'read_file', input: { path: 'src/dates.js' } }],
      [{ name: 'edit_file', input: { path: 'src/dates.js', old_string: 'return day === 6 || day === 7;', new_string: 'return day === 0 || day === 6;' } }],
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -4' } }],
    ],
    reply: 'The bug was in isWeekend (src/dates.js): getDay() returns 0 for Sunday, but the code checked for 7, so Sundays never counted as weekend days (and nightlyRate skipped the weekend surcharge on Sundays). It now checks 0 or 6.',
  }],
};

// ---------------------------------------------------------------------------
// hard-three-bugs: one failing suite, three independent root causes

const CHECKOUT_FILES: Record<string, string> = {
  'src/cart.js': `/** Sum of price × qty (qty defaults to 1). */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`,
  'src/coupons.js': `/**
 * Apply a coupon: { minSpend, off } takes a fixed amount off, { minSpend, percent }
 * a percentage. A coupon applies when the amount reaches minSpend.
 */
export function applyCoupon(amount, coupon) {
  if (!coupon || amount <= coupon.minSpend) return amount;
  const discounted = coupon.percent ? amount * (1 - coupon.percent / 100) : amount - coupon.off;
  return Math.max(0, Math.round(discounted * 100) / 100);
}
`,
  'src/tax.js': `const RATES = { de: 0.19, fr: 0.2, gb: 0.2, us: 0 };

/** VAT for an amount in a country (ISO code, any case). */
export function taxFor(amount, country) {
  return Math.round(amount * RATES[country] * 100) / 100;
}
`,
  'src/checkout.js': `import { subtotal } from './cart.js';
import { applyCoupon } from './coupons.js';
import { taxFor } from './tax.js';

export function checkoutTotal(items, { coupon, country }) {
  const net = applyCoupon(subtotal(items), coupon);
  return Math.round((net + taxFor(net, country)) * 100) / 100;
}
`,
  'test/cart.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal } from '../src/cart.js';

test('subtotal counts quantities', () => {
  assert.equal(subtotal([{ price: 10, qty: 3 }, { price: 5 }]), 35);
});
`,
  'test/coupons.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon } from '../src/coupons.js';

test('coupon applies at exactly the minimum spend', () => {
  assert.equal(applyCoupon(50, { minSpend: 50, off: 10 }), 40);
});

test('coupon does not apply below it', () => {
  assert.equal(applyCoupon(49.99, { minSpend: 50, off: 10 }), 49.99);
});
`,
  'test/tax.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taxFor } from '../src/tax.js';

test('country codes are case-insensitive', () => {
  assert.equal(taxFor(100, 'DE'), 19);
  assert.equal(taxFor(100, 'de'), 19);
});
`,
  'test/checkout.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutTotal } from '../src/checkout.js';

test('end to end', () => {
  const items = [{ price: 20, qty: 2 }, { price: 10 }];
  assert.equal(checkoutTotal(items, { coupon: { minSpend: 50, percent: 10 }, country: 'FR' }), 54);
});
`,
};
const setupCheckout = (ws: string) => writeFiles(ws, nodeProject('checkout', CHECKOUT_FILES));

const CHECKOUT_HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal } from '@ws/src/cart.js';
import { applyCoupon } from '@ws/src/coupons.js';
import { taxFor } from '@ws/src/tax.js';
import { checkoutTotal } from '@ws/src/checkout.js';

test('cart', () => {
  assert.equal(subtotal([]), 0);
  assert.equal(subtotal([{ price: 2.5, qty: 4 }]), 10);
  assert.equal(subtotal([{ price: 7 }, { price: 1, qty: 0 }]), 7);
});
test('coupons', () => {
  assert.equal(applyCoupon(80, { minSpend: 80, percent: 25 }), 60);
  assert.equal(applyCoupon(79.99, { minSpend: 80, percent: 25 }), 79.99);
  assert.equal(applyCoupon(5, { minSpend: 0, off: 10 }), 0);
  assert.equal(applyCoupon(30, undefined), 30);
});
test('tax', () => {
  assert.equal(taxFor(50, 'Fr'), 10);
  assert.equal(taxFor(50, 'GB'), 10);
  assert.equal(taxFor(50, 'us'), 0);
});
test('checkout', () => {
  assert.equal(checkoutTotal([{ price: 25, qty: 2 }], { coupon: { minSpend: 50, off: 5 }, country: 'DE' }), 53.55);
});
`;

const threeBugs: BenchTask = {
  id: 'hard-three-bugs',
  category: 'hard',
  title: 'one red suite, three independent bugs in three files (hidden tests; tests must stay untouched)',
  prompt: ['npm test is failing. Get the whole suite green without changing the tests.'],
  timeoutMs: 600_000,
  setup: setupCheckout,
  async score(ws) {
    const hidden = await runHiddenTest(ws, 'checkout', CHECKOUT_HIDDEN);
    const tests = await run('node', ['--test'], ws);
    const failing = /(?:#|ℹ) fail (\d+)/.exec(hidden.stdout)?.[1];
    const changed = await changedSeedFiles(ws, setupCheckout, ['src/cart.js', 'src/coupons.js', 'src/tax.js', 'src/checkout.js']);
    return checks([
      ['npm test passes', tests.code === 0],
      [`hidden tests pass${failing && failing !== '0' ? ` (${failing} failing)` : ''}`, hidden.code === 0],
      [`tests untouched${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`, changed.length === 0],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: 'npm test 2>&1 | grep -E "not ok|expected|actual" | head -30' } }],
      [
        { name: 'edit_file', input: { path: 'src/cart.js', old_string: 'sum + item.price, 0', new_string: 'sum + item.price * (item.qty ?? 1), 0' } },
        { name: 'edit_file', input: { path: 'src/coupons.js', old_string: 'amount <= coupon.minSpend', new_string: 'amount < coupon.minSpend' } },
        { name: 'edit_file', input: { path: 'src/tax.js', old_string: 'RATES[country]', new_string: 'RATES[String(country).toLowerCase()]' } },
      ],
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -8' } }],
    ],
    reply: 'Three separate bugs: subtotal ignored qty, coupons required spending more than the minimum instead of at least it, and taxFor looked up country codes case-sensitively. Fixed all three in src/; tests unchanged and the suite is green.',
  }],
};

export const HARD_CODE_TASKS: BenchTask[] = [
  renameMostCalled,
  envReport,
  vendorOffline,
  splitMoney,
  preciseEdit,
  dateBug,
  threeBugs,
];

/** Exposed for tests. */
export const HARD_CODE_FIXTURES = {
  EXPECTED_REPORT, REGISTRY, REGISTRY_EXPECTED, MONEY_FORMAT_JS, MONEY_PARSE_JS,
};
