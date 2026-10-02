/**
 * The shell floor: the one list of commands bash refuses.
 *
 * It only covers commands that destroy the owner's data or brick the host with
 * no upside: recursive rm of / or the home directory, mkfs, dd onto a disk
 * device, and fork bombs. Everything else runs. Real isolation, when wanted,
 * comes from SANDBOX_MODE. `SHELL_FLOOR=off` removes the floor entirely.
 */

import { homedir } from 'node:os';

export interface FloorVerdict {
  blocked: boolean;
  reason?: string;
}

export function shellFloorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SHELL_FLOOR ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no', 'disabled'].includes(v);
}

/** Split on shell separators so each simple command is checked on its own. */
function segments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|&\n()`]|\$\()/).map(s => s.trim()).filter(Boolean);
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

const PREFIXES = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env']);

function words(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean).map(unquote);
  // Drop wrappers such as `sudo -n`, `env FOO=1`, `nice -n 10`.
  while (tokens.length > 0) {
    const first = tokens[0];
    if (PREFIXES.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      tokens.shift();
      while (tokens.length > 0 && /^-/.test(tokens[0]) && tokens[0] !== '--') tokens.shift();
      continue;
    }
    break;
  }
  return tokens;
}

function isRootOrHome(target: string, home: string): boolean {
  const t = target.replace(/\/+$/, '') || '/';
  const homeNorm = home.replace(/\/+$/, '');
  const dangerous = new Set([
    '/', '/*', '/.', '~', '~/*', '~/.', '$HOME', '$HOME/*', '$HOME/.', '${HOME}', '${HOME}/*', '${HOME}/.',
    homeNorm, `${homeNorm}/*`, `${homeNorm}/.`,
  ]);
  return dangerous.has(t) || dangerous.has(target);
}

function checkRm(tokens: string[], home: string): string | null {
  const name = tokens[0]?.split('/').pop();
  if (name !== 'rm') return null;
  let recursive = false;
  let noPreserveRoot = false;
  const targets: string[] = [];
  let endOfFlags = false;
  for (const tok of tokens.slice(1)) {
    if (!endOfFlags && tok === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && tok.startsWith('--')) {
      if (tok === '--recursive') recursive = true;
      if (tok === '--no-preserve-root') noPreserveRoot = true;
      continue;
    }
    if (!endOfFlags && /^-[A-Za-z]+$/.test(tok)) {
      if (/[rR]/.test(tok)) recursive = true;
      continue;
    }
    targets.push(tok);
  }
  if (noPreserveRoot) return 'rm --no-preserve-root would delete the whole filesystem';
  if (!recursive) return null;
  const hit = targets.find(t => isRootOrHome(t, home));
  if (!hit) return null;
  return ['/', '/*', '/.'].includes(hit)
    ? 'recursive rm of the root filesystem'
    : `recursive rm of the home directory (${hit})`;
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/;
const NAMED_FORK_BOMB = /\b([A-Za-z_]\w*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1\b/;
const DD_TO_DISK = /\bdd\b[^;&|\n]*\bof=\/dev\/(?:sd[a-z]|nvme\d|mmcblk\d|hd[a-z]|vd[a-z]|xvd[a-z]|r?disk\d)/i;
const REDIRECT_TO_DISK = />\s*\/dev\/(?:sd[a-z]|nvme\d|mmcblk\d|hd[a-z]|r?disk\d)/i;

/** Check one command against the floor list. */
export function checkShellFloor(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FloorVerdict {
  if (!shellFloorEnabled(env)) return { blocked: false };
  const compact = command.replace(/\\\n/g, ' ');

  if (FORK_BOMB.test(compact) || NAMED_FORK_BOMB.test(compact)) {
    return { blocked: true, reason: 'fork bomb' };
  }
  if (DD_TO_DISK.test(compact)) {
    return { blocked: true, reason: 'dd writing onto a raw disk device' };
  }
  if (REDIRECT_TO_DISK.test(compact)) {
    return { blocked: true, reason: 'redirecting output onto a raw disk device' };
  }
  for (const seg of segments(compact)) {
    const tokens = words(seg);
    if (tokens.length === 0) continue;
    const name = tokens[0].split('/').pop() ?? '';
    if (/^mkfs(\.[A-Za-z0-9]+)?$/.test(name) || name === 'mke2fs' || name === 'newfs') {
      return { blocked: true, reason: 'formatting a filesystem (mkfs)' };
    }
    const rm = checkRm(tokens, home);
    if (rm) return { blocked: true, reason: rm };
  }
  return { blocked: false };
}
