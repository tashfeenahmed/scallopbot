/**
 * Startup report for the security layers: sandbox backend, vault load and
 * prompt-injection scanning. Called once from Gateway.initialize().
 */

import * as path from 'node:path';
import type { Logger } from 'pino';
import { describeSandbox, detectSandbox, loadSandboxConfig, type SandboxResolution } from './sandbox/index.js';
import { resolveVaultPaths, type VaultLoadResult } from './vault.js';
import { parseInjectionScanMode } from './prompt-injection.js';

/**
 * Paths a sandboxed command must not read by default: the vault, its key file
 * and the bot's own .env. Exported via SANDBOX_HIDE_PATHS unless the operator
 * set it explicitly.
 */
export function defaultSandboxHidePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const { vaultPath, keyFilePath } = resolveVaultPaths(env);
  return [vaultPath, keyFilePath, path.resolve(cwd, '.env')];
}

export function initSecurityLayers(logger: Logger, vault?: VaultLoadResult): SandboxResolution {
  const config = loadSandboxConfig();
  const resolution = detectSandbox(config);
  // Skill subprocesses read this instead of re-probing. A failed explicit
  // backend is not exported, so each command re-checks and refuses.
  if (resolution.error) delete process.env.SANDBOX_BACKEND;
  else process.env.SANDBOX_BACKEND = resolution.backend;
  if (!process.env.SANDBOX_HIDE_PATHS) {
    process.env.SANDBOX_HIDE_PATHS = defaultSandboxHidePaths().join(path.delimiter);
  }
  const message = describeSandbox(resolution, config);
  if (resolution.error) logger.error({ sandbox: resolution.requested }, message);
  else if (resolution.warning) logger.warn({ sandbox: resolution.requested }, message);
  else logger.info({ sandbox: resolution.backend, requested: resolution.requested }, message);

  if (vault) {
    if (vault.error) logger.warn({ error: vault.error }, 'Secret vault not loaded');
    else if (vault.loaded.length > 0 || vault.shadowed.length > 0) {
      // Names only, never values.
      logger.info({ loaded: vault.loaded, overriddenByEnv: vault.shadowed }, 'Secret vault loaded');
    }
  }

  logger.info({ mode: parseInjectionScanMode(process.env.PROMPT_INJECTION_SCAN) }, 'Prompt-injection scanning of tool output');
  return resolution;
}
