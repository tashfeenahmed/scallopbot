import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  buildSeatbeltProfile,
  loadSandboxConfig,
  parseSandboxMode,
  prepareSandboxedCommand,
  resolveSandboxBackend,
  wrapCommand,
  type SandboxConfig,
} from './index.js';

const baseConfig: SandboxConfig = {
  mode: 'off', image: 'node:24-bookworm-slim', writable: [], hide: [], cpus: '1', memory: '512m',
};
const spec = {
  argv: ['bash', '-c', 'echo hi'],
  cwd: '/work/space/sub',
  workspace: '/work/space',
  env: { PATH: '/usr/bin', OPENAI_API_KEY: 'value-should-not-appear-on-cmdline', FOO: 'bar' },
};

describe('sandbox config parsing', () => {
  it('defaults to off and accepts aliases', () => {
    expect(parseSandboxMode(undefined)).toBe('off');
    expect(parseSandboxMode('AUTO')).toBe('auto');
    expect(parseSandboxMode('bubblewrap')).toBe('bwrap');
    expect(parseSandboxMode('sandbox-exec')).toBe('seatbelt');
    expect(parseSandboxMode('nonsense')).toBe('off');
  });

  it('reads network/image/limits from env', () => {
    const cfg = loadSandboxConfig({
      SANDBOX_MODE: 'docker', SANDBOX_NETWORK: 'on', SANDBOX_IMAGE: 'python:3.12-slim',
      SANDBOX_CPUS: '2', SANDBOX_MEMORY: '1g', SANDBOX_WRITABLE: ['/a', '/b'].join(path.delimiter),
    });
    expect(cfg).toMatchObject({ mode: 'docker', network: true, image: 'python:3.12-slim', cpus: '2', memory: '1g', writable: ['/a', '/b'] });
    expect(loadSandboxConfig({}).network).toBeUndefined();
  });
});

describe('backend resolution', () => {
  const none = { docker: false, bwrap: false, seatbelt: false };

  it('auto prefers seatbelt, then bwrap, never docker', () => {
    expect(resolveSandboxBackend('auto', { ...none, seatbelt: true, docker: true }).backend).toBe('seatbelt');
    expect(resolveSandboxBackend('auto', { ...none, bwrap: true, docker: true }).backend).toBe('bwrap');
    const fallback = resolveSandboxBackend('auto', { ...none, docker: true });
    expect(fallback.backend).toBe('off');
    expect(fallback.warning).toMatch(/UNSANDBOXED/);
    expect(fallback.error).toBeUndefined();
  });

  it('an explicitly requested but missing backend fails closed', () => {
    const r = resolveSandboxBackend('docker', none);
    expect(r.error).toMatch(/refused/);
    expect(resolveSandboxBackend('bwrap', none).error).toBeDefined();
  });

  it('refuses commands via prepareSandboxedCommand when the backend is missing', () => {
    const out = prepareSandboxedCommand(spec, { SANDBOX_MODE: 'bwrap', SANDBOX_BACKEND: 'off' });
    if (process.platform !== 'linux') {
      expect(out.ok).toBe(false);
    }
  });
});

describe('command construction', () => {
  it('off passes the command through', () => {
    const w = wrapCommand(spec, 'off', baseConfig);
    expect(w).toMatchObject({ command: 'bash', args: ['-c', 'echo hi'] });
  });

  it('docker: no network by default, limits, workspace bind, env by name only', () => {
    const w = wrapCommand(spec, 'docker', baseConfig);
    expect(w.command).toBe('docker');
    const a = w.args.join(' ');
    expect(a).toContain('run --rm -i');
    expect(a).toContain('--network none');
    expect(a).toContain('--cpus 1');
    expect(a).toContain('--memory 512m');
    expect(a).toContain('--cap-drop ALL');
    expect(a).toContain('-v /work/space:/work/space:rw');
    expect(a).toContain('-w /work/space/sub');
    expect(a).toContain('-e OPENAI_API_KEY');
    expect(a).not.toContain('value-should-not-appear-on-cmdline');
    expect(a).not.toContain('-e PATH');
    expect(w.args.slice(-4)).toEqual(['node:24-bookworm-slim', 'bash', '-c', 'echo hi']);
    expect(wrapCommand(spec, 'docker', { ...baseConfig, network: true }).args.join(' ')).toContain('--network bridge');
  });

  it('docker mounts read-only extra files', () => {
    const w = wrapCommand({ ...spec, readOnlyFiles: ['/tmp/x.py'] }, 'docker', baseConfig);
    expect(w.args.join(' ')).toContain('-v /tmp/x.py:/tmp/x.py:ro');
  });

  it('docker masks hidden secrets that sit inside a mounted path', () => {
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'sb-docker-hide-')));
    try {
      writeFileSync(path.join(ws, '.env'), 'SECRET=1');
      mkdirSync(path.join(ws, 'vault'));
      const outside = path.join(tmpdir(), 'not-mounted.env');
      writeFileSync(outside, 'x');
      const hide = [path.join(ws, '.env'), path.join(ws, 'vault'), outside];
      const a = wrapCommand({ ...spec, cwd: ws, workspace: ws }, 'docker', { ...baseConfig, hide }).args.join(' ');
      expect(a).toContain(`-v /dev/null:${path.join(ws, '.env')}:ro`);
      expect(a).toContain(`--tmpfs ${path.join(ws, 'vault')}:ro,size=1k`);
      expect(a).not.toContain(outside);
      rmSync(outside, { force: true });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('bwrap: read-only root, writable workspace, network kept unless off', () => {
    const w = wrapCommand(spec, 'bwrap', baseConfig);
    expect(w.command).toBe('bwrap');
    const a = w.args.join(' ');
    expect(a).toContain('--ro-bind / /');
    expect(a).toContain('--bind /work/space /work/space');
    expect(a).toContain('--tmpfs /tmp');
    expect(a).toContain('--chdir /work/space/sub');
    expect(a).toContain('--die-with-parent');
    expect(a).not.toContain('--unshare-net');
    expect(w.args.slice(-4)).toEqual(['--', 'bash', '-c', 'echo hi']);
    expect(wrapCommand(spec, 'bwrap', { ...baseConfig, network: false }).args).toContain('--unshare-net');
  });

  it('bwrap shadows hidden files with /dev/null', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-hide-'));
    const secret = path.join(dir, 'vault.key');
    writeFileSync(secret, 'k');
    try {
      const a = wrapCommand(spec, 'bwrap', { ...baseConfig, hide: [secret, dir + '-missing'] }).args.join(' ');
      expect(a).toContain(`--ro-bind /dev/null ${secret}`);
      expect(a).not.toContain('-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seatbelt: profile denies writes outside allowed paths and optionally network', () => {
    const w = wrapCommand(spec, 'seatbelt', { ...baseConfig, network: false });
    expect(w.command).toBe('/usr/bin/sandbox-exec');
    expect(w.args[0]).toBe('-p');
    const profile = w.args[1];
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/work/space")');
    expect(profile).toContain('(deny network-outbound (remote ip))');
    expect(w.args.slice(2)).toEqual(['bash', '-c', 'echo hi']);
    expect(buildSeatbeltProfile({ writable: ['/w'], hide: [], network: true })).not.toContain('network-outbound');
  });

  it('seatbelt escapes quotes in paths', () => {
    const p = buildSeatbeltProfile({ writable: ['/we"ird'], hide: [], network: true });
    expect(p).toContain('(subpath "/we\\"ird")');
  });
});

const hasSeatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe.runIf(hasSeatbelt)('seatbelt (real run on macOS)', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  beforeEach(() => {
    // Outside path lives in $HOME, because the temp dirs are writable by design.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sbx-real-')));
    workspace = path.join(root, 'ws');
    mkdirSync(workspace);
    outside = mkdtempSync(path.join(homedir(), '.sbx-outside-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function run(cmd: string, cfg: Partial<SandboxConfig> = {}) {
    const w = wrapCommand(
      { argv: ['bash', '-c', cmd], cwd: workspace, workspace, env: { PATH: process.env.PATH } },
      'seatbelt',
      { ...baseConfig, ...cfg },
    );
    return spawnSync(w.command, w.args, { cwd: workspace, env: w.env as NodeJS.ProcessEnv, encoding: 'utf8' });
  }

  it('allows writes in the workspace and temp dir', () => {
    const r = run('echo ok > inside.txt && echo t > "$TMPDIR/sbx-$$" ; cat inside.txt');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  it('denies writes outside the workspace', () => {
    const target = path.join(outside, 'escape.txt');
    const r = run(`echo pwned > ${JSON.stringify(target)}`);
    expect(r.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('hides configured secret files from reads', () => {
    const secret = path.join(outside, 'vault.key');
    writeFileSync(secret, 'super-secret-key-material');
    const r = run(`cat ${JSON.stringify(secret)}`, { hide: [secret] });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('super-secret');
  });

  it('denies outbound network when SANDBOX_NETWORK=off', () => {
    const r = run('exec 3<>/dev/tcp/1.1.1.1/80', { network: false });
    expect(r.status).not.toBe(0);
  });
});

function dockerWorks(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(dockerWorks())('docker (real run, only when the daemon is reachable)', () => {
  it('runs in a container with no network', () => {
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), 'sbx-docker-')));
    try {
      const w = wrapCommand(
        { argv: ['sh', '-c', 'echo ok > f && cat f'], cwd: ws, workspace: ws, env: {} },
        'docker',
        { ...baseConfig, image: 'alpine:3' },
      );
      const r = spawnSync(w.command, w.args, { encoding: 'utf8', timeout: 120_000 });
      expect(r.stdout.trim()).toBe('ok');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
