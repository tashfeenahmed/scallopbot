/** Executable wrapper for the MCP skill. */

import { handler, MCP_LIMITS, shutdownMcpClients } from '../run.js';

let shuttingDown = false;
function installShutdownHandler(signal: 'SIGTERM' | 'SIGINT'): void {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownMcpClients().finally(() => {
      process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    });
  });
}

installShutdownHandler('SIGTERM');
installShutdownHandler('SIGINT');

async function main(): Promise<void> {
  let args: Record<string, unknown>;
  const rawArgs = process.env.SKILL_ARGS || '{}';
  if (Buffer.byteLength(rawArgs, 'utf8') > MCP_LIMITS.maxOutboundRequestBytes) {
    process.stdout.write(JSON.stringify({ success: false, error: 'SKILL_ARGS exceeds MCP input limit' }));
    process.exitCode = 1;
    return;
  }
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    process.stdout.write(JSON.stringify({ success: false, error: 'Invalid SKILL_ARGS JSON' }));
    process.exitCode = 1;
    return;
  }

  const result = await handler({
    args,
    workspace: process.env.SKILL_WORKSPACE || process.cwd(),
    sessionId: process.env.SKILL_SESSION_ID || '',
    userId: process.env.SKILL_USER_ID,
  });
  process.stdout.write(JSON.stringify(result));
  if (!result.success) process.exitCode = 1;
}

void main();
