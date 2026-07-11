import { recoverSessionFromBackup } from '../src/memory/session-backup-recovery.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const targetPath = value('--target');
const backupPath = value('--backup');
const sessionId = value('--session');
const confirmedSessionId = value('--confirm');
if (!targetPath || !backupPath || !sessionId || !confirmedSessionId) {
  console.error('Usage: npm run recover:session -- --target <db> --backup <db> --session <id> --confirm <same-id>');
  process.exit(2);
}

try {
  const result = recoverSessionFromBackup({ targetPath, backupPath, sessionId, confirmedSessionId });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
