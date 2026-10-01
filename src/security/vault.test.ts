import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SecretVault, VaultError, loadVaultIntoEnv, parseEnvFile } from './vault.js';
import { clearRegisteredSecretValues, redactSensitiveText } from './redaction.js';

describe('SecretVault', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vault-'));
    env = { SCALLOPBOT_DATA_DIR: dir };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearRegisteredSecretValues();
  });

  it('round-trips secrets and never stores plaintext', () => {
    const vault = new SecretVault(env);
    vault.set('OPENAI_API_KEY', 'plaintext-should-not-appear-123');
    vault.set('NOTION_KEY', 'ntn_abcdefgh12345');
    expect(vault.get('OPENAI_API_KEY')).toBe('plaintext-should-not-appear-123');
    expect(vault.list()).toEqual(['NOTION_KEY', 'OPENAI_API_KEY']);
    const raw = readFileSync(vault.paths.vaultPath, 'utf8');
    expect(raw).not.toContain('plaintext-should');
    expect(raw).not.toContain('OPENAI_API_KEY');
    expect(vault.remove('NOTION_KEY')).toBe(true);
    expect(vault.remove('NOTION_KEY')).toBe(false);
    expect(vault.list()).toEqual(['OPENAI_API_KEY']);
  });

  it('creates the key file and vault with 0600 permissions', () => {
    const vault = new SecretVault(env);
    vault.set('A_TOKEN', 'value-12345678');
    if (process.platform !== 'win32') {
      expect(statSync(vault.paths.keyFilePath).mode & 0o777).toBe(0o600);
      expect(statSync(vault.paths.vaultPath).mode & 0o777).toBe(0o600);
    }
  });

  it('fails with a wrong key', () => {
    new SecretVault({ ...env, SCALLOPBOT_VAULT_KEY: 'correct horse battery staple' }).set('X_KEY', 'v-12345678');
    const wrong = new SecretVault({ ...env, SCALLOPBOT_VAULT_KEY: 'incorrect horse battery' });
    expect(() => wrong.readAll()).toThrow(/wrong key/);
  });

  it('detects tampering', () => {
    const vault = new SecretVault(env);
    vault.set('X_KEY', 'v-12345678');
    const file = JSON.parse(readFileSync(vault.paths.vaultPath, 'utf8'));
    const ct = Buffer.from(file.ct, 'base64');
    ct[0] ^= 1;
    file.ct = ct.toString('base64');
    writeFileSync(vault.paths.vaultPath, JSON.stringify(file));
    expect(() => vault.readAll()).toThrow(VaultError);
  });

  it('refuses a group/world-readable key file', () => {
    if (process.platform === 'win32') return;
    const vault = new SecretVault(env);
    vault.set('X_KEY', 'v-12345678');
    chmodSync(vault.paths.keyFilePath, 0o644);
    expect(() => vault.readAll()).toThrow(/must be 0600/);
  });

  it('errors clearly when the vault exists but no key is configured', () => {
    new SecretVault({ ...env, SCALLOPBOT_VAULT_KEY: 'passphrase-only-in-env' }).set('X_KEY', 'v-12345678');
    expect(() => new SecretVault(env).readAll()).toThrow(/no key is configured/);
  });

  it('rejects invalid names', () => {
    expect(() => new SecretVault(env).set('bad-name', 'x')).toThrow(/Invalid secret name/);
  });
});

describe('loadVaultIntoEnv', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'vault-load-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearRegisteredSecretValues();
  });

  it('fills unset variables; existing env wins', () => {
    const seed = { SCALLOPBOT_DATA_DIR: dir };
    const vault = new SecretVault(seed);
    vault.setMany({ OPENAI_API_KEY: 'value-from-vault-1234567', CUSTOM_THING: 'opaque-value-not-secret-named' });
    const env: NodeJS.ProcessEnv = { SCALLOPBOT_DATA_DIR: dir, OPENAI_API_KEY: 'value-from-env-7654321' };
    const result = loadVaultIntoEnv(env);
    expect(result.loaded).toEqual(['CUSTOM_THING']);
    expect(result.shadowed).toEqual(['OPENAI_API_KEY']);
    expect(env.OPENAI_API_KEY).toBe('value-from-env-7654321');
    expect(env.CUSTOM_THING).toBe('opaque-value-not-secret-named');
  });

  it('registers vault values for redaction even with non-secret names', () => {
    new SecretVault({ SCALLOPBOT_DATA_DIR: dir }).set('CUSTOM_THING', 'opaque-value-not-secret-named');
    loadVaultIntoEnv({ SCALLOPBOT_DATA_DIR: dir });
    expect(redactSensitiveText('leak: opaque-value-not-secret-named', [], {})).toBe('leak: [REDACTED]');
  });

  it('never throws on a broken vault', () => {
    writeFileSync(path.join(dir, 'secrets.enc'), 'not json');
    writeFileSync(path.join(dir, 'vault.key'), 'some-key-material-123', { mode: 0o600 });
    const result = loadVaultIntoEnv({ SCALLOPBOT_DATA_DIR: dir });
    expect(result.error).toMatch(/not valid JSON/);
  });

  it('is a no-op without a vault', () => {
    expect(loadVaultIntoEnv({ SCALLOPBOT_DATA_DIR: dir })).toEqual({ loaded: [], shadowed: [] });
  });
});

describe('parseEnvFile', () => {
  it('handles comments, export, quotes and inline comments', () => {
    expect(parseEnvFile([
      '# comment',
      'A=1',
      'export B="two words"',
      "C='single'",
      'D=value # trailing',
      'E=',
      'not a line',
    ].join('\n'))).toEqual({ A: '1', B: 'two words', C: 'single', D: 'value', E: '' });
  });
});
