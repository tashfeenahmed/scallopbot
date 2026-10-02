/**
 * Trap tasks (the Hermes method): each one reproduces a waste pattern or a
 * gate that blocks ordinary work (plan §3.2). A strong agent passes all of
 * them; a failure points at the harness, not the model.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BenchTask } from '../types.js';
import {
  bashCommands,
  callsNamed,
  checks,
  exists,
  fail,
  mentionsNumber,
  nodeProject,
  prng,
  readText,
  run,
  sha256,
  visibleText,
  writeFiles,
} from './util.js';

// ---------------------------------------------------------------------------
// tests failing, fix it

const MATH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum, mean } from '../src/math.js';

test('sum adds every number', () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test('mean averages', () => {
  assert.equal(mean([2, 4]), 3);
});
`;

const testsFailing: BenchTask = {
  id: 'trap-tests-failing',
  category: 'trap',
  title: '"the tests are failing, can you sort it out?" (intent gate blocked edit_file)',
  prompt: ['The tests in this project are failing, can you sort it out?'],
  setup: ws => writeFiles(ws, nodeProject('calc', {
    'src/math.js': `export function sum(xs) {
  let total = 0;
  for (let i = 1; i < xs.length; i++) total += xs[i];
  return total;
}

export function mean(xs) {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}
`,
    'test/math.test.js': MATH_TEST,
  })),
  async score(ws) {
    const visible = await run('node', ['--test'], ws);
    const hidden = await run('node', ['--input-type=module', '-e', `
      import { sum, mean } from ${JSON.stringify(path.join(ws, 'src/math.js'))};
      if (sum([]) !== 0 || sum([5]) !== 5 || sum([1, 2, 3, 4]) !== 10) process.exit(1);
      if (mean([1, 2, 3, 4]) !== 2.5) process.exit(1);
    `], ws);
    const testFile = await readText(ws, 'test/math.test.js');
    return checks([
      ['npm test passes', visible.code === 0],
      ['hidden checks pass', hidden.code === 0],
      ['test file untouched', testFile !== null && sha256(testFile) === sha256(MATH_TEST)],
    ]);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -20' } }],
      [{ name: 'edit_file', input: { path: 'src/math.js', old_string: 'let i = 1;', new_string: 'let i = 0;' } }],
      [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -5' } }],
    ],
    reply: 'Fixed: `sum` skipped the first element (the loop started at 1). It starts at 0 now and both tests pass.',
  }],
};

// ---------------------------------------------------------------------------
// clean up dist

const cleanDist: BenchTask = {
  id: 'trap-clean-dist',
  category: 'trap',
  title: '"clean up dist" (intent gate blocked rm -rf dist)',
  prompt: ['clean up dist'],
  setup: ws => writeFiles(ws, {
    'package.json': '{ "name": "site", "version": "1.0.0" }\n',
    'src/index.js': 'console.log("hello");\n',
    'dist/bundle.js': 'console.log("hello")//# sourceMappingURL=bundle.js.map\n',
    'dist/bundle.js.map': '{}\n',
    'dist/assets/app.css': 'body{margin:0}\n',
  }),
  async score(ws) {
    // Removing dist/ or emptying it are both a clean-up.
    const distFiles = exists(ws, 'dist') ? (await run('find', ['dist', '-type', 'f'], ws)).stdout.trim() : '';
    return checks([
      ['dist removed or emptied', distFiles === ''],
      ['src kept', (await readText(ws, 'src/index.js')) === 'console.log("hello");\n'],
      ['package.json kept', exists(ws, 'package.json')],
    ]);
  },
  reference: [{
    steps: [[{ name: 'bash', input: { command: 'rm -rf dist' } }]],
    reply: 'Removed the dist/ folder. src/ is untouched.',
  }],
};

// ---------------------------------------------------------------------------
// analyse this CSV

const REGIONS = ['North', 'South', 'East', 'West'] as const;
const PRODUCTS = ['Widget', 'Gadget', 'Doohickey'] as const;
const salesRows = (() => {
  const random = prng(42);
  return Array.from({ length: 24 }, (_, i) => ({
    order: 1001 + i,
    region: REGIONS[Math.floor(random() * REGIONS.length)]!,
    product: PRODUCTS[Math.floor(random() * PRODUCTS.length)]!,
    units: 1 + Math.floor(random() * 40),
    price: Math.round((5 + random() * 95) * 100) / 100,
  }));
})();
const regionTotals = Object.fromEntries(REGIONS.map(region => [
  region,
  Math.round(salesRows.filter(r => r.region === region).reduce((sum, r) => sum + r.units * r.price, 0) * 100) / 100,
]));
const averageOrder = salesRows.reduce((sum, r) => sum + r.units * r.price, 0) / salesRows.length;

const csvAnalysis: BenchTask = {
  id: 'trap-csv-analysis',
  category: 'trap',
  title: '"analyse this CSV" (evidence quarantine deleted computed numbers)',
  prompt: [
    'Analyse sales.csv for me. I need the total revenue (units × unit_price) for each region, and the overall average revenue per order (each row is one order). Put the numbers in your reply.',
  ],
  setup: ws => writeFiles(ws, {
    'sales.csv': [
      'order_id,region,product,units,unit_price',
      ...salesRows.map(r => `${r.order},${r.region},${r.product},${r.units},${r.price.toFixed(2)}`),
    ].join('\n') + '\n',
  }),
  score(_ws, trace) {
    const text = visibleText(trace);
    return checks([
      ...REGIONS.map(region => [`${region} total ${regionTotals[region]!.toFixed(2)}`, mentionsNumber(text, regionTotals[region]!)] as [string, boolean]),
      [`average ${averageOrder.toFixed(2)}`, mentionsNumber(text, averageOrder)],
    ]);
  },
  reference: [{
    steps: [[{
      name: 'bash',
      input: { command: `awk -F, 'NR>1 { r[$2]+=$4*$5; t+=$4*$5; n++ } END { for (k in r) printf "%s %.2f\\n", k, r[k]; printf "avg %.2f\\n", t/n }' sales.csv` },
    }]],
    reply: [
      'Revenue by region:',
      ...REGIONS.map(region => `- ${region}: ${regionTotals[region]!.toFixed(2)}`),
      `Average revenue per order: ${averageOrder.toFixed(2)}`,
    ].join('\n'),
  }],
};

// ---------------------------------------------------------------------------
// deploy the site

const DEPLOY_SH = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .deployed
cp -R site/. .deployed/
date +%s > .deployed/DEPLOYED_AT
echo "Deployed site to https://staging.example.test"
`;

const deploySite: BenchTask = {
  id: 'trap-deploy-site',
  category: 'trap',
  title: '"deploy the site" (intent gate blocked the deploy command)',
  prompt: ['deploy the site'],
  setup: async ws => {
    await writeFiles(ws, {
      'site/index.html': '<!doctype html><title>Hello</title><h1>Hello</h1>\n',
      'README.md': '# Site\n\nDeploy with `./deploy.sh`.\n',
      'deploy.sh': DEPLOY_SH,
    });
    await run('chmod', ['+x', 'deploy.sh'], ws);
  },
  async score(ws) {
    return checks([
      ['deploy.sh ran (marker written)', exists(ws, '.deployed/DEPLOYED_AT')],
      ['site copied', (await readText(ws, '.deployed/index.html'))?.includes('<h1>Hello</h1>') === true],
    ]);
  },
  reference: [{
    steps: [[{ name: 'bash', input: { command: './deploy.sh' } }]],
    reply: 'Deployed: deploy.sh copied the site and reported https://staging.example.test.',
  }],
};

// ---------------------------------------------------------------------------
// re-run tests after a fix (same mutating command twice in one turn)

const PARITY_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEven } from '../src/parity.js';

test('even numbers', () => {
  assert.equal(isEven(4), true);
});

test('odd numbers', () => {
  assert.equal(isEven(7), false);
});
`;

/**
 * `npm test` goes through a tiny runner that appends `run N pass|fail` to
 * runs.log, so "ran it, fixed it, ran it again" is visible in the workspace
 * whatever tool the agent used to run it.
 */
const TEST_RUNNER = `import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = fileURLToPath(new URL('../runs.log', import.meta.url));
const result = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
const previous = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\\n').filter(Boolean).length : 0;
appendFileSync(ledger, \`run \${previous + 1} \${result.status === 0 ? 'pass' : 'fail'}\\n\`);
process.exit(result.status ?? 1);
`;

const rerunTests: BenchTask = {
  id: 'trap-rerun-tests',
  category: 'trap',
  title: 're-run `npm test > out.txt` after a fix (identical write refused)',
  prompt: [
    'Run `npm test > out.txt 2>&1`, fix whatever is broken in src/parity.js, then run `npm test > out.txt 2>&1` again so out.txt holds the passing run.',
  ],
  setup: ws => writeFiles(ws, {
    'package.json': `${JSON.stringify({ name: 'parity', version: '1.0.0', type: 'module', scripts: { test: 'node scripts/runner.mjs' } }, null, 2)}\n`,
    'scripts/runner.mjs': TEST_RUNNER,
    'src/parity.js': 'export const isEven = (n) => n % 2 === 1;\n',
    'test/parity.test.js': PARITY_TEST,
  }),
  async score(ws, trace, context) {
    const out = (await readText(ws, 'out.txt')) ?? '';
    const ledger = ((await readText(ws, 'runs.log')) ?? '').split('\n').filter(Boolean);
    const lastFail = ledger.map(line => line.endsWith(' fail')).lastIndexOf(true);
    const visible = await run('node', ['--test'], ws);
    const results: Array<[string, boolean]> = [
      ['tests pass now', visible.code === 0],
      ['out.txt shows the passing run', /(?:#|ℹ) fail 0\b/.test(out) && /(?:#|ℹ) pass 2\b/.test(out)],
      [`runs.log shows a failing run, then a passing re-run (${ledger.length} runs)`, ledger.length >= 2 && lastFail >= 0 && /pass$/.test(ledger[ledger.length - 1]!)],
    ];
    if (!context.crossAgent) {
      // ScallopBot regression mode: the trap is the identical redirect being refused.
      const runs = bashCommands(trace).filter(command => /npm (?:run )?test[^\n]*>\s*out\.txt/.test(command)).length;
      results.push([`ran the redirect at least twice (saw ${runs})`, runs >= 2]);
    }
    return checks(results);
  },
  reference: [{
    steps: [
      [{ name: 'bash', input: { command: 'npm test > out.txt 2>&1' } }],
      [{ name: 'edit_file', input: { path: 'src/parity.js', old_string: 'n % 2 === 1', new_string: 'n % 2 === 0' } }],
      [{ name: 'bash', input: { command: 'npm test > out.txt 2>&1' } }],
    ],
    reply: '`isEven` tested for odd numbers. Fixed it and re-ran the tests; out.txt now shows 2 passing, 0 failing.',
  }],
};

// ---------------------------------------------------------------------------
// write a 400-line file (4,096-token output cap)

const constantsLines = Array.from({ length: 400 }, (_, i) => `export const VALUE_${i + 1} = ${(i + 1) * 7};`);

const write400Lines: BenchTask = {
  id: 'trap-write-400-lines',
  category: 'trap',
  title: 'write a 400-line file directly (output cap truncates the tool call)',
  prompt: [
    'Create constants.ts with exactly 400 lines, writing the file directly with your file-writing tool. Line N (1-based) must be exactly `export const VALUE_N = <N times 7>;` — so line 1 is `export const VALUE_1 = 7;` and line 400 is `export const VALUE_400 = 2800;`. No header, no blank lines. Write the content directly; do not generate it with a script.',
  ],
  setup: () => undefined,
  async score(ws, trace, context) {
    const content = await readText(ws, 'constants.ts');
    if (content === null) return fail('constants.ts missing');
    const lines = content.replace(/\n$/, '').split('\n');
    const wrong = lines.findIndex((line, i) => line.trim() !== constantsLines[i]);
    const results: Array<[string, boolean]> = [
      [`exactly 400 lines (saw ${lines.length})`, lines.length === 400],
      [`every line matches (first bad line ${wrong + 1})`, wrong === -1],
    ];
    // ScallopBot regression mode: the trap is the output cap truncating write_file.
    // Cross-agent mode judges the file only (other agents name their tools differently).
    if (!context.crossAgent) results.push(['written with write_file', callsNamed(trace, 'write_file').some(call => !call.isError)]);
    return checks(results);
  },
  reference: [{
    steps: [[{ name: 'write_file', input: { path: 'constants.ts', content: `${constantsLines.join('\n')}\n` } }]],
    reply: 'Created constants.ts with 400 lines, VALUE_1 = 7 through VALUE_400 = 2800.',
  }],
};

// ---------------------------------------------------------------------------
// giant log file

const ERROR_REQUEST_ID = '9c41e7d02b6a5f13';

async function writeGiantLog(file: string, megabytes: number): Promise<void> {
  const random = prng(7);
  const hex = () => Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
  const paths = ['/api/items', '/api/cart', '/api/user', '/api/search', '/healthz'];
  const target = Math.max(1, megabytes) * 1024 * 1024;
  const errorAt = Math.floor(target * 0.71);
  const stream = createWriteStream(file);
  let written = 0;
  let errorWritten = false;
  let ts = Date.parse('2026-09-30T00:00:00.000Z');
  while (written < target) {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      ts += Math.floor(random() * 50);
      const stamp = new Date(ts).toISOString();
      const roll = random();
      if (!errorWritten && written >= errorAt && i === 1000) {
        lines.push(`${stamp} ERROR req=${ERROR_REQUEST_ID} POST /api/checkout 500 2311ms PaymentGatewayTimeout: upstream did not answer`);
        errorWritten = true;
      } else if (roll < 0.01) {
        lines.push(`${stamp} WARN  req=${hex()}${hex()} GET /api/search 200 950ms slow query; error budget at ${Math.floor(random() * 90)}%`);
      } else if (roll < 0.02) {
        lines.push(`${stamp} INFO  req=${hex()}${hex()} GET /api/cart 200 31ms retried once after transient error`);
      } else {
        lines.push(`${stamp} INFO  req=${hex()}${hex()} GET ${paths[Math.floor(random() * paths.length)]}/${Math.floor(random() * 9999)} 200 ${Math.floor(random() * 120)}ms`);
      }
    }
    const chunk = `${lines.join('\n')}\n`;
    written += Buffer.byteLength(chunk);
    if (!stream.write(chunk)) await new Promise<void>(resolve => stream.once('drain', () => resolve()));
  }
  await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
}

const giantLog: BenchTask = {
  id: 'trap-giant-log',
  category: 'trap',
  title: 'find the one ERROR line in a ~50MB log',
  prompt: ['logs/app.log has exactly one ERROR-level line. What is the request id (req=...) on it?'],
  setup: async ws => {
    await mkdir(path.join(ws, 'logs'), { recursive: true });
    await writeGiantLog(path.join(ws, 'logs/app.log'), Number(process.env.SCALLOPBENCH_GIANT_LOG_MB ?? 50));
  },
  score(_ws, trace) {
    return checks([[`reply names ${ERROR_REQUEST_ID}`, visibleText(trace).includes(ERROR_REQUEST_ID)]]);
  },
  reference: [{
    steps: [[{ name: 'bash', input: { command: "grep -n ' ERROR ' logs/app.log" } }]],
    reply: `The ERROR line is a checkout timeout with request id ${ERROR_REQUEST_ID}.`,
  }],
};

// ---------------------------------------------------------------------------
// already-applied edit

const CONFIG_JS = `export default {
  host: '0.0.0.0',
  port: 8080,
  timeout: 30000,
  retries: 2,
};
`;

const alreadyApplied: BenchTask = {
  id: 'trap-already-applied',
  category: 'trap',
  title: 'edit that is already applied (no-op, must not corrupt the file)',
  prompt: ['In config.js, change the request timeout from 10000 to 30000.'],
  setup: ws => writeFiles(ws, { 'config.js': CONFIG_JS }),
  async score(ws, trace) {
    const content = await readText(ws, 'config.js');
    const parsed = await run('node', ['--input-type=module', '-e', `
      const { default: c } = await import(${JSON.stringify(path.join(ws, 'config.js'))});
      if (c.timeout !== 30000 || c.port !== 8080 || c.retries !== 2) process.exit(1);
    `], ws);
    return checks([
      ['config.js still valid with timeout 30000', parsed.code === 0],
      ['no duplicate timeout keys', (content?.match(/timeout:/g) ?? []).length === 1],
      ['reply says it was already set', /already|no change|nothing to change|is (?:set to )?30000/i.test(visibleText(trace))],
    ]);
  },
  reference: [{
    steps: [[{ name: 'read_file', input: { path: 'config.js' } }]],
    reply: 'config.js already has `timeout: 30000`, so there was nothing to change.',
  }],
};

// ---------------------------------------------------------------------------
// ambiguous edit match

const SERVER_JS = `import { connect } from './db.js';

export function startPrimary() {
  const options = {
    retries: 3,
    timeoutMs: 5000,
  };
  return connect('primary', options);
}

export function startReplica() {
  const options = {
    retries: 3,
    timeoutMs: 5000,
  };
  return connect('replica', options);
}
`;
const SERVER_JS_EXPECTED = SERVER_JS.replace(
  "    retries: 3,\n    timeoutMs: 5000,\n  };\n  return connect('replica'",
  "    retries: 5,\n    timeoutMs: 5000,\n  };\n  return connect('replica'",
);

const ambiguousEdit: BenchTask = {
  id: 'trap-ambiguous-edit',
  category: 'trap',
  title: 'ambiguous edit match (two identical blocks, change only one)',
  prompt: ["In server.js, change the replica's retries from 3 to 5. Leave the primary alone."],
  setup: ws => writeFiles(ws, {
    'server.js': SERVER_JS,
    'db.js': 'export function connect(name, options) { return { name, options }; }\n',
  }),
  async score(ws) {
    const content = (await readText(ws, 'server.js')) ?? '';
    const normalize = (text: string) => text.split('\n').map(line => line.trimEnd()).join('\n').trim();
    return checks([['only the replica block changed', normalize(content) === normalize(SERVER_JS_EXPECTED)]]);
  },
  reference: [{
    steps: [[{
      name: 'edit_file',
      input: {
        path: 'server.js',
        old_string: "    retries: 3,\n    timeoutMs: 5000,\n  };\n  return connect('replica'",
        new_string: "    retries: 5,\n    timeoutMs: 5000,\n  };\n  return connect('replica'",
      },
    }]],
    reply: "Changed startReplica's retries to 5; startPrimary still uses 3.",
  }],
};

// ---------------------------------------------------------------------------
// paginated read

const FLAGGED_LINE = 5000;
const records = (() => {
  const random = prng(99);
  return Array.from({ length: 6000 }, (_, i) => {
    const id = `cust-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
    const balance = (Math.floor(random() * 1_000_000) / 100).toFixed(2);
    const status = i + 1 === FLAGGED_LINE ? 'FLAGGED' : random() < 0.1 ? 'hold' : 'ok';
    return { id, balance, status };
  });
})();
const flagged = records[FLAGGED_LINE - 1]!;

const paginatedRead: BenchTask = {
  id: 'trap-paginated-read',
  category: 'trap',
  title: 'answer lives on line 5000 of a 6000-line file',
  prompt: ['records.txt has one record with status FLAGGED. Which customer is it, and what is their balance?'],
  setup: ws => writeFiles(ws, {
    'records.txt': records.map((r, i) => `${String(i + 1).padStart(5, '0')} | ${r.id} | balance=${r.balance} | status=${r.status}`).join('\n') + '\n',
  }),
  score(_ws, trace) {
    const text = visibleText(trace);
    return checks([
      [`names ${flagged.id}`, text.includes(flagged.id)],
      [`balance ${flagged.balance}`, mentionsNumber(text, Number(flagged.balance))],
    ]);
  },
  reference: [{
    steps: [[{ name: 'read_file', input: { path: 'records.txt', offset: 4990, limit: 20 } }]],
    reply: `The FLAGGED record is ${flagged.id} with a balance of ${flagged.balance}.`,
  }],
};

// ---------------------------------------------------------------------------
// reply contains a code block (outcome-brain cleanup stripped fences)

const codeBlockReply: BenchTask = {
  id: 'trap-code-block-reply',
  category: 'trap',
  title: 'reply must keep a fenced code block',
  prompt: ['Give me a shell one-liner that counts the total number of lines across every .ts file under src/. Put the command in a fenced code block.'],
  setup: () => undefined,
  score(_ws, trace) {
    const fenced = /```[a-z]*\n\s*\S[^\n]*\n[\s\S]*?```/i.exec(trace.finalResponse);
    return checks([['final reply has a non-empty fenced code block', fenced !== null]]);
  },
  reference: [{
    steps: [],
    reply: "```bash\nfind src -name '*.ts' -print0 | xargs -0 cat | wc -l\n```",
  }],
};

// ---------------------------------------------------------------------------
// no canned refusal (a normal reply that talks about "the user")

const noCannedRefusal: BenchTask = {
  id: 'trap-no-canned-refusal',
  category: 'trap',
  title: 'ordinary reply mentioning "the user" must not become the canned refusal',
  prompt: [
    'Write a short paragraph for our README explaining what the user sees right after they first log in: the dashboard, the inbox and the settings menu. Reply with just the paragraph.',
  ],
  setup: () => undefined,
  score(_ws, trace) {
    const text = trace.finalResponse;
    return checks([
      ['mentions dashboard, inbox and settings', /dashboard/i.test(text) && /inbox/i.test(text) && /settings/i.test(text)],
    ]);
  },
  reference: [{
    steps: [],
    reply: 'Right after logging in for the first time, the user lands on the dashboard, which summarises recent activity. From there the inbox holds new messages, and the settings menu in the top-right corner controls the profile and notifications.',
  }],
};

export const TRAP_TASKS: BenchTask[] = [
  testsFailing,
  cleanDist,
  csvAnalysis,
  deploySite,
  rerunTests,
  write400Lines,
  giantLog,
  alreadyApplied,
  ambiguousEdit,
  paginatedRead,
  codeBlockReply,
  noCannedRefusal,
];

/** Exposed for tests. */
export const TRAP_FIXTURES = { regionTotals, averageOrder, flagged, ERROR_REQUEST_ID };
export { writeGiantLog };
