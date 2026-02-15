/**
 * Realistic WebSocket Chat Health Check
 *
 * Boots a full E2E gateway, sends real multi-turn chat messages over WebSocket,
 * triggers a deep tick (gardener) to verify background processing still works
 * after removing B1.5 (Memory Fusion) and gap scanning from B7 (Inner Thoughts).
 *
 * Measures: connection latency, response times, message integrity, session
 * continuity, memory extraction, and deep tick completion.
 */

import { createE2EGateway, createWsClient, cleanupE2E } from './helpers.js';
import { BackgroundGardener } from '../memory/memory.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function elapsed(start: number): string {
  return `${Date.now() - start}ms`;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, passed: boolean, detail = '') {
  results.push({ name, passed, detail });
  const icon = passed ? '✅' : '❌';
  const suffix = detail ? ` (${detail})` : '';
  console.log(`    ${icon} ${name}${suffix}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  WebSocket Chat Health Check');
  console.log('  Post-refactor: B1.5 removed, B7 gap scan removed');
  console.log('═══════════════════════════════════════════════════\n');

  // ── 1. Boot server ──────────────────────────────────────────────────
  console.log('[1] Booting E2E gateway...');
  const bootStart = Date.now();

  const agentResponses = [
    "Hey there! I'd love to help you with your trip to Tokyo. What dates are you thinking? [DONE]",
    "Great choice! Late March is perfect for cherry blossoms. I'll note that you prefer window seats and vegetarian meals. Let me know if you need hotel recommendations too! [DONE]",
    "Here are some must-visit spots: Shinjuku Gyoen for cherry blossoms, Tsukiji Outer Market for food, and Akihabara if you're into tech. Want me to help plan a day-by-day itinerary? [DONE]",
    "Absolutely! I've noted your interests. I'll check in with you next week about your trip planning progress. Have a great day! [DONE]",
  ];

  const classificationNoop = JSON.stringify([
    { classification: 'NEW', confidence: 1.0, reason: 'new fact' },
  ]);

  const factExtractorResponses = [
    // Turn 1: extraction (no prior facts → no classification)
    JSON.stringify({
      facts: [
        { content: 'User is planning a trip to Tokyo', subject: 'user', category: 'event' },
      ],
      proactive_triggers: [],
    }),
    // Turn 2: extraction
    JSON.stringify({
      facts: [
        { content: 'User prefers window seats on flights', subject: 'user', category: 'preference' },
        { content: 'User is vegetarian', subject: 'user', category: 'preference' },
        { content: 'User is interested in cherry blossom season (late March)', subject: 'user', category: 'event' },
      ],
      proactive_triggers: [],
    }),
    // Turn 2: classification
    classificationNoop,
    // Turn 3: extraction
    JSON.stringify({
      facts: [
        { content: 'User wants to visit Shinjuku Gyoen, Tsukiji, and Akihabara in Tokyo', subject: 'user', category: 'event' },
      ],
      proactive_triggers: [],
    }),
    // Turn 3: classification
    classificationNoop,
    // Turn 4: extraction
    JSON.stringify({
      facts: [
        { content: 'User plans to review Tokyo trip itinerary next week', subject: 'user', category: 'event' },
      ],
      proactive_triggers: [
        {
          type: 'follow_up',
          kind: 'nudge',
          description: "How's the Tokyo trip planning going? Need help with anything?",
          trigger_time: '+7d',
          context: 'User mentioned reviewing itinerary next week',
        },
      ],
    }),
    // Turn 4: classification
    classificationNoop,
  ];

  const ctx = await createE2EGateway({
    responses: agentResponses,
    factExtractorResponses,
  });

  console.log(`    Server booted in ${elapsed(bootStart)}`);
  console.log(`    Listening on ws://127.0.0.1:${ctx.port}/ws\n`);

  // ── 2. Connect WebSocket ────────────────────────────────────────────
  console.log('[2] Connecting WebSocket client...');
  const connectStart = Date.now();
  const client = await createWsClient(ctx.port);
  const connectTime = Date.now() - connectStart;
  check('WebSocket connected', true, `${connectTime}ms`);

  // ── 3. Ping/pong ────────────────────────────────────────────────────
  console.log('\n[3] Ping/pong test...');
  const pingStart = Date.now();
  client.send({ type: 'ping' });
  const pong = await client.waitForResponse('pong', 5000);
  check('Ping/pong round-trip', pong.type === 'pong', elapsed(pingStart));

  // ── 4. Multi-turn chat conversation ─────────────────────────────────
  console.log('\n[4] Multi-turn conversation...');

  const turns = [
    { message: "Hi! I'm planning a trip to Tokyo. Can you help?", expectContains: 'Tokyo' },
    { message: "I'd like to go in late March. I prefer window seats and I'm vegetarian.", expectContains: 'cherry' },
    { message: "What are the must-visit places?", expectContains: 'Shinjuku' },
    { message: "Sounds great! Let's plan more next week. Thanks!", expectContains: 'noted' },
  ];

  let sessionId: string | undefined;
  const turnTimings: number[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const turnStart = Date.now();

    console.log(`\n    Turn ${i + 1}: "${turn.message.substring(0, 50)}..."`);

    const sendPayload: Record<string, unknown> = { type: 'chat', message: turn.message };
    if (sessionId) sendPayload.sessionId = sessionId;

    client.send(sendPayload);
    const messages = await client.collectUntilResponse(15000);
    const turnTime = Date.now() - turnStart;
    turnTimings.push(turnTime);

    // Find the response message
    const response = messages.find(m => m.type === 'response');

    check(
      `Turn ${i + 1} got response`,
      !!response,
      `${turnTime}ms, ${messages.length} message(s)`,
    );

    if (response) {
      // Capture session ID from first response
      if (!sessionId && response.sessionId) {
        sessionId = response.sessionId;
      }

      const content = response.content || '';
      const containsExpected = content.toLowerCase().includes(turn.expectContains.toLowerCase());
      check(
        `Turn ${i + 1} content valid`,
        containsExpected,
        containsExpected
          ? `contains "${turn.expectContains}"`
          : `missing "${turn.expectContains}" in: ${content.substring(0, 80)}`,
      );

      console.log(`    Agent: "${content.substring(0, 80)}..."`);
    }

    // Log intermediate message types
    const intermediateTypes = messages
      .filter(m => m.type !== 'response')
      .map(m => m.type);
    if (intermediateTypes.length > 0) {
      console.log(`    Intermediate: [${intermediateTypes.join(', ')}]`);
    }

    // Small delay for fact extraction to settle
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── 5. Session continuity ───────────────────────────────────────────
  console.log('\n[5] Session continuity...');
  check('Session ID assigned', !!sessionId, sessionId || 'none');

  // ── 6. Memory extraction check ──────────────────────────────────────
  console.log('\n[6] Memory extraction...');
  // Wait for async fact extraction to complete
  await new Promise(r => setTimeout(r, 3000));

  const db = ctx.scallopStore.getDatabase();
  const memories = db.getMemoriesByUser('default', { isLatest: true, limit: 50 });
  check('Memories stored', memories.length > 0, `${memories.length} memories`);

  const hasTokyoMemory = memories.some(m =>
    m.content.toLowerCase().includes('tokyo'),
  );
  check('Tokyo trip memory found', hasTokyoMemory);

  const hasPreferenceMemory = memories.some(m =>
    m.content.toLowerCase().includes('vegetarian') ||
    m.content.toLowerCase().includes('window seat'),
  );
  check('Preference memories found', hasPreferenceMemory);

  // ── 7. Scheduled items (proactive triggers) ─────────────────────────
  console.log('\n[7] Proactive triggers...');
  const deadline = Date.now() + 5000;
  let scheduledItems;
  while (Date.now() < deadline) {
    scheduledItems = db.getScheduledItemsByUser('default');
    if (scheduledItems.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
  scheduledItems = scheduledItems ?? db.getScheduledItemsByUser('default');
  check(
    'Proactive follow-up scheduled',
    scheduledItems.length > 0,
    `${scheduledItems.length} item(s)`,
  );

  // ── 8. Deep tick (gardener) ─────────────────────────────────────────
  console.log('\n[8] Deep tick (gardener consolidation)...');
  console.log('    Running deep tick to verify B1.5 removal and B7 changes...');

  const gardener = new BackgroundGardener({
    scallopStore: ctx.scallopStore,
    logger: (await import('pino')).default({ level: 'silent' }),
    fusionProvider: ctx.mockProvider,
    disableArchival: true,
  });

  const deepTickStart = Date.now();
  let deepTickError: string | null = null;
  try {
    await gardener.deepTick();
  } catch (err) {
    deepTickError = (err as Error).message;
  }
  const deepTickTime = Date.now() - deepTickStart;

  check(
    'Deep tick completed without error',
    deepTickError === null,
    deepTickError ?? `${deepTickTime}ms`,
  );

  // Verify memories still intact after deep tick
  const memoriesAfter = db.getMemoriesByUser('default', { isLatest: true, limit: 50 });
  check(
    'Memories intact after deep tick',
    memoriesAfter.length >= memories.length,
    `${memoriesAfter.length} memories (was ${memories.length})`,
  );

  // ── 9. Second connection (concurrent client) ────────────────────────
  console.log('\n[9] Concurrent client test...');
  const client2 = await createWsClient(ctx.port);
  client2.send({ type: 'chat', message: 'Hello from client 2!' });
  const client2Response = await client2.waitForResponse('response', 10000);
  check(
    'Concurrent client got response',
    client2Response.type === 'response',
    client2Response.content?.substring(0, 40) || 'no content',
  );
  await client2.close();

  // ── 10. Performance summary ─────────────────────────────────────────
  console.log('\n[10] Performance summary...');
  const avgTurnTime = turnTimings.reduce((a, b) => a + b, 0) / turnTimings.length;
  console.log(`    Avg turn response time: ${Math.round(avgTurnTime)}ms`);
  console.log(`    Deep tick time:         ${deepTickTime}ms`);
  console.log(`    WS connect time:        ${connectTime}ms`);
  console.log(`    Total memories:         ${memoriesAfter.length}`);
  console.log(`    Scheduled items:        ${scheduledItems.length}`);

  // ── Cleanup ─────────────────────────────────────────────────────────
  console.log('\n[11] Cleaning up...');
  await client.close();
  await cleanupE2E(ctx);

  // ── Final report ────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${total} CHECKS PASSED ✅`);
  } else {
    console.log(`  ${passed}/${total} PASSED, ${failed} FAILED ❌`);
    console.log('');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  FAIL: ${r.name} — ${r.detail}`);
    }
  }
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
