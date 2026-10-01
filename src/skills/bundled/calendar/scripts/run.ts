import { executeCalendar, type CalendarArgs } from '../../../../integrations/calendar/actions.js';

async function main(): Promise<void> {
  try {
    const args = JSON.parse(process.env.SKILL_ARGS || '{}') as CalendarArgs;
    const output = await executeCalendar(args, {
      timeZone: process.env.SKILL_USER_TIMEZONE || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    console.log(JSON.stringify({ success: true, output, exitCode: 0 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ success: false, error: message, exitCode: 1 }));
    process.exitCode = 1;
  }
}

await main();
