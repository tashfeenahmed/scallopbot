/**
 * Result ergonomics for bash: exit-code explanations, warnings when the
 * command's shape can hide a failure, and an HTTP hint for curl writes.
 *
 * Success is exit code 0, full stop. Output text that mentions "error" is
 * never treated as failure.
 */

import { constants as osConstants } from 'node:os';

const SIGNAL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(osConstants.signals).map(([name, num]) => [num, name]),
);

/** One-line explanation for a non-zero exit code (null for 0). */
export function explainExitCode(code: number): string | null {
  switch (code) {
    case 0: return null;
    case 1: return 'general error; read the output above for the cause';
    case 2: return 'misuse: bad arguments, invalid option, or a shell syntax error';
    case 124: return 'timed out (the `timeout` command killed it)';
    case 126: return 'found but not executable: check permissions (chmod +x) or that it is a binary/script for this platform';
    case 127: return 'command not found: install it, fix the spelling, or use the full path (check PATH)';
    case 130: return 'interrupted by SIGINT (Ctrl-C)';
    case 137: return 'killed by SIGKILL: usually out of memory (OOM killer) or an explicit kill -9';
    case 139: return 'segmentation fault (SIGSEGV): the program crashed';
    case 141: return 'SIGPIPE: the reader (head, grep -q, ...) closed the pipe early; usually harmless';
    case 143: return 'terminated by SIGTERM';
    default:
      if (code > 128 && code < 160) {
        const sig = SIGNAL_NAMES[code - 128];
        return `killed by signal ${code - 128}${sig ? ` (${sig})` : ''}`;
      }
      return 'command failed; read the output above for the cause';
  }
}

/** Exit code a shell reports for a process killed by `signal`. */
export function exitCodeForSignal(signal: NodeJS.Signals | string | null | undefined): number {
  if (!signal) return 1;
  const num = (osConstants.signals as Record<string, number>)[signal];
  return typeof num === 'number' ? 128 + num : 1;
}

/** Commands whose exit code is the point: tests, builds, type checks, linters. */
export const VERIFY_COMMAND_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check|tsc)\b`,
    String.raw`\b(?:npx|pnpx|bunx|pnpm\s+exec|yarn\s+exec|pnpm\s+dlx)\s+(?:vitest|jest|tsc|eslint|mocha|ruff|playwright\s+test)\b`,
    String.raw`(?:^|[\s;&|(])(?:vitest|jest|tsc|eslint|ruff|pytest|mypy|mocha)(?=\s|$)`,
    String.raw`\bpython\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b`,
    String.raw`\bgo\s+(?:test|vet|build)\b`,
    String.raw`\bcargo\s+(?:test|check|clippy|build)\b`,
    String.raw`\bmake\s+(?:test|check|lint)\b`,
  ].join('|'),
);

/** Left-hand commands that rarely fail in a way a pipe would hide. */
const SAFE_PIPE_SOURCES = new Set([
  'cat', 'echo', 'printf', 'ls', 'find', 'grep', 'rg', 'egrep', 'fgrep', 'ps', 'env', 'printenv',
  'history', 'sort', 'uniq', 'wc', 'head', 'tail', 'tree', 'du', 'df', 'awk', 'sed', 'cut', 'tr',
  'jq', 'yes', 'seq', 'date', 'git', 'docker', 'journalctl', 'dmesg', 'lsof', 'netstat', 'ss',
  'which', 'type', 'file', 'stat', 'xxd', 'od', 'strings', 'diff', 'column', 'less', 'more',
]);

function firstWord(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(t => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  while (tokens[0] === 'sudo' || tokens[0] === 'time' || tokens[0] === 'command') tokens.shift();
  return (tokens[0] ?? '').split('/').pop() ?? '';
}

/**
 * Warnings for command shapes that can make a failure look like exit 0:
 * `|| echo`, `|| true`, `; echo` after a test/build, and a pipe into
 * head/tail/grep without `set -o pipefail`.
 */
export function detectMaskingWarnings(command: string): string[] {
  const warnings: string[] = [];
  const fallback = command.match(/\|\|\s*(echo\b|true\b|:(?=\s|;|$)|exit\s+0\b|printf\b)/);
  if (fallback) {
    warnings.push(
      `\`|| ${fallback[1].trim()}\` turns a failure of the left side into exit 0, so the exit code above does not show whether it worked. Check the output, or drop the fallback.`,
    );
  }

  const semicolonEcho = command.match(/([^;&|\n]+);\s*echo\b/);
  if (semicolonEcho && VERIFY_COMMAND_RE.test(semicolonEcho[1])) {
    warnings.push(
      `\`; echo\` after \`${semicolonEcho[1].trim()}\` replaces its exit code with echo's. Use \`&&\`, or print \`$?\` to see the real result.`,
    );
  }

  if (!/set\s+-[A-Za-z]*o\s+pipefail|set\s+-o\s+pipefail|pipefail/.test(command)) {
    // Single pipes only (not ||); look for `X | head|tail|grep`.
    const pipeline = command.split(/&&|\|\||;|\n/);
    for (const part of pipeline) {
      const stages = part.split(/(?<!\|)\|(?!\|)/);
      if (stages.length < 2) continue;
      const last = firstWord(stages[stages.length - 1]);
      if (!['head', 'tail', 'grep', 'egrep', 'rg', 'less', 'more'].includes(last)) continue;
      const source = firstWord(stages[0]);
      if (SAFE_PIPE_SOURCES.has(source) && !VERIFY_COMMAND_RE.test(stages[0])) continue;
      warnings.push(
        `The exit code comes from \`${last}\`, the last stage of the pipe, so a failure of \`${stages[0].trim().slice(0, 60)}\` would be hidden. Prefix \`set -o pipefail;\` to get the real exit code.`,
      );
      break;
    }
  }
  return warnings;
}

/** True when the command hides its own exit code (verify runs then don't count as passing). */
export function exitCodeIsMasked(command: string): boolean {
  return detectMaskingWarnings(command).length > 0;
}

const MUTATING_CURL = /\bcurl\b[\s\S]*?(?:(?:-X|--request)\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|\s(?:--data(?:-raw|-binary|-urlencode)?|-d|--json|-F|--form|-T|--upload-file)[\s=])/i;
const CURL_FAIL_FLAG = /(?:^|\s)--fail(?:-with-body|-early)?(?=\s|$)|(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/;

/**
 * When a mutating curl without --fail exited 0 but its visible output shows an
 * HTTP 4xx/5xx (via -i, -v, or -w '%{http_code}'), return a one-line hint.
 */
export function curlHttpErrorHint(command: string, output: string, exitCode: number): string | null {
  if (exitCode !== 0) return null;
  if (!MUTATING_CURL.test(command) || CURL_FAIL_FLAG.test(command)) return null;
  let status: string | undefined;
  const statusLines = [...output.matchAll(/HTTP\/[\d.]+\s+(\d{3})\b/g)];
  if (statusLines.length > 0) status = statusLines[statusLines.length - 1][1];
  if (!status && /(?:-w|--write-out)\b/.test(command) && /http_code|response_code/.test(command)) {
    const m = output.match(/(?:^|[^\d])([1-5]\d\d)\s*$/) ?? output.match(/(?:http_code|status|code|HTTP)\D{0,3}([1-5]\d\d)\b/i);
    if (m) status = m[1];
  }
  if (!status || !/^[45]/.test(status)) return null;
  return `curl exited 0 but the server answered HTTP ${status}: the request failed. curl only exits non-zero on HTTP errors with --fail / --fail-with-body.`;
}
