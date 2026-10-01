/**
 * Execution sandbox for the bash and run_code skills.
 *
 * Backends:
 *   off      - run directly on the host (the historical behaviour)
 *   docker   - throwaway container, workspace bind-mounted, no network by default
 *   bwrap    - bubblewrap (Linux): read-only root, writable workspace + /tmp
 *   seatbelt - macOS sandbox-exec: writes denied outside workspace/tmp
 *   auto     - best native backend on this host (seatbelt on macOS, bwrap on
 *              Linux when it actually works), else off with a warning.
 *              Docker is never chosen automatically because it needs an image
 *              that carries the user's tools (python, node, git, ...).
 *
 * Everything is driven by environment variables so the skill subprocesses
 * (which receive a least-privilege env from the SkillExecutor) see the same
 * configuration as the gateway.
 *
 * This is defense in depth. The dangerous-pattern blocklist in the bash skill
 * still runs first.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type SandboxMode = 'off' | 'auto' | 'docker' | 'bwrap' | 'seatbelt';
export type SandboxBackend = 'off' | 'docker' | 'bwrap' | 'seatbelt';

export const SANDBOX_MODES: readonly SandboxMode[] = ['off', 'auto', 'docker', 'bwrap', 'seatbelt'];
export const DEFAULT_SANDBOX_IMAGE = 'node:24-bookworm-slim';

/** Env keys skill subprocesses need to apply the sandbox themselves. */
export const SANDBOX_ENV_KEYS = [
  'SANDBOX_MODE', 'SANDBOX_NETWORK', 'SANDBOX_IMAGE', 'SANDBOX_WRITABLE',
  'SANDBOX_CPUS', 'SANDBOX_MEMORY', 'SANDBOX_HIDE_PATHS', 'SANDBOX_BACKEND',
] as const;

export interface SandboxConfig {
  mode: SandboxMode;
  /** undefined = backend default (docker: off, bwrap/seatbelt: on). */
  network?: boolean;
  image: string;
  /** Extra writable paths besides the workspace and temp dirs. */
  writable: string[];
  /** Paths the sandboxed command must not read (vault, key file, .env). */
  hide: string[];
  cpus: string;
  memory: string;
}

export interface SandboxCommand {
  /** Program and arguments to run, e.g. ['bash', '-c', 'ls']. */
  argv: string[];
  /** Working directory (must be inside the workspace). */
  cwd: string;
  /** Workspace root, bind-mounted read-write. */
  workspace: string;
  /** Environment for the command. */
  env: Record<string, string | undefined>;
  /** Extra host files the command needs to read (e.g. a temp script). */
  readOnlyFiles?: string[];
}

export interface WrappedCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  backend: SandboxBackend;
}

export interface SandboxResolution {
  requested: SandboxMode;
  backend: SandboxBackend;
  /** Set when the requested backend cannot run; commands must be refused. */
  error?: string;
  /** Set when auto fell back to off. */
  warning?: string;
  available: Record<Exclude<SandboxBackend, 'off'>, boolean>;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(path.delimiter).map(s => s.trim()).filter(Boolean);
}

function parseNetwork(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'allow'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'deny', 'none'].includes(v)) return false;
  return undefined;
}

export function parseSandboxMode(raw: string | undefined): SandboxMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'off';
  if ((SANDBOX_MODES as readonly string[]).includes(v)) return v as SandboxMode;
  if (v === 'none' || v === 'false' || v === '0') return 'off';
  if (v === 'sandbox-exec' || v === 'macos') return 'seatbelt';
  if (v === 'bubblewrap') return 'bwrap';
  return 'off';
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  return {
    mode: parseSandboxMode(env.SANDBOX_MODE),
    network: parseNetwork(env.SANDBOX_NETWORK),
    image: env.SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE,
    writable: splitList(env.SANDBOX_WRITABLE),
    hide: splitList(env.SANDBOX_HIDE_PATHS),
    cpus: env.SANDBOX_CPUS?.trim() || '1',
    memory: env.SANDBOX_MEMORY?.trim() || '512m',
  };
}

export function networkEnabled(backend: SandboxBackend, config: SandboxConfig): boolean {
  if (config.network !== undefined) return config.network;
  return backend !== 'docker';
}

// ---------------------------------------------------------------------------
// Availability detection
// ---------------------------------------------------------------------------

function quietRun(cmd: string, args: string[], timeoutMs = 4000): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** Probe docker (slow when the daemon is down); off for auto. */
  probeDocker?: boolean;
}

export function detectAvailableBackends(opts: DetectOptions = {}): SandboxResolution['available'] {
  const platform = opts.platform ?? process.platform;
  const seatbelt = platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    && quietRun('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  // bwrap is installed on many distros but fails when unprivileged user
  // namespaces are disabled, so run a real probe instead of `which`.
  const bwrap = platform === 'linux'
    && quietRun('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true']);
  const docker = opts.probeDocker ? quietRun('docker', ['info'], 8000) : false;
  return { docker, bwrap, seatbelt };
}

/** Resolve which backend actually runs commands. Pure given `available`. */
export function resolveSandboxBackend(
  mode: SandboxMode,
  available: SandboxResolution['available'],
): SandboxResolution {
  if (mode === 'off') return { requested: mode, backend: 'off', available };
  if (mode === 'auto') {
    if (available.seatbelt) return { requested: mode, backend: 'seatbelt', available };
    if (available.bwrap) return { requested: mode, backend: 'bwrap', available };
    return {
      requested: mode,
      backend: 'off',
      available,
      warning: 'SANDBOX_MODE=auto found no native sandbox (sandbox-exec on macOS, a working bwrap on Linux); '
        + 'bash/run_code run UNSANDBOXED. Install bubblewrap (apt install bubblewrap) or set SANDBOX_MODE=docker.',
    };
  }
  if (!available[mode]) {
    const hint = mode === 'docker'
      ? 'docker is not installed or the daemon is not reachable'
      : mode === 'bwrap'
        ? 'bwrap is missing or cannot create namespaces (check kernel.unprivileged_userns_clone)'
        : 'sandbox-exec is only available on macOS';
    return {
      requested: mode,
      backend: mode,
      available,
      error: `SANDBOX_MODE=${mode} but ${hint}. Commands are refused rather than run unsandboxed.`,
    };
  }
  return { requested: mode, backend: mode, available };
}

/**
 * Detect and resolve the sandbox for this process. The gateway calls this once
 * at startup and exports SANDBOX_BACKEND so skill subprocesses skip probing.
 */
export function detectSandbox(config: SandboxConfig = loadSandboxConfig()): SandboxResolution {
  const available = detectAvailableBackends({ probeDocker: config.mode === 'docker' });
  return resolveSandboxBackend(config.mode, available);
}

/**
 * Resolution used inside skill subprocesses: trust the gateway's SANDBOX_BACKEND
 * when it matches the configured mode, otherwise probe.
 */
export function sandboxForSubprocess(env: NodeJS.ProcessEnv = process.env): {
  config: SandboxConfig;
  resolution: SandboxResolution;
} {
  const config = loadSandboxConfig(env);
  const exported = env.SANDBOX_BACKEND as SandboxBackend | undefined;
  if (exported && (exported === config.mode || config.mode === 'auto')
    && ['off', 'docker', 'bwrap', 'seatbelt'].includes(exported)) {
    const available = { docker: exported === 'docker', bwrap: exported === 'bwrap', seatbelt: exported === 'seatbelt' };
    return { config, resolution: resolveSandboxBackend(config.mode === 'auto' ? exported : config.mode, available) };
  }
  return { config, resolution: detectSandbox(config) };
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function tempDirs(): string[] {
  const dirs = new Set<string>(['/tmp', os.tmpdir()]);
  if (process.platform === 'darwin') dirs.add('/var/folders');
  return [...dirs];
}

function sbString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS Seatbelt profile: allow everything except writes outside the allowed set. */
export function buildSeatbeltProfile(opts: {
  writable: string[];
  hide: string[];
  network: boolean;
}): string {
  const writable = [...new Set(opts.writable.flatMap(p => [path.resolve(p), real(p)]))];
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...writable.map(p => `  (subpath ${sbString(p)})`),
    '  (subpath "/dev"))',
  ];
  const hide = [...new Set(opts.hide.flatMap(p => [path.resolve(p), real(p)]))];
  if (hide.length > 0) {
    lines.push('(deny file-read* file-write*', ...hide.map(p => `  (subpath ${sbString(p)})`), ')');
  }
  if (!opts.network) {
    lines.push('(deny network-outbound (remote ip))', '(deny network-inbound (local ip))');
  }
  return lines.join('\n');
}

function hostUserFlag(): string[] {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return [];
  return ['--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`];
}

/**
 * Wrap a command for the given backend. Pure (no I/O beyond realpath) so it
 * can be unit tested per backend on any host.
 */
export function wrapCommand(
  spec: SandboxCommand,
  backend: SandboxBackend,
  config: SandboxConfig,
): WrappedCommand {
  const [program, ...rest] = spec.argv;
  if (!program) throw new Error('wrapCommand: empty argv');
  const network = networkEnabled(backend, config);
  const workspace = path.resolve(spec.workspace);
  const cwd = path.resolve(spec.cwd);
  const readOnlyFiles = spec.readOnlyFiles ?? [];

  switch (backend) {
    case 'off':
      return { command: program, args: rest, env: spec.env, backend };

    case 'seatbelt': {
      const profile = buildSeatbeltProfile({
        writable: [workspace, ...tempDirs(), ...config.writable],
        hide: config.hide,
        network,
      });
      return {
        command: '/usr/bin/sandbox-exec',
        args: ['-p', profile, program, ...rest],
        env: spec.env,
        backend,
      };
    }

    case 'bwrap': {
      const args = [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--bind', workspace, workspace,
      ];
      for (const p of config.writable) args.push('--bind-try', path.resolve(p), path.resolve(p));
      for (const f of readOnlyFiles) args.push('--ro-bind', f, f);
      // Mask secrets after the binds so a writable parent cannot re-expose them.
      // Files are shadowed with /dev/null, directories with an empty tmpfs.
      for (const p of config.hide) {
        const abs = path.resolve(p);
        if (!existsSync(abs)) continue;
        if (isDirectory(abs)) args.push('--tmpfs', abs);
        else args.push('--ro-bind', '/dev/null', abs);
      }
      args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
      if (!network) args.push('--unshare-net');
      args.push('--die-with-parent', '--new-session', '--chdir', cwd, '--', program, ...rest);
      return { command: 'bwrap', args, env: spec.env, backend };
    }

    case 'docker': {
      const args = [
        'run', '--rm', '-i', '--init',
        '--network', network ? 'bridge' : 'none',
        '--cpus', config.cpus,
        ...(config.memory ? ['--memory', config.memory] : []),
        '--pids-limit', '256',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        ...hostUserFlag(),
        '-v', `${workspace}:${workspace}:rw`,
        '--tmpfs', '/tmp:rw,exec,size=256m',
      ];
      for (const p of config.writable) args.push('-v', `${path.resolve(p)}:${path.resolve(p)}:rw`);
      for (const f of readOnlyFiles) args.push('-v', `${f}:${f}:ro`);
      // Only mounted paths are visible in the container, so mask secrets that
      // sit inside one: files shadowed with /dev/null, directories with a tmpfs.
      const mounted = [workspace, ...config.writable.map(p => path.resolve(p)), ...readOnlyFiles];
      for (const p of config.hide) {
        const abs = path.resolve(p);
        if (!existsSync(abs)) continue;
        if (!mounted.some(m => abs === m || abs.startsWith(m + path.sep))) continue;
        if (isDirectory(abs)) args.push('--tmpfs', `${abs}:ro,size=1k`);
        else args.push('-v', `/dev/null:${abs}:ro`);
      }
      args.push('-w', cwd);
      // Pass env by NAME only: values come from this process's env and never
      // appear on the docker command line (visible in `ps`). Host PATH/HOME
      // would be wrong inside the image, so they are left to the image.
      const env: Record<string, string | undefined> = { ...spec.env };
      for (const [k, v] of Object.entries(spec.env)) {
        if (v === undefined || ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER'].includes(k)) continue;
        args.push('-e', k);
      }
      args.push(config.image, program, ...rest);
      return { command: 'docker', args, env, backend };
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One-shot helper for skill scripts: resolve the sandbox from env and wrap the
 * command, or return an error string when the configured backend is missing.
 */
export function prepareSandboxedCommand(
  spec: SandboxCommand,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; wrapped: WrappedCommand } | { ok: false; error: string } {
  const { config, resolution } = sandboxForSubprocess(env);
  if (resolution.error) return { ok: false, error: `Sandbox unavailable: ${resolution.error}` };
  const effective = resolution.backend === 'docker' && config.memory && !dockerEnforcesMemoryLimit()
    ? { ...config, memory: '' }
    : config;
  return { ok: true, wrapped: wrapCommand(spec, resolution.backend, effective) };
}

let dockerMemoryLimit: boolean | undefined;

/**
 * Some hosts (Raspberry Pi OS ships with the memory cgroup off) cannot enforce
 * `--memory`; docker then prints a kernel warning on every run, which reaches
 * the model as tool stderr and reads like a failure. Skip the flag there.
 */
export function dockerEnforcesMemoryLimit(): boolean {
  if (dockerMemoryLimit === undefined) {
    try {
      const out = execFileSync('docker', ['info', '--format', '{{.MemoryLimit}}'], {
        encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      dockerMemoryLimit = out.trim() !== 'false';
    } catch {
      dockerMemoryLimit = true;
    }
  }
  return dockerMemoryLimit;
}

/** Human-readable one-liner for startup logs. */
export function describeSandbox(resolution: SandboxResolution, config: SandboxConfig): string {
  if (resolution.error) return resolution.error;
  if (resolution.backend === 'off') {
    return resolution.warning ?? 'Sandbox off (SANDBOX_MODE=off): bash/run_code run directly on the host';
  }
  const net = networkEnabled(resolution.backend, config) ? 'network on' : 'network off';
  const image = resolution.backend === 'docker' ? `, image ${config.image}` : '';
  return `Sandbox active: ${resolution.backend} (${net}${image})`;
}
