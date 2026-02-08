#!/usr/bin/env npx tsx
/**
 * WebSocket integration test script
 *
 * Connects to the running bot's WS endpoint, sends messages,
 * and prints all responses. Start the bot first with `npm run dev`
 * or `npx tsx src/cli.ts start`.
 *
 * Usage:
 *   npx tsx scripts/ws-test.ts                       # interactive REPL
 *   npx tsx scripts/ws-test.ts "What time is it?"     # one-shot message
 *   npx tsx scripts/ws-test.ts --test-timezone         # automated timezone test
 */

import WebSocket from 'ws';
import Database from 'better-sqlite3';
import * as readline from 'readline';

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const DB_PATH = process.env.DB_PATH || 'memories.db';

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Connection timed out — is the bot running? (tried ${WS_URL})`));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`Connected to ${WS_URL}\n`);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${err.message} — is the bot running?`));
    });
  });
}

function sendChat(ws: WebSocket, message: string, sessionId?: string) {
  const payload: Record<string, string> = { type: 'chat', message };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
}

/** Wait for a full response from the bot, returning content and sessionId. */
function waitForResponse(ws: WebSocket): Promise<{ content: string; sessionId?: string }> {
  return new Promise((resolve) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'response':
          ws.off('message', handler);
          resolve({ content: msg.content, sessionId: msg.sessionId });
          break;
        case 'thinking':
          process.stdout.write('(thinking...) ');
          break;
        case 'skill_start':
          console.log(`  [skill: ${msg.skill}]`);
          break;
        case 'skill_complete':
          console.log(`  [skill done: ${msg.skill}]`);
          break;
        case 'memory':
          console.log(`  [memory ${msg.action}: ${msg.message}]`);
          break;
        case 'debug':
          console.log(`  [debug: ${msg.message}]`);
          break;
        case 'error':
          ws.off('message', handler);
          resolve({ content: `ERROR: ${msg.error}` });
          break;
      }
    };
    ws.on('message', handler);
  });
}

// ── One-shot mode ──────────────────────────────────────────────────────
async function oneShot(message: string) {
  const ws = await connect();
  console.log(`> ${message}`);
  sendChat(ws, message);
  const { content } = await waitForResponse(ws);
  console.log(`\nBot: ${content}\n`);
  ws.close();
}

// ── Timezone integration test ──────────────────────────────────────────
async function testTimezone() {
  console.log('=== Timezone Integration Test ===\n');

  // Step 1: Connect and send first message to establish the user
  const ws = await connect();

  console.log('Step 1: Ask for time (expect UTC default)');
  sendChat(ws, 'What timezone am I in and what time is it?');
  const first = await waitForResponse(ws);
  console.log(`\nBot: ${first.content}\n`);

  const hasUtc = /UTC/i.test(first.content);
  console.log(`  → Contains "UTC": ${hasUtc ? 'YES ✓' : 'NO (may still be correct — check above)'}\n`);

  // Step 2: Figure out the WS user id from the bot_config table
  const db = new Database(DB_PATH);
  const rows = db.prepare("SELECT user_id, timezone FROM bot_config WHERE user_id LIKE 'ws-%' ORDER BY rowid DESC LIMIT 5").all() as any[];
  console.log('  Bot config WS users:', rows.map(r => `${r.user_id} (tz=${r.timezone})`).join(', '));

  // Find the most recently created ws- user (our connection)
  const wsUser = rows[0];
  if (!wsUser) {
    console.error('  ERROR: No WS user found in bot_config. Cannot continue.');
    db.close();
    ws.close();
    return;
  }

  // Step 3: Update their timezone to something obviously different
  const testTz = 'Asia/Tokyo';
  console.log(`\nStep 2: Setting timezone for ${wsUser.user_id} → ${testTz}`);
  db.prepare('UPDATE bot_config SET timezone = ? WHERE user_id = ?').run(testTz, wsUser.user_id);
  db.close();
  console.log('  Done.\n');

  // Step 4: Ask again (same connection, same user)
  console.log('Step 3: Ask for time again (expect Asia/Tokyo)');
  sendChat(ws, 'What timezone am I in now and what time is it?', first.sessionId);
  const second = await waitForResponse(ws);
  console.log(`\nBot: ${second.content}\n`);

  const hasTokyo = /Tokyo|JST|Japan/i.test(second.content);
  console.log(`  → Contains "Tokyo/JST/Japan": ${hasTokyo ? 'YES ✓' : 'NO ✗'}`);

  if (hasTokyo) {
    console.log('\n=== PASS: Timezone change was reflected ===\n');
  } else {
    console.log('\n=== INCONCLUSIVE: Check bot response above manually ===\n');
  }

  ws.close();
}

// ── Interactive REPL ───────────────────────────────────────────────────
async function repl() {
  const ws = await connect();
  let currentSession: string | undefined;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case 'response':
        if (msg.sessionId) currentSession = msg.sessionId;
        console.log(`\nBot: ${msg.content}\n`);
        rl.prompt();
        break;
      case 'thinking':
        process.stdout.write('(thinking...) ');
        break;
      case 'skill_start':
        console.log(`  [skill: ${msg.skill}]`);
        break;
      case 'skill_complete':
        console.log(`  [skill done: ${msg.skill}]`);
        break;
      case 'skill_error':
        console.log(`  [skill error: ${msg.skill} — ${msg.error}]`);
        break;
      case 'memory':
        console.log(`  [memory ${msg.action}: ${msg.message}]`);
        break;
      case 'debug':
        console.log(`  [debug: ${msg.message}]`);
        break;
      case 'error':
        console.error(`Error: ${msg.error}`);
        rl.prompt();
        break;
    }
  });

  ws.on('close', () => {
    console.log('\nDisconnected.');
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('Type a message and press Enter. Commands: /quit, /new (new session)\n');
  rl.prompt();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === '/quit' || text === '/exit') {
      ws.close();
      return;
    }
    if (text === '/new') {
      currentSession = undefined;
      console.log('(new session)\n');
      rl.prompt();
      return;
    }
    sendChat(ws, text, currentSession);
  });

  rl.on('close', () => {
    ws.close();
  });
}

// ── Main ───────────────────────────────────────────────────────────────
(async () => {
  try {
    const arg = process.argv[2];
    if (arg === '--test-timezone') {
      await testTimezone();
    } else if (arg && !arg.startsWith('-')) {
      await oneShot(arg);
    } else {
      await repl();
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
})();
