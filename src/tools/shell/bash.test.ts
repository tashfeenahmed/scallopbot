import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBash, resolveTimeoutMs } from './bash.js';
import { BackgroundProcessManager, formatBashDone, type BackgroundExitEvent } from './process-manager.js';
import { runProcessAction, registerShellTools } from './index.js';
import { clearLedger, getLedgerState } from '../verify/ledger.js';

const SAVED = ['SCALLOPBOT_HOME', 'SANDBOX_MODE', 'SANDBOX_BACKEND', 'SHELL_FLOOR'] as const;

describe('native bash', () => {
  let root: string;
  let workspace: string;
  let manager: BackgroundProcessManager;
  const saved: Record<string, string | undefined> = {};
  const ctx = (sessionId = 's1', userId = 'telegram:1') => ({ args: {}, workspace, sessionId, userId });

  beforeEach(() => {
    for (const k of SAVED) saved[k] = process.env[k];
    root = realpathSync(mkdtempSync(join(tmpdir(), 'native-bash-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace);
    process.env.SCALLOPBOT_HOME = join(root, 'home');
    process.env.SANDBOX_MODE = 'off';
    delete process.env.SANDBOX_BACKEND;
    delete process.env.SHELL_FLOOR;
    manager = new BackgroundProcessManager();
    clearLedger();
  });

  afterEach(async () => {
    await manager.killAll(200);
    manager.reset();
    for (const k of SAVED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const bash = (args: Record<string, unknown>, extra: Parameters<typeof runBash>[2] = {}, c = ctx()) =>
    runBash(args, c, { manager, ...extra });

  it('puts the exit code on the first line and runs in the workspace', async () => {
    const r = await bash({ command: 'pwd' });
    expect(r.success).toBe(true);
    expect(r.output.split('\n')[0]).toBe('exit code: 0');
    expect(r.output).toContain(workspace);
  });

  it('interleaves stderr into the output', async () => {
    const r = await bash({ command: 'echo out; echo err >&2' });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('success is exit 0 even when the output says error', async () => {
    const r = await bash({ command: 'echo "ERROR: this is just text"; echo "Error: fine"' });
    expect(r.success).toBe(true);
    expect(r.output.split('\n')[0]).toBe('exit code: 0');
  });

  it('explains a non-zero exit code', async () => {
    const r = await bash({ command: 'definitely-not-a-real-command-xyz' });
    expect(r.success).toBe(false);
    expect(r.output.split('\n')[0]).toMatch(/^exit code: 127 \(command not found/);

    const r2 = await bash({ command: 'exit 3' });
    expect(r2.output.split('\n')[0]).toMatch(/^exit code: 3/);
    expect(r2.output).toContain('(no output)');
  });

  it('warns when the command can hide a failure', async () => {
    const r = await bash({ command: 'false || echo recovered' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/warning: `\|\| echo`/);
  });

  it('refuses the floor list but not ordinary deletes', async () => {
    const r = await bash({ command: 'rm -rf /' });
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/^exit code: 126 \(refused: recursive rm of the root filesystem/);
    const ok = await bash({ command: 'mkdir -p build && rm -rf ./build && echo gone' });
    expect(ok.success).toBe(true);
  });

  it('no longer blocks curl/pip/requests patterns', async () => {
    const r = await bash({ command: 'echo pip install requests; echo "requests.post(x)"' });
    expect(r.success).toBe(true);
  });

  it('honours cwd relative to the workspace and reports a missing one', async () => {
    mkdirSync(join(workspace, 'sub'));
    const r = await bash({ command: 'pwd', cwd: 'sub' });
    expect(r.output).toContain(join(workspace, 'sub'));
    const missing = await bash({ command: 'pwd', cwd: 'nope' });
    expect(missing.success).toBe(false);
    expect(missing.output).toMatch(/cwd does not exist/);
  });

  it('caps big output at head+tail and saves the full text', async () => {
    const r = await bash(
      { command: 'for i in $(seq 1 2000); do echo "line-$i-xxxxxxxxxxxxxxxxxxxx"; done' },
      { outputCapChars: 2_000 },
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('line-1-');
    expect(r.output).toContain('line-2000-');
    expect(r.output).not.toContain('line-1000-');
    const m = r.output.match(/Full output saved to (\S+\.txt)/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain(join(root, 'home', 'tool-output', 's1'));
    expect(readFileSync(m![1], 'utf8')).toContain('line-1000-');
    expect(r.output).toMatch(/read_file with offset\/limit/);
    expect(r.output).toMatch(/omitted/);
  });

  it('deletes the log of a small foreground command', async () => {
    await bash({ command: 'echo small' });
    const dir = join(root, 'home', 'tool-output', 's1');
    const files = existsSync(dir) ? (await import('node:fs')).readdirSync(dir) : [];
    expect(files).toEqual([]);
  });

  it('timeout is in seconds, legacy millisecond values are recognised', () => {
    expect(resolveTimeoutMs(undefined, 180_000)).toBe(180_000);
    expect(resolveTimeoutMs(30, 180_000)).toBe(30_000);
    expect(resolveTimeoutMs(60_000, 180_000)).toBe(60_000);
    expect(resolveTimeoutMs(10_000_000, 180_000)).toBe(600_000);
  });

  it('background:true returns {pid,id,log} at once and emits a bash-done event', async () => {
    const events: BackgroundExitEvent[] = [];
    manager.on('exit', e => events.push(e));
    const started = Date.now();
    const r = await bash({ command: 'sleep 0.3; echo finished-bg; exit 4', background: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.success).toBe(true);
    const handle = JSON.parse(r.output.split('\n')[1]) as { pid: number; id: number; log: string };
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.id).toBeGreaterThan(0);
    expect(handle.log).toContain('tool-output');
    expect(r.output).toMatch(/Do not sleep or poll/);

    await manager.get(handle.id)!.done;
    await new Promise(r2 => setTimeout(r2, 20));
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e).toMatchObject({ sessionId: 's1', userId: 'telegram:1', id: handle.id, pid: handle.pid, exitCode: 4 });
    expect(e.tail).toContain('finished-bg');
    expect(formatBashDone(e)).toBe(`[bash-done id:${handle.id} pid:${handle.pid} exit:4] sleep 0.3; echo finished-bg; exit 4\nfinished-bg`);
  });

  it('auto-backgrounds a foreground command that outlives its timeout instead of killing it', async () => {
    const events: BackgroundExitEvent[] = [];
    manager.on('exit', e => events.push(e));
    const r = await bash({ command: 'echo started; sleep 0.6; echo later' }, { defaultTimeoutMs: 150 });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/still running after 150ms: moved to background \(not killed\)/);
    expect(r.output).toContain('started');
    const handle = JSON.parse(r.output.split('\n')[1]) as { id: number };
    expect(manager.get(handle.id)!.status).toBe('running');
    await manager.get(handle.id)!.done;
    await new Promise(r2 => setTimeout(r2, 20));
    expect(events).toHaveLength(1);
    expect(events[0].exitCode).toBe(0);
    expect(events[0].tail).toContain('later');
  });

  it('auto-backgrounds when the turn deadline aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runBash({ command: 'sleep 0.5' }, { ...ctx(), signal: controller.signal }, { manager });
    expect(r.output).toMatch(/turn deadline/);
  });

  it('does not emit notices for foreground commands', async () => {
    const events: BackgroundExitEvent[] = [];
    manager.on('exit', e => events.push(e));
    await bash({ command: 'echo hi' });
    await new Promise(r2 => setTimeout(r2, 50));
    expect(events).toHaveLength(0);
    expect(manager.list('s1')).toHaveLength(0);
  });

  it('records shell results in the verification ledger', async () => {
    await bash({ command: 'npx tsc --version >/dev/null 2>&1 || true' });
    const state = getLedgerState('s1');
    expect(state?.runs.some(r => r.command.startsWith('npx tsc'))).toBe(true);
    expect(state?.runs.find(r => r.command.startsWith('npx tsc'))?.masked).toBe(true);
  });

  describe('process tool', () => {
    it('list / poll / log / wait', async () => {
      const r = await bash({ command: 'for i in 1 2 3 4 5; do echo "row $i"; done; sleep 0.3; echo end', background: true });
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      await new Promise(r2 => setTimeout(r2, 100));

      const list = await runProcessAction({ action: 'list' }, { sessionId: 's1' }, manager);
      expect(list.output).toMatch(new RegExp(`id ${id} pid \\d+ running`));
      expect(list.output).toContain('echo "row $i"');

      const poll = await runProcessAction({ action: 'poll', id }, { sessionId: 's1' }, manager);
      expect(poll.output).toContain('row 5');

      const wait = await runProcessAction({ action: 'wait', id, timeout: 5 }, { sessionId: 's1' }, manager);
      expect(wait.output).toMatch(/exited exit 0/);
      expect(wait.output).toContain('end');

      const log = await runProcessAction({ action: 'log', id, offset: 2, limit: 2 }, { sessionId: 's1' }, manager);
      expect(log.output).toContain('lines 2-3 of 6');
      expect(log.output).toContain('row 2\nrow 3');
    });

    it('a wait that sees the exit suppresses the bash-done notice', async () => {
      const events: BackgroundExitEvent[] = [];
      manager.on('exit', e => events.push(e));
      const r = await bash({ command: 'sleep 0.2', background: true });
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      await runProcessAction({ action: 'wait', id, timeout: 5 }, { sessionId: 's1' }, manager);
      await new Promise(r2 => setTimeout(r2, 30));
      expect(events).toHaveLength(0);
    });

    it('wait times out and reports still running', async () => {
      const r = await bash({ command: 'sleep 5', background: true });
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      const wait = await runProcessAction({ action: 'wait', id, timeout: 0.1 }, { sessionId: 's1' }, manager);
      expect(wait.output).toMatch(/still running after waiting/);
    });

    it('kill stops the whole process group and suppresses the notice', async () => {
      const events: BackgroundExitEvent[] = [];
      manager.on('exit', e => events.push(e));
      const r = await bash({ command: 'sleep 30 & sleep 30; wait', background: true });
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      const kill = await runProcessAction({ action: 'kill', id }, { sessionId: 's1' }, manager);
      expect(kill.output).toMatch(/killed exit 143/);
      expect(events).toHaveLength(0);
    });

    it('write sends stdin to a background process', async () => {
      const r = await bash({ command: 'read line; echo "got:$line"', background: true });
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      const w = await runProcessAction({ action: 'write', id, input: 'hello\n' }, { sessionId: 's1' }, manager);
      expect(w.success).toBe(true);
      const wait = await runProcessAction({ action: 'wait', id, timeout: 5 }, { sessionId: 's1' }, manager);
      expect(wait.output).toContain('got:hello');
    });

    it('scopes processes to the session (or same user)', async () => {
      const r = await bash({ command: 'sleep 2', background: true }, {}, ctx('other-session', 'telegram:2'));
      const { id } = JSON.parse(r.output.split('\n')[1]) as { id: number };
      const poll = await runProcessAction({ action: 'poll', id }, { sessionId: 's1', userId: 'telegram:1' }, manager);
      expect(poll.success).toBe(false);
      const list = await runProcessAction({ action: 'list' }, { sessionId: 's1', userId: 'telegram:1' }, manager);
      expect(list.output).toBe('No background processes.');
      const sameUser = await runProcessAction({ action: 'poll', id }, { sessionId: 'child', userId: 'telegram:2' }, manager);
      expect(sameUser.success).toBe(true);
    });

    it('rejects unknown actions and missing ids', async () => {
      expect((await runProcessAction({ action: 'poll' }, { sessionId: 's1' }, manager)).output).toMatch(/"id" is required/);
      expect((await runProcessAction({ action: 'explode', id: 1 }, { sessionId: 's1' }, manager)).success).toBe(false);
    });
  });

  it('killAll stops every running process', async () => {
    const a = await bash({ command: 'sleep 30', background: true });
    const b = await bash({ command: 'sleep 30', background: true });
    const ids = [a, b].map(r => (JSON.parse(r.output.split('\n')[1]) as { id: number }).id);
    await manager.killAll(500);
    for (const id of ids) expect(manager.get(id)!.status).not.toBe('running');
  });

  it('registerShellTools registers native bash and process tools', () => {
    const registered: Array<{ name: string; handler?: unknown; frontmatter: { inputSchema?: { properties: Record<string, unknown> } } }> = [];
    registerShellTools({ registerSkill: (s) => { registered.push(s as never); } }, { manager });
    expect(registered.map(s => s.name)).toEqual(['bash', 'process']);
    expect(registered.every(s => typeof s.handler === 'function')).toBe(true);
    expect(Object.keys(registered[0].frontmatter.inputSchema!.properties)).toEqual(['command', 'timeout', 'background', 'cwd']);
  });
});
