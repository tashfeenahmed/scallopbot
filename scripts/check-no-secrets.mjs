#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const self = 'scripts/check-no-secrets.mjs';
const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter(file => file !== self);

// Build signatures in pieces so this scanner does not flag its own source if
// it is copied or invoked outside git.
const signatures = [
  ['OpenAI API key', ['sk-', '(?:proj-)?', '[A-Za-z0-9_-]{20,}'].join('')],
  ['Telegram bot token', ['[0-9]{8,12}', ':AA', '[A-Za-z0-9_-]{20,}'].join('')],
  ['Google API key', ['AI', 'za', '[A-Za-z0-9_-]{25,}'].join('')],
  ['Google OAuth secret', ['GO', 'CSPX-', '[A-Za-z0-9_-]{10,}'].join('')],
  ['GitHub token', ['gh', '[pousr]_', '[A-Za-z0-9]{20,}'].join('')],
  ['Slack token', ['xo', 'x[baprs]-', '[A-Za-z0-9-]{20,}'].join('')],
  ['AWS access key', ['AK', 'IA', '[A-Z0-9]{16}'].join('')],
  ['private key', ['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')],
].map(([label, source]) => ({ label, regex: new RegExp(source, 'g') }));

const assignment = new RegExp(
  String.raw`\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|bot[_ -]?token|client[_ -]?secret|password)\b\s*[:=]\s*[\x60"']?([^\s\x60"'#]+)`,
  'ig',
);
const safePlaceholder = /^(?:<[^>]+>|\$\{[^}]+\}|your[_-].+|test(?:[_-].*)?|fake(?:[_-].*)?|dummy(?:[_-].*)?|example(?:[_-].*)?|change-?me|redacted|(?:user|owner)pass|x+|\*+)$/i;
const fixtureHint = /\b(?:test|fake|dummy|example|fixture|placeholder)\b/i;
const assignmentScanFile = /(?:^|\/)(?:[^/]+\.(?:md|ya?ml|toml|ini|conf)|\.env(?:\..*)?)$/i;

const findings = [];
for (const file of tracked) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const { label, regex } of signatures) {
      regex.lastIndex = 0;
      if (regex.test(line) && !fixtureHint.test(line)) {
        findings.push(`${file}:${index + 1}: possible ${label}`);
      }
    }
    if (assignmentScanFile.test(file)) {
      assignment.lastIndex = 0;
      for (const match of line.matchAll(assignment)) {
        const value = match[1].replace(/[;,)]$/, '');
        if (value && !safePlaceholder.test(value) && !fixtureHint.test(line)) {
          findings.push(`${file}:${index + 1}: possible committed credential`);
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found in tracked files:');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  console.error('Move real values to a private .env/runbook; do not add an allowlist for them.');
  process.exit(1);
}

console.log(`Secret scan passed (${tracked.length} repository files checked).`);
