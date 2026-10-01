/**
 * `scallopbot secrets set|get|list|rm|import-env` - manage the encrypted vault.
 * Values are never echoed except by an explicit `get`.
 */

import type { Command } from 'commander';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { SECRET_NAME_RE, SecretVault, isValidSecretName, parseEnvFile } from './vault.js';

async function readSecretValue(name: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped: `printf %s "$KEY" | scallopbot secrets set NAME`
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mute echo while typing.
  const rlAny = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  rlAny._writeToOutput = (s: string) => {
    if (!muted) rlAny.output.write(s);
  };
  return new Promise((resolve) => {
    rl.question(`Value for ${name} (input hidden): `, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function fail(error: unknown): void {
  console.error('secrets:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('Manage the encrypted secret vault (~/.scallopbot/secrets.enc)');

  secrets
    .command('set <name> [value]')
    .description('Store a secret. Omit the value to type it hidden or pipe it on stdin (keeps it out of shell history)')
    .action(async (name: string, value?: string) => {
      try {
        if (!isValidSecretName(name)) throw new Error(`Invalid name "${name}" (letters, digits, _)`);
        const secret = value ?? await readSecretValue(name);
        if (!secret) throw new Error('Empty value; nothing stored');
        const vault = new SecretVault();
        vault.set(name, secret);
        console.log(`Stored ${name} in ${vault.paths.vaultPath}`);
      } catch (e) { fail(e); }
    });

  secrets
    .command('get <name>')
    .description('Print one secret value to stdout')
    .action((name: string) => {
      try {
        const value = new SecretVault().get(name);
        if (value === undefined) throw new Error(`No secret named ${name}`);
        process.stdout.write(`${value}\n`);
      } catch (e) { fail(e); }
    });

  secrets
    .command('list')
    .description('List secret names (never values)')
    .action(() => {
      try {
        const vault = new SecretVault();
        const names = vault.list();
        if (names.length === 0) {
          console.log(`Vault is empty (${vault.paths.vaultPath})`);
          return;
        }
        for (const name of names) {
          const note = process.env[name] !== undefined && process.env[name] !== vault.get(name)
            ? '  (overridden by environment)' : '';
          console.log(`${name}${note}`);
        }
      } catch (e) { fail(e); }
    });

  secrets
    .command('rm <name>')
    .description('Delete a secret')
    .action((name: string) => {
      try {
        if (!new SecretVault().remove(name)) throw new Error(`No secret named ${name}`);
        console.log(`Removed ${name}`);
      } catch (e) { fail(e); }
    });

  secrets
    .command('import-env [file]')
    .description('Copy credential-looking variables from a .env file (default ./.env) into the vault')
    .option('--all', 'Import every non-empty variable, not only credential-looking names')
    .option('--strip', 'Remove imported lines from the .env file afterwards (a 0600 .env.bak backup is kept)')
    .action((file: string | undefined, options: { all?: boolean; strip?: boolean }) => {
      try {
        const envPath = path.resolve(file ?? '.env');
        if (!existsSync(envPath)) throw new Error(`${envPath} not found`);
        const content = readFileSync(envPath, 'utf8');
        const parsed = parseEnvFile(content);
        const selected = Object.fromEntries(
          Object.entries(parsed).filter(([name, value]) => value !== '' && (options.all || SECRET_NAME_RE.test(name))),
        );
        const names = Object.keys(selected);
        if (names.length === 0) {
          console.log('No matching variables found.');
          return;
        }
        const vault = new SecretVault();
        vault.setMany(selected);
        console.log(`Imported ${names.length} secret(s) into ${vault.paths.vaultPath}:`);
        for (const name of names) console.log(`  ${name}`);
        if (options.strip) {
          const backup = `${envPath}.bak`;
          copyFileSync(envPath, backup);
          chmodSync(backup, 0o600);
          const imported = new Set(names);
          const kept = content.split(/\r?\n/).filter((line) => {
            const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
            return !(m && imported.has(m[1]));
          });
          writeFileSync(envPath, kept.join('\n'));
          console.log(`Removed them from ${envPath} (backup: ${backup}; delete it once the bot starts cleanly).`);
        } else {
          console.log('Environment variables win over the vault, so delete these lines from .env '
            + '(or re-run with --strip) to stop storing them in plaintext.');
        }
      } catch (e) { fail(e); }
    });
}
