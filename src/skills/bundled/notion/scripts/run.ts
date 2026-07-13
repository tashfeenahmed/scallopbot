import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executeNotion, type NotionArgs } from './client.js';

function loadToken(): string {
  if (process.env.NOTION_TOKEN?.trim()) return process.env.NOTION_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), '.config', 'notion', 'api_key'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  try {
    const args = JSON.parse(process.env.SKILL_ARGS || '{}') as NotionArgs;
    const result = await executeNotion(args, { token: loadToken() });
    console.log(JSON.stringify({ success: true, output: result, exitCode: 0 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ success: false, error: message, exitCode: 1 }));
    process.exitCode = 1;
  }
}

await main();
