import { loadEmailSettings } from '../../../../integrations/email/config.js';
import { executeEmail, type EmailArgs } from '../../../../integrations/email/actions.js';

async function main(): Promise<void> {
  try {
    const args = JSON.parse(process.env.SKILL_ARGS || '{}') as EmailArgs;
    const output = await executeEmail(args, { settings: loadEmailSettings() });
    console.log(JSON.stringify({ success: true, output, exitCode: 0 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ success: false, error: message, exitCode: 1 }));
    process.exitCode = 1;
  }
}

await main();
