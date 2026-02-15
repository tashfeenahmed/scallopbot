/**
 * Live WebSocket E2E test for the nudge/task system.
 *
 * Boots a real server, connects via WebSocket, has a multi-turn conversation,
 * and verifies scheduled items are created with correct kind/taskConfig.
 * Prints all WebSocket messages to stdout for visibility.
 */

import { createE2EGateway, createWsClient, cleanupE2E } from './helpers.js';

async function main() {
  console.log('=== Nudge/Task WebSocket Live Test ===\n');

  // ── 1. Boot server ──────────────────────────────────────────────
  console.log('[1] Booting E2E gateway with mock providers...');

  const agentResponses = [
    "Hey! I see you have flight EK204 to Dubai on March 5th. I'll prepare the flight details for you ahead of time so you're all set! [DONE]",
    "Absolutely! I'll remind you to drink water regularly. Staying hydrated is important! [DONE]",
    "Of course! I'll check in with you about your Rust learning progress. Keep at it! [DONE]",
  ];

  // Provider call pattern per turn:
  //   Turn 1: extraction (1 call — classification skipped, no existing facts)
  //   Turn 2: extraction + classification (2 calls)
  //   Turn 3: extraction + classification (2 calls)
  // Total: 5 calls, so 5 responses needed in exact order.
  const classificationNoop = JSON.stringify([{ classification: 'NEW', confidence: 1.0, reason: 'new fact' }]);

  const factExtractorResponses = [
    // Call 0 — Turn 1 extraction: flight → task-kind trigger
    JSON.stringify({
      facts: [
        { content: 'User has flight EK204 to Dubai on March 5th', subject: 'user', category: 'event' },
      ],
      proactive_triggers: [
        {
          type: 'event_prep',
          kind: 'task',
          description: 'Prepare flight info for EK204 to Dubai',
          trigger_time: '+1h',
          context: 'User mentioned flight EK204 to Dubai on March 5th',
          guidance: 'Look up flight EK204 status and provide terminal/gate info',
          goal: 'Search for Emirates flight EK204 status and gate information',
          tools: ['web_search'],
        },
      ],
    }),
    // Call 1 — Turn 2 extraction: hydration reminder → nudge-kind trigger
    JSON.stringify({
      facts: [
        { content: 'User wants hydration reminders', subject: 'user', category: 'preference' },
      ],
      proactive_triggers: [
        {
          type: 'follow_up',
          kind: 'nudge',
          description: 'Time to drink some water! Stay hydrated.',
          trigger_time: '+2h',
          context: 'User asked for hydration reminders',
        },
      ],
    }),
    // Call 2 — Turn 2 classification (no-op, returns NEW)
    classificationNoop,
    // Call 3 — Turn 3 extraction: learning goal check-in → nudge-kind trigger
    JSON.stringify({
      facts: [
        { content: 'User is learning Rust programming', subject: 'user', category: 'interest' },
      ],
      proactive_triggers: [
        {
          type: 'goal_checkin',
          kind: 'nudge',
          description: "How's the Rust learning going? Made any progress on the borrow checker?",
          trigger_time: '+1d',
          context: 'User mentioned learning Rust',
        },
      ],
    }),
    // Call 4 — Turn 3 classification (no-op, returns NEW)
    classificationNoop,
  ];

  const ctx = await createE2EGateway({
    responses: agentResponses,
    factExtractorResponses,
  });

  console.log(`[✓] Server running on ws://127.0.0.1:${ctx.port}/ws\n`);

  // ── 2. Connect WebSocket client ─────────────────────────────────
  console.log('[2] Connecting WebSocket client...');
  const client = await createWsClient(ctx.port);
  console.log('[✓] Connected!\n');

  // ── 3. Multi-turn conversation ──────────────────────────────────
  const turns = [
    {
      label: 'Turn 1: Mention upcoming flight (should create TASK item)',
      message: "Hey! I have flight EK204 to Dubai on March 5th. Can you help me prepare?",
    },
    {
      label: 'Turn 2: Ask for reminder (should create NUDGE item)',
      message: "Also, can you remind me to drink water every couple hours?",
    },
    {
      label: 'Turn 3: Mention learning goal (should create NUDGE check-in)',
      message: "I've been trying to learn Rust lately. Can you check in on my progress sometime?",
    },
  ];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    console.log(`[3] ${turn.label}`);
    console.log(`    USER  → ${turn.message}`);

    client.send({ type: 'chat', message: turn.message });
    const messages = await client.collectUntilResponse(15000);

    for (const msg of messages) {
      if (msg.type === 'response') {
        console.log(`    AGENT ← ${msg.content}`);
      } else if (msg.type === 'thinking') {
        console.log(`    [thinking] ${(msg.content || '').substring(0, 80)}...`);
      } else {
        console.log(`    [${msg.type}] ${JSON.stringify(msg).substring(0, 100)}`);
      }
    }

    // Wait for fact extraction to complete before sending next message
    // so provider responses don't interleave
    console.log('    (waiting for fact extraction to settle...)');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('');
  }

  // ── 4. Wait for fact extraction (async background) ──────────────
  console.log('[4] Waiting for fact extraction to complete...');
  // Poll until all 3 items appear or timeout after 10s
  const db = ctx.scallopStore.getDatabase();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const current = db.getScheduledItemsByUser('default');
    console.log(`    ... ${current.length} item(s) so far (waiting for 3)`);
    if (current.length >= 3) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('[✓] Done waiting.');
  // Print provider call counts for debugging
  const factProvider = (ctx as unknown as Record<string, unknown>);
  console.log(`    Agent provider calls: ${ctx.mockProvider.callCount}`);
  // List all items including duplicates or other states
  const allItems = db.getScheduledItemsByUser('default');
  console.log(`    Total scheduled items: ${allItems.length}\n`);

  // ── 5. Verify DB state ──────────────────────────────────────────
  console.log('[5] Checking database for scheduled items...\n');
  const items = db.getScheduledItemsByUser('default');

  console.log(`    Found ${items.length} scheduled item(s):\n`);

  let allPassed = true;

  for (const item of items) {
    const triggerDate = new Date(item.triggerAt).toISOString();
    console.log(`    ┌─ Item: ${item.id}`);
    console.log(`    │  kind:       ${item.kind}`);
    console.log(`    │  type:       ${item.type}`);
    console.log(`    │  source:     ${item.source}`);
    console.log(`    │  message:    ${item.message.substring(0, 80)}`);
    console.log(`    │  triggerAt:  ${triggerDate}`);
    console.log(`    │  status:     ${item.status}`);
    if (item.taskConfig) {
      console.log(`    │  taskConfig: { goal: "${item.taskConfig.goal.substring(0, 60)}", tools: [${item.taskConfig.tools?.join(', ')}] }`);
    } else {
      console.log(`    │  taskConfig: null`);
    }
    console.log(`    └─`);
    console.log('');
  }

  // ── 6. Assertions ───────────────────────────────────────────────
  console.log('[6] Running assertions...\n');

  // Check task item
  const taskItem = items.find(i => i.kind === 'task');
  if (taskItem) {
    console.log('    ✅ PASS: Found task-kind item');
    if (taskItem.taskConfig?.goal?.includes('EK204')) {
      console.log('    ✅ PASS: taskConfig.goal contains "EK204"');
    } else {
      console.log('    ❌ FAIL: taskConfig.goal missing or does not contain "EK204"');
      allPassed = false;
    }
    if (taskItem.taskConfig?.tools?.includes('web_search')) {
      console.log('    ✅ PASS: taskConfig.tools includes "web_search"');
    } else {
      console.log('    ❌ FAIL: taskConfig.tools missing or does not include "web_search"');
      allPassed = false;
    }
    if (taskItem.type === 'event_prep') {
      console.log('    ✅ PASS: type is "event_prep"');
    } else {
      console.log(`    ❌ FAIL: type is "${taskItem.type}", expected "event_prep"`);
      allPassed = false;
    }
  } else {
    console.log('    ❌ FAIL: No task-kind item found');
    allPassed = false;
  }

  console.log('');

  // Check nudge items
  const nudgeItems = items.filter(i => i.kind === 'nudge');
  if (nudgeItems.length >= 2) {
    console.log(`    ✅ PASS: Found ${nudgeItems.length} nudge-kind items`);
  } else {
    console.log(`    ❌ FAIL: Expected ≥2 nudge items, found ${nudgeItems.length}`);
    allPassed = false;
  }

  const waterNudge = nudgeItems.find(i => i.message.includes('water'));
  if (waterNudge) {
    console.log('    ✅ PASS: Found nudge about water');
    if (waterNudge.taskConfig === null) {
      console.log('    ✅ PASS: Water nudge has null taskConfig');
    } else {
      console.log('    ❌ FAIL: Water nudge should have null taskConfig');
      allPassed = false;
    }
  } else {
    console.log('    ❌ FAIL: No nudge about water found');
    allPassed = false;
  }

  const rustNudge = nudgeItems.find(i => i.message.includes('Rust'));
  if (rustNudge) {
    console.log('    ✅ PASS: Found nudge about Rust');
    if (rustNudge.type === 'goal_checkin') {
      console.log('    ✅ PASS: Rust nudge type is "goal_checkin"');
    } else {
      console.log(`    ❌ FAIL: Rust nudge type is "${rustNudge.type}", expected "goal_checkin"`);
      allPassed = false;
    }
  } else {
    console.log('    ❌ FAIL: No nudge about Rust found');
    allPassed = false;
  }

  console.log('');

  // ── 7. Cleanup ──────────────────────────────────────────────────
  console.log('[7] Cleaning up...');
  await client.close();
  await cleanupE2E(ctx);
  console.log('[✓] Done.\n');

  // ── Summary ─────────────────────────────────────────────────────
  if (allPassed) {
    console.log('══════════════════════════════════════');
    console.log('  ALL ASSERTIONS PASSED ✅');
    console.log('══════════════════════════════════════');
  } else {
    console.log('══════════════════════════════════════');
    console.log('  SOME ASSERTIONS FAILED ❌');
    console.log('══════════════════════════════════════');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
