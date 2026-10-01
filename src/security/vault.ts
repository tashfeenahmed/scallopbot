/**
 * Encrypted secret vault.
 *
 * Secrets live in ~/.scallopbot/secrets.enc (override: SCALLOPBOT_VAULT_PATH)
 * as one AES-256-GCM blob. The 256-bit key is derived with scrypt from either
 *   - SCALLOPBOT_VAULT_KEY (a passphrase or random string in the environment), or
 *   - a key file, ~/.scallopbot/vault.key (override: SCALLOPBOT_VAULT_KEY_FILE),
 *     which must be mode 0600 and is created automatically on first `set`.
 *
 * Precedence at startup: a variable already present in the environment (shell
 * export, systemd, or .env via dotenv) WINS over the vault. That keeps per-run
 * overrides working; after `scallopbot secrets import-env`, delete the
 * plaintext lines from .env so the vault becomes the source of truth.
 *
 * Secret values are never logged. Values loaded from the vault are registered
 * with the redaction layer, so they are scrubbed from traces and skill output
 * even when the variable name does not look secret.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { registerSecretValues } from './redaction.js';

const FORMAT_VERSION = 1;
const AAD = Buffer.from('scallopbot-vault-v1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface VaultFile {
  v: number;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface VaultPaths {
  vaultPath: string;
  keyFilePath: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export function vaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCALLOPBOT_DATA_DIR || path.join(homedir(), '.scallopbot');
}

export function resolveVaultPaths(env: NodeJS.ProcessEnv = process.env): VaultPaths {
  const dir = vaultDir(env);
  return {
    vaultPath: env.SCALLOPBOT_VAULT_PATH || path.join(dir, 'secrets.enc'),
    keyFilePath: env.SCALLOPBOT_VAULT_KEY_FILE || path.join(dir, 'vault.key'),
  };
}

export function isValidSecretName(name: string): boolean {
  return NAME_RE.test(name);
}

function assertPrivateFile(file: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new VaultError(
      `Vault key file ${file} has permissions ${mode.toString(8).padStart(4, '0')}; it must be 0600. Run: chmod 600 ${file}`,
    );
  }
}

/**
 * Resolve the raw key material. Returns null when no key is configured.
 * `create` generates a random key file (0600) when nothing exists yet.
 */
export function loadKeyMaterial(
  env: NodeJS.ProcessEnv = process.env,
  opts: { create?: boolean } = {},
): string | null {
  const fromEnv = env.SCALLOPBOT_VAULT_KEY;
  if (fromEnv && fromEnv.length > 0) {
    if (fromEnv.length < 12) throw new VaultError('SCALLOPBOT_VAULT_KEY is too short (minimum 12 characters).');
    return fromEnv;
  }
  const { keyFilePath } = resolveVaultPaths(env);
  if (existsSync(keyFilePath)) {
    assertPrivateFile(keyFilePath);
    const key = readFileSync(keyFilePath, 'utf8').trim();
    if (key.length < 12) throw new VaultError(`Vault key file ${keyFilePath} is empty or too short.`);
    return key;
  }
  if (!opts.create) return null;
  mkdirSync(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(keyFilePath, `${key}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(keyFilePath, 0o600);
  return key;
}

function deriveKey(material: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(material, salt, 32, { ...params, maxmem: SCRYPT.maxmem });
}

export function encryptSecrets(secrets: Record<string, string>, material: string): VaultFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(material, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return {
    v: FORMAT_VERSION,
    kdf: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecrets(file: VaultFile, material: string): Record<string, string> {
  if (file.v !== FORMAT_VERSION || file.kdf !== 'scrypt') {
    throw new VaultError(`Unsupported vault format (v=${String(file.v)}).`);
  }
  const key = deriveKey(material, Buffer.from(file.salt, 'base64'), { N: file.N, r: file.r, p: file.p });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultError('Cannot decrypt the vault: wrong key or the file was tampered with.');
  }
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new VaultError('Vault payload is malformed.');
  return parsed as Record<string, string>;
}

export class SecretVault {
  readonly paths: VaultPaths;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.paths = resolveVaultPaths(env);
  }

  exists(): boolean {
    return existsSync(this.paths.vaultPath);
  }

  /** Read all secrets. An absent vault is empty. */
  readAll(): Record<string, string> {
    if (!this.exists()) return {};
    const material = loadKeyMaterial(this.env);
    if (!material) {
      throw new VaultError(
        `Vault ${this.paths.vaultPath} exists but no key is configured (set SCALLOPBOT_VAULT_KEY or create ${this.paths.keyFilePath}).`,
      );
    }
    let file: VaultFile;
    try {
      file = JSON.parse(readFileSync(this.paths.vaultPath, 'utf8')) as VaultFile;
    } catch {
      throw new VaultError(`Vault ${this.paths.vaultPath} is not valid JSON.`);
    }
    return decryptSecrets(file, material);
  }

  private writeAll(secrets: Record<string, string>): void {
    const material = loadKeyMaterial(this.env, { create: true });
    if (!material) throw new VaultError('No vault key available.');
    const dir = path.dirname(this.paths.vaultPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.paths.vaultPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(encryptSecrets(secrets, material)), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.paths.vaultPath);
  }

  get(name: string): string | undefined {
    return this.readAll()[name];
  }

  list(): string[] {
    return Object.keys(this.readAll()).sort();
  }

  set(name: string, value: string): void {
    if (!isValidSecretName(name)) throw new VaultError(`Invalid secret name "${name}" (use letters, digits and _).`);
    const all = this.exists() ? this.readAll() : {};
    all[name] = value;
    this.writeAll(all);
  }

  setMany(entries: Record<string, string>): void {
    for (const name of Object.keys(entries)) {
      if (!isValidSecretName(name)) throw new VaultError(`Invalid secret name "${name}".`);
    }
    const all = this.exists() ? this.readAll() : {};
    this.writeAll({ ...all, ...entries });
  }

  remove(name: string): boolean {
    const all = this.readAll();
    if (!(name in all)) return false;
    delete all[name];
    this.writeAll(all);
    return true;
  }
}

export interface VaultLoadResult {
  loaded: string[];
  /** Names present in the vault but overridden by the existing environment. */
  shadowed: string[];
  error?: string;
}

/**
 * Load vault values into the environment at startup. Existing env vars win.
 * Never throws: a broken vault is reported, not fatal, so a Pi with keys still
 * in .env keeps booting. Values are registered for redaction either way.
 */
export function loadVaultIntoEnv(env: NodeJS.ProcessEnv = process.env): VaultLoadResult {
  const result: VaultLoadResult = { loaded: [], shadowed: [] };
  if (env.SCALLOPBOT_VAULT_DISABLE === '1' || env.SCALLOPBOT_VAULT_DISABLE === 'true') return result;
  let secrets: Record<string, string>;
  try {
    const vault = new SecretVault(env);
    if (!vault.exists()) return result;
    secrets = vault.readAll();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  registerSecretValues(Object.values(secrets));
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string') continue;
    if (env[name] !== undefined && env[name] !== '') {
      result.shadowed.push(name);
      continue;
    }
    env[name] = value;
    result.loaded.push(name);
  }
  return result;
}

/** Parse KEY=VALUE lines from a .env file (comments, export prefix, quotes). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (/^"(.*)"$/s.test(value)) value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'(.*)'$/s.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

/** Names worth moving from .env into the vault (credential-looking, non-empty). */
export const SECRET_NAME_RE = /(?:api[_-]?key|token|secret|password|passwd|private[_-]?key|credential|_key$|auth)/i;
