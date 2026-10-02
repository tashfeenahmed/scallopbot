import { describe, expect, it } from 'vitest';
import { curlHttpErrorHint, detectMaskingWarnings, explainExitCode, exitCodeForSignal } from './analysis.js';
import { checkShellFloor } from './floor.js';

const HOME = '/home/owner';
const floor = (cmd: string, env: NodeJS.ProcessEnv = {}) => checkShellFloor(cmd, env, HOME);

describe('shell floor', () => {
  it.each([
    'rm -rf /',
    'rm -rf /*',
    'sudo rm -rf / ',
    'rm -fr ~',
    'rm -r -f ~/',
    'rm -rf $HOME',
    'rm -rf "$HOME"',
    'rm -rf ${HOME}/*',
    'rm --recursive --force /home/owner',
    'cd /tmp && rm -rf /',
    'rm -rf --no-preserve-root /',
    'mkfs.ext4 /dev/sdb1',
    'sudo mkfs -t ext4 /dev/sda',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'dd if=image.img of=/dev/nvme0n1',
    'dd if=pi.img of=/dev/mmcblk0 status=progress',
    ':(){ :|:& };:',
    'bomb(){ bomb|bomb& }; bomb',
  ])('blocks %s', (cmd) => {
    expect(floor(cmd).blocked).toBe(true);
  });

  it.each([
    'rm -rf ./build',
    'rm -rf /tmp/scratch',
    'rm -rf ~/projects/old-thing',
    'rm -rf $HOME/.cache/foo',
    'rm file.txt',
    'ls /',
    'dd if=/dev/zero of=./disk.img bs=1M count=10',
    'echo mkfs is dangerous',
    'grep -r "rm -rf /" docs',
    'curl --fail-with-body -X POST https://example.com -d x',
    'pip install requests',
  ])('allows %s', (cmd) => {
    expect(floor(cmd).blocked).toBe(false);
  });

  it('names the reason', () => {
    expect(floor('rm -rf /').reason).toMatch(/root filesystem/);
    expect(floor('rm -rf ~').reason).toMatch(/home directory/);
    expect(floor(':(){ :|:& };:').reason).toMatch(/fork bomb/);
  });

  it('SHELL_FLOOR=off disables it', () => {
    expect(floor('rm -rf /', { SHELL_FLOOR: 'off' }).blocked).toBe(false);
  });
});

describe('exit code explanations', () => {
  it('explains common codes', () => {
    expect(explainExitCode(0)).toBeNull();
    expect(explainExitCode(1)).toMatch(/general/);
    expect(explainExitCode(2)).toMatch(/misuse/);
    expect(explainExitCode(126)).toMatch(/not executable/);
    expect(explainExitCode(127)).toMatch(/not found.*install|install.*PATH/);
    expect(explainExitCode(124)).toMatch(/timed out/);
    expect(explainExitCode(130)).toMatch(/SIGINT/);
    expect(explainExitCode(137)).toMatch(/SIGKILL.*(OOM|out of memory)/);
    expect(explainExitCode(139)).toMatch(/segmentation fault/);
    expect(explainExitCode(141)).toMatch(/SIGPIPE.*harmless/);
    expect(explainExitCode(129)).toMatch(/signal 1/);
  });

  it('maps signals to shell exit codes', () => {
    expect(exitCodeForSignal('SIGKILL')).toBe(137);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
  });
});

describe('masking warnings', () => {
  it('warns on || echo and || true', () => {
    expect(detectMaskingWarnings('npm test || echo failed').join()).toMatch(/\|\| echo/);
    expect(detectMaskingWarnings('make || true').join()).toMatch(/\|\| true/);
  });

  it('warns on ; echo after a test/build command', () => {
    expect(detectMaskingWarnings('npx vitest run; echo done').join()).toMatch(/; echo/);
    expect(detectMaskingWarnings('cd x; echo hi')).toEqual([]);
  });

  it('warns on a pipe into head/tail/grep that hides the left side', () => {
    const w = detectMaskingWarnings('npm test 2>&1 | tail -20');
    expect(w.join()).toMatch(/pipefail/);
    expect(detectMaskingWarnings('python3 build.py | grep ERROR').join()).toMatch(/pipefail/);
  });

  it('stays quiet for harmless pipes and for pipefail', () => {
    expect(detectMaskingWarnings('ls -la | head')).toEqual([]);
    expect(detectMaskingWarnings('cat log.txt | grep x')).toEqual([]);
    expect(detectMaskingWarnings('set -o pipefail; npm test | tail -5')).toEqual([]);
    expect(detectMaskingWarnings('npm test && npm run build')).toEqual([]);
  });
});

describe('curl HTTP hint', () => {
  it('hints when a mutating curl without --fail got a 4xx/5xx', () => {
    expect(curlHttpErrorHint('curl -s -i -X POST https://x/api -d a=1', 'HTTP/2 404 \r\ncontent-type: x\r\n\r\n{}', 0)).toMatch(/HTTP 404/);
    expect(curlHttpErrorHint(`curl -s -o /dev/null -w '%{http_code}' -X DELETE https://x/1`, '500', 0)).toMatch(/HTTP 500/);
  });

  it('is silent with --fail, for GETs, for 2xx, and on non-zero exit', () => {
    expect(curlHttpErrorHint('curl --fail -X POST https://x -d a', 'HTTP/1.1 404 Not Found', 0)).toBeNull();
    expect(curlHttpErrorHint('curl -sf -X POST https://x -d a', 'HTTP/1.1 404 Not Found', 0)).toBeNull();
    expect(curlHttpErrorHint('curl -i https://x', 'HTTP/1.1 404 Not Found', 0)).toBeNull();
    expect(curlHttpErrorHint('curl -i -X POST https://x -d a', 'HTTP/1.1 201 Created', 0)).toBeNull();
    expect(curlHttpErrorHint('curl -i -X POST https://x -d a', 'HTTP/1.1 404 Not Found', 22)).toBeNull();
  });
});
