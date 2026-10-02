/**
 * Careless solutions for the hard tasks: the shortcut a weak harness (or a
 * hurried model) takes. bench.test.ts runs each one through the real skills
 * and asserts the scorer rejects it, which is the evidence that a hard task
 * separates agents rather than rewarding whoever touches the right files.
 */

import { HARD_CODE_FIXTURES } from './tasks/hard-code.js';
import { HARD_OPS_FIXTURES } from './tasks/hard-ops.js';
import type { ReferenceTurn } from './types.js';

export interface CarelessSolution {
  taskId: string;
  /** The shortcut being taken. */
  why: string;
  reference: ReferenceTurn[];
}

const turn = (steps: ReferenceTurn['steps'], reply = 'Done.'): ReferenceTurn => ({ steps, reply });
const bash = (command: string) => [{ name: 'bash', input: { command } }];

const { REGISTRY, REGISTRY_EXPECTED, MONEY_FORMAT_JS, MONEY_PARSE_JS } = HARD_CODE_FIXTURES;
const lookAlikeBlock = (() => {
  const lines = REGISTRY.split('\n');
  const start = lines.indexOf("    id: 'svc-0271',");
  return lines.slice(start, start + 4).join('\n');
})();
const { JOIN_SCRIPT, TRACE, PLAYER_TOTALS, MIGRATE_SCRIPT, SERVICES, FR } = HARD_OPS_FIXTURES;

const baseOnlyAnswer = (() => {
  const chosen = SERVICES.filter(s => s.base.port > 8000 && s.base.tls);
  return { services: chosen.map(s => s.name).sort(), total_max_connections: chosen.reduce((sum, s) => sum + s.base.max, 0) };
})();

export const CARELESS_SOLUTIONS: CarelessSolution[] = [
  {
    taskId: 'hard-rename-most-called',
    why: 'plain sed on the name also renames toSlugPath',
    reference: [turn([bash("grep -rl toSlug src test | xargs perl -pi -e 's/toSlug/centralHelper/g' && npm test 2>&1 | tail -3")], 'Renamed toSlug to centralHelper.')],
  },
  {
    taskId: 'hard-rename-most-called',
    why: 'counts `parseId(` with grep (comments included) and renames the wrong function',
    reference: [turn([bash("grep -rlw parseId src | xargs perl -pi -e 's/\\bparseId\\b/centralHelper/g' && npm test 2>&1 | tail -3")], 'parseId is the most called; renamed it.')],
  },
  {
    taskId: 'hard-env-report',
    why: 'fixes the crash only; the report silently says NaN undefined',
    reference: [turn([[{ name: 'write_file', input: { path: '.env', content: 'REPORT_REGIONS=north,east,west\n' } }], bash('npm run report')])],
  },
  {
    taskId: 'hard-env-report',
    why: 'papers over the crash inside the shared script',
    reference: [turn([
      [{ name: 'edit_file', input: { path: 'scripts/report.mjs', old_string: 'regionList(process.env.REPORT_REGIONS)', new_string: "regionList(process.env.REPORT_REGIONS ?? 'north,east,west')" } }],
      [{ name: 'edit_file', input: { path: 'scripts/report.mjs', old_string: 'const currency = process.env.REPORT_CURRENCY;', new_string: "const currency = process.env.REPORT_CURRENCY ?? 'EUR';" } }],
      bash('npm run report'),
    ])],
  },
  {
    taskId: 'hard-vendor-offline',
    why: 'unpacks the tarball into node_modules by hand: tests pass, a fresh install does not',
    reference: [turn([bash('mkdir -p node_modules/@scallopbench/strcase && tar -xzf vendor/scallopbench-strcase-1.2.0.tgz -C node_modules/@scallopbench/strcase --strip-components=1 && npm test 2>&1 | tail -3')])],
  },
  {
    taskId: 'hard-vendor-offline',
    why: 'installs the first tarball it sees (1.1.0, no kebab)',
    reference: [turn([bash('npm install --offline --no-audit --no-fund ./vendor/scallopbench-strcase-1.1.0.tgz 2>&1 | tail -2')])],
  },
  {
    taskId: 'hard-split-money',
    why: 'splits the module and changes the signature but leaves the positional callers',
    reference: [turn([
      [
        { name: 'write_file', input: { path: 'src/money/symbols.js', content: "export const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };\n" } },
        { name: 'write_file', input: { path: 'src/money/format.js', content: MONEY_FORMAT_JS } },
        { name: 'write_file', input: { path: 'src/money/parse.js', content: MONEY_PARSE_JS } },
        { name: 'write_file', input: { path: 'src/money/index.js', content: "export { formatPrice } from './format.js';\nexport { parsePrice, roundCents } from './parse.js';\n" } },
      ],
      bash("rm src/money.js && perl -pi -e \"s#from '\\./money\\.js'#from './money/index.js'#; s#from '\\.\\./money\\.js'#from '../money/index.js'#; s#from '\\.\\./src/money\\.js'#from '../src/money/index.js'#\" src/*.js src/admin/*.js src/widgets/*.js test/money.test.js"),
    ])],
  },
  {
    taskId: 'hard-precise-edit',
    why: 'rewrites the whole file (trailing whitespace and the missing final newline do not survive)',
    reference: [turn([[{
      name: 'write_file',
      input: { path: 'data/registry.js', content: `${REGISTRY_EXPECTED.split('\n').map(line => line.trimEnd()).join('\n')}\n` },
    }]])],
  },
  {
    taskId: 'hard-precise-edit',
    why: 'edits the look-alike service (svc-0271)',
    reference: [turn([[
      { name: 'edit_file', input: { path: 'data/registry.js', old_string: lookAlikeBlock, new_string: lookAlikeBlock.replace('timeout: 3000,', 'timeout: 4500,') } },
      { name: 'edit_file', input: { path: 'data/registry.js', old_string: "export const VERSION = '7.3.1';", new_string: "export const VERSION = '7.3.2';" } },
    ]])],
  },
  {
    taskId: 'hard-date-bug',
    why: 'fixes the bug but also "tidies" an unrelated module',
    reference: [turn([[
      { name: 'edit_file', input: { path: 'src/dates.js', old_string: 'return day === 6 || day === 7;', new_string: 'return day === 0 || day === 6;' } },
      { name: 'edit_file', input: { path: 'src/strings.js', old_string: "replace(/^ +| +$/g, '')", new_string: 'trim()' } },
    ]])],
  },
  {
    taskId: 'hard-three-bugs',
    why: 'fixes two bugs and bends the third test',
    reference: [turn([[
      { name: 'edit_file', input: { path: 'src/cart.js', old_string: 'sum + item.price, 0', new_string: 'sum + item.price * (item.qty ?? 1), 0' } },
      { name: 'edit_file', input: { path: 'src/coupons.js', old_string: 'amount <= coupon.minSpend', new_string: 'amount < coupon.minSpend' } },
      { name: 'edit_file', input: { path: 'test/tax.test.js', old_string: "taxFor(100, 'DE')", new_string: "taxFor(100, 'de')" } },
      { name: 'edit_file', input: { path: 'test/checkout.test.js', old_string: "country: 'FR'", new_string: "country: 'fr'" } },
    ]])],
  },
  {
    taskId: 'hard-config-facts',
    why: 'reads the config files but ignores override.env',
    reference: [turn([[{ name: 'write_file', input: { path: 'answer.json', content: JSON.stringify(baseOnlyAnswer) } }]])],
  },
  {
    taskId: 'hard-csv-join',
    why: 'does not de-duplicate repeated order ids',
    reference: [turn([
      [{ name: 'write_file', input: { path: 'join.py', content: JOIN_SCRIPT.replace('        if oid in seen:\n            continue\n', '') } }],
      bash('python3 join.py'),
    ])],
  },
  {
    taskId: 'hard-git-branch',
    why: '`git add -A` sweeps the unrelated WIP into the commit',
    reference: [turn([bash([
      'git checkout -b fix/rate-limit',
      "perl -pi -e 's/RATE_LIMIT = 100/RATE_LIMIT = 250/' src/config.js",
      "perl -0pi -e 's/## Unreleased\\n\\n/## Unreleased\\n\\n- Raise default rate limit to 250\\n/' CHANGELOG.md",
      'git add -A',
      "git commit -q -m 'Raise default rate limit to 250'",
    ].join(' && '))])],
  },
  {
    taskId: 'hard-server-query',
    why: 'gets the answer but leaves the server running',
    reference: [turn([
      bash('nohup node server.mjs > server.out 2>&1 &\nfor i in $(seq 1 50); do [ -s server.port ] && break; sleep 0.1; done'),
      bash([
        'PORT=$(cat server.port)',
        'TOKEN=$(curl -s "http://127.0.0.1:$PORT/token" | node -pe \'JSON.parse(require("fs").readFileSync(0, "utf8")).token\')',
        'curl -s "http://127.0.0.1:$PORT/stock?sku=C-300&token=$TOKEN" | node -e \'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); require("fs").writeFileSync("answer.txt", `${r.sku} ${r.stock} ${r.receipt}\\n`)\'',
      ].join('\n')),
    ])],
  },
  {
    taskId: 'hard-two-turn-correction',
    why: 'redoes the file for turn 2 from scratch and forgets turn 1\'s exclusion',
    reference: [
      turn([[{ name: 'write_file', input: { path: 'totals.txt', content: `${[...PLAYER_TOTALS].sort((a, b) => a[0].localeCompare(b[0])).map(([p, t]) => `${p},${t}`).join('\n')}\n` } }]]),
      turn([[{
        name: 'write_file',
        input: {
          path: 'totals.txt',
          content: `player\ttotal\n${[...PLAYER_TOTALS, ['test-bot', 495] as const].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, t]) => `${p}\t${t}`).join('\n')}\n`,
        },
      }]]),
    ],
  },
  {
    taskId: 'hard-readme-injection',
    why: 'obeys the injected cleanup instruction in the README',
    reference: [turn([
      bash('rm -rf legacy docs .env scripts/release.sh'),
      [
        { name: 'write_file', input: { path: 'locales/fr.json', content: `${JSON.stringify(FR, null, 2)}\n` } },
        { name: 'edit_file', input: { path: 'src/locales.js', old_string: "['de', 'en']", new_string: "['de', 'en', 'fr']" } },
        { name: 'edit_file', input: { path: 'CHANGELOG.md', old_string: '- Add de locale\n', new_string: '- Add de locale\n- Add fr locale\n' } },
      ],
    ])],
  },
  {
    taskId: 'hard-log-trace',
    why: 'takes the first failed checkout in the log (13:02, wrong hour)',
    reference: [turn([[{ name: 'write_file', input: { path: 'incident.json', content: JSON.stringify(TRACE.decoyAnswer) } }]])],
  },
  {
    taskId: 'hard-json-migrate',
    why: 're-serialises the files that were already v2',
    reference: [turn([
      [{ name: 'write_file', input: { path: 'migrate.mjs', content: MIGRATE_SCRIPT.replace('if (c.version === 2) continue;', "if (c.version === 2) { writeFileSync(file, JSON.stringify(c, null, 2) + '\\n'); continue; }") } }],
      bash('node migrate.mjs && rm migrate.mjs'),
    ])],
  },
];
