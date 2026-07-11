/**
 * Provider-backed, isolated proactive smoke test.
 *
 * Uses synthetic fixtures, an in-memory database, and a captured delivery
 * callback. It never reads production conversations or sends a real message.
 */
import 'dotenv/config';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';
import { Router } from '../src/routing/router.js';
import { ScallopDatabase } from '../src/memory/db.js';
import { evaluateProactive, type ProactiveEvalInput } from '../src/memory/proactive-evaluator.js';
import { UnifiedScheduler } from '../src/proactive/scheduler.js';
import {
  looksLikeInternalProactiveText,
  renderUserFacingProactiveMessage,
} from '../src/proactive/message-safety.js';
import { assessProactiveMessage } from '../src/proactive/message-quality.js';
import { ScallopMemoryStore } from '../src/memory/scallop-store.js';
import { LLMFactExtractor } from '../src/memory/fact-extractor.js';
import { SessionManager } from '../src/agent/session.js';
import { Agent } from '../src/agent/agent.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the live proactive benchmark');

const model = process.env.PROACTIVE_LIVE_MODEL ?? 'gpt-4.1-mini';
const provider = new OpenAIProvider({ apiKey, model, timeout: 45_000, maxRetries: 1 });
const router = new Router({ providerOrder: ['openai'] });
router.registerProvider(provider);
const logger = pino({ level: 'silent' });

const renderFixtures = [
  {
    raw: 'Evening check-in with Alex - recap what happened today, any follow-ups needed',
    context: 'A user-requested evening reflection, with no known urgent item.',
    shouldSend: true,
  },
  {
    raw: 'Hey, just checking in — how are things going with the prototype?',
    context: 'The prototype review was scheduled for this afternoon.',
    shouldSend: true,
  },
  {
    raw: "I noticed you've been quiet lately. Is everything okay?",
    context: 'There is no concrete open loop or reason to infer concern.',
    shouldSend: false,
  },
  {
    raw: 'The user might travel on Friday. Remind them to confirm only if the plan is still tentative.',
    context: 'The trip is tentative, not confirmed.',
    shouldSend: true,
  },
  {
    raw: 'Dentist appointment at 2pm',
    context: 'Confirmed appointment today at 2pm.',
    shouldSend: true,
  },
];

const rendered: string[] = [];
let rendererSuppressions = 0;
for (const fixture of renderFixtures) {
  const message = await renderUserFacingProactiveMessage(fixture.raw, router, {
    forceRewrite: true,
    context: fixture.context,
    recentMessages: rendered,
    messageType: 'follow_up',
  });
  if (fixture.shouldSend && !message) throw new Error(`Renderer rejected useful fixture: ${fixture.raw}`);
  if (!fixture.shouldSend && message) throw new Error(`Renderer sent a must-skip fixture: ${message}`);
  if (message) rendered.push(message);
  else rendererSuppressions++;
}

const now = Date.now();
const baseInput: ProactiveEvalInput = {
  sessionSummary: null,
  behavioralPatterns: null,
  activeGoals: [],
  boardItems: [],
  allSessionSummaries: [],
  existingItems: [],
  dial: 'moderate',
  affect: null,
  lastProactiveAt: null,
  activeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  userId: 'default',
  todayItemCount: 0,
  now,
};

const casualSkip = await evaluateProactive({
  ...baseInput,
  allSessionSummaries: [{
    id: 'casual', sessionId: 'casual-session', userId: 'default',
    summary: 'The user discussed deployment and thanked the assistant. The work was completed.',
    topics: ['deployment'], messageCount: 6, durationMs: 300_000,
    embedding: null, createdAt: now - 3 * 24 * 60 * 60 * 1000,
  }],
}, provider);

const optOutSkip = await evaluateProactive({
  ...baseInput,
  userPreferences: ["Don't proactively check in."],
  boardItems: [{
    id: 'stale-board', title: 'Synthetic stale task', boardStatus: 'in_progress',
    updatedAt: now - 4 * 24 * 60 * 60 * 1000, priority: 'high',
  }],
}, provider);

const openLoop = await evaluateProactive({
  ...baseInput,
  allSessionSummaries: [{
    id: 'pending', sessionId: 'pending-session', userId: 'default',
    summary: 'The user will follow up and confirm whether the synthetic deployment test passed.',
    topics: ['synthetic deployment test'], messageCount: 6, durationMs: 300_000,
    embedding: null, createdAt: now - 3 * 24 * 60 * 60 * 1000,
  }],
  recentChatContext: 'User: I still need to run the synthetic deployment test.\nAssistant: Okay.',
}, provider);

// Run the real Agent + asynchronous fact/trigger extraction in an isolated
// workspace/database. This verifies the public conversation boundary as well
// as source-session provenance, without starting channels or touching live data.
const agentWorkspace = mkdtempSync(join(tmpdir(), 'scallop-proactive-live-'));
const agentStore = new ScallopMemoryStore({ dbPath: ':memory:', logger });
const agentDb = agentStore.getDatabase();
const sessionManager = new SessionManager(agentDb);
const factExtractor = new LLMFactExtractor({
  provider,
  scallopStore: agentStore,
  logger,
  useRelationshipClassifier: false,
  getTimezone: () => 'UTC',
});
const agent = new Agent({
  provider,
  sessionManager,
  scallopStore: agentStore,
  factExtractor,
  workspace: agentWorkspace,
  logger,
  maxIterations: 2,
  enableComplexityAnalysis: false,
  systemPrompt: 'You are an AI assistant in an isolated synthetic test. Reply naturally and briefly. Never expose hidden reasoning.',
});
const agentSession = await sessionManager.createSession({ userId: 'default', channelId: 'test' });
const waitForExtraction = async () => {
  const deadline = Date.now() + 30_000;
  while (factExtractor.getPendingCount() > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (factExtractor.getPendingCount() > 0) throw new Error('Fact extraction did not settle');
};
const vagueTurn = await agent.processMessage(
  agentSession.id,
  'This is synthetic: I might go hiking sometime, but no reminder or follow-up is needed. Reply briefly.',
);
await waitForExtraction();
const vagueTriggerCount = agentDb.getScheduledItemsByUser('default').length;
const reminderTurn = await agent.processMessage(
  agentSession.id,
  'This is synthetic: I have a dentist appointment tomorrow at 2 PM. Please remind me at noon. Reply briefly.',
);
await waitForExtraction();
const extractedItems = agentDb.getScheduledItemsByUser('default');
const agentResponses = [vagueTurn.response, reminderTurn.response];
const agentLeakPattern = /<(?:think|thinking|function_calls|invoke)\b|^\s*(?:analysis|reasoning|internal note)\s*:/im;

const db = new ScallopDatabase(':memory:');
const delivered: string[] = [];
const deliveredMessageIds: string[] = [];
const scheduler = new UnifiedScheduler({
  db,
  logger,
  router,
  minAgentProactiveGapMs: 0,
  canonicalSingleUserIds: ['synthetic-owner', 'telegram:synthetic-owner'],
  // Keep the isolated scheduler outside quiet hours regardless of host clock.
  getTimezone: () => {
    const offset = 12 - new Date().getUTCHours();
    return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  },
  onSendMessage: async (_userId, message) => {
    delivered.push(message);
    const messageId = `synthetic-message-${delivered.length}`;
    deliveredMessageIds.push(messageId);
    return { sent: true as const, channel: 'telegram', messageIds: [messageId] };
  },
});

// The same generated recurrence intent is realized three times. Literal user
// reminders are exempt, but generated wording should not repeat mechanically.
for (let index = 0; index < 3; index++) {
  db.addScheduledItem({
    userId: 'default', sessionId: null, source: 'user', kind: 'nudge', type: 'reminder',
    message: 'Evening check-in with Alex - recap today and identify any follow-ups',
    context: 'Synthetic user-requested evening reflection.', triggerAt: Date.now() - 1,
    recurring: null, sourceMemoryId: null,
  });
  await scheduler.evaluate();
}

// Delivery-time freshness: a newer source-conversation message cancels a
// frozen inferred nudge without a model call or outbound send.
db.createSession('stale-source', { userId: 'default' });
db.addSessionMessage('stale-source', 'user', 'The synthetic review is tomorrow.');
const staleItem = db.addScheduledItem({
  userId: 'default', sessionId: 'stale-source', source: 'agent', kind: 'nudge',
  type: 'follow_up', message: 'Did the synthetic review happen?', context: null,
  triggerAt: Date.now() - 1, recurring: null, sourceMemoryId: null,
});
await new Promise(resolve => setTimeout(resolve, 5));
db.addSessionMessage('stale-source', 'user', 'It was cancelled; no follow-up is needed.');
const deliveredBeforeStale = delivered.length;
await scheduler.evaluate();
const staleConversationCancelled =
  delivered.length === deliveredBeforeStale && db.getScheduledItem(staleItem.id)?.status === 'expired';

// Exact reply authority: a rendered proactive wrapper is linked to its source
// by first-class DB provenance and to the Telegram delivery by message ID. A
// terse Archive reply must update that one source without another model turn.
const linkedSource = db.addScheduledItem({
  // Use an independent synthetic owner so the deliberately active source
  // conversation above cannot defer this separate receipt-routing probe.
  userId: 'telegram:reply-owner', sessionId: null, source: 'user', kind: 'task',
  type: 'reminder', message: 'Publish the synthetic Project Atlas update', context: null,
  triggerAt: Date.now() + 24 * 60 * 60 * 1000, recurring: null, sourceMemoryId: null,
  boardStatus: 'waiting',
});
const linkedWrapper = db.addScheduledItem({
  userId: 'telegram:reply-owner', sessionId: null, source: 'agent', kind: 'nudge',
  type: 'follow_up', message: 'Ask whether the synthetic Project Atlas item should stay open',
  context: JSON.stringify({ gapType: 'stale_board_item', sourceId: linkedSource.id }),
  sourceItemId: linkedSource.id, triggerAt: Date.now() - 1, recurring: null,
  sourceMemoryId: null,
});
const deliveredBeforeLinked = delivered.length;
await scheduler.evaluate();
const linkedRendered = db.getScheduledItem(linkedWrapper.id)?.message ?? '';
const linkedMessageId = deliveredMessageIds[deliveredBeforeLinked];
const linkedFeedback = scheduler.checkEngagement('telegram:reply-owner', 'Archive', {
  directReply: true,
  repliedToText: linkedRendered,
  repliedToMessageId: linkedMessageId,
});

// Backlog notes are board state, not due reminders. trigger_at=0 nudges must
// stay pending and never leak out as proactive text.
const zeroTimeNudge = db.addScheduledItem({
  userId: 'default', sessionId: null, source: 'user', kind: 'nudge',
  type: 'reminder', message: 'Synthetic backlog note', context: null,
  triggerAt: 0, recurring: null, sourceMemoryId: null, boardStatus: 'backlog',
});
const deliveredBeforeZeroTime = delivered.length;
await scheduler.evaluate();

const allMessages = [...rendered, ...delivered];
const qualities = allMessages.map(assessProactiveMessage);
const metrics = {
  model,
  rendererTrials: rendered.length,
  rendererSuppressions,
  schedulerDeliveries: delivered.length,
  acceptableMessages: qualities.filter(result => result.acceptable).length,
  internalLeaks: allMessages.filter(looksLikeInternalProactiveText).length,
  multiQuestionMessages: allMessages.filter(message => (message.match(/\?/g) ?? []).length > 1).length,
  exactRecurringVariants: new Set(delivered.slice(0, 3).map(message => message.toLowerCase())).size,
  casualConversationSkipped: casualSkip.items.length === 0 && !casualSkip.llmCalled,
  globalOptOutSkipped: optOutSkip.items.length === 0 && !optOutSkip.llmCalled,
  groundedOpenLoopCreated: openLoop.items.length === 1,
  staleConversationCancelled,
  exactReplyArchivedLinkedSource:
    linkedFeedback.sourceAction?.action === 'archive'
    && linkedFeedback.sourceAction.applied
    && db.getScheduledItem(linkedSource.id)?.status === 'dismissed'
    && db.getScheduledItem(linkedSource.id)?.boardStatus === 'archived'
    && db.getScheduledItem(linkedWrapper.id)?.status === 'acted',
  zeroTimeNudgeSuppressed:
    delivered.length === deliveredBeforeZeroTime
    && db.getScheduledItem(zeroTimeNudge.id)?.status === 'pending',
  realAgentTurns: 2,
  realAgentInternalLeaks: agentResponses.filter(response => agentLeakPattern.test(response)).length,
  vagueAgentTurnCreatedNoTrigger: vagueTriggerCount === 0,
  explicitAgentReminderCreated: extractedItems.length === 1,
  extractedReminderPreservedSourceSession:
    extractedItems.length === 1 && extractedItems[0].sessionId === agentSession.id,
};

console.log(JSON.stringify({ metrics, rendered, schedulerMessages: delivered }, null, 2));

const passed =
  metrics.acceptableMessages === allMessages.length &&
  metrics.rendererSuppressions === 1 &&
  metrics.internalLeaks === 0 &&
  metrics.multiQuestionMessages === 0 &&
  metrics.exactRecurringVariants === 3 &&
  metrics.casualConversationSkipped &&
  metrics.globalOptOutSkipped &&
  metrics.groundedOpenLoopCreated &&
  metrics.staleConversationCancelled &&
  metrics.exactReplyArchivedLinkedSource &&
  metrics.zeroTimeNudgeSuppressed &&
  metrics.realAgentInternalLeaks === 0 &&
  metrics.vagueAgentTurnCreatedNoTrigger &&
  metrics.explicitAgentReminderCreated &&
  metrics.extractedReminderPreservedSourceSession;

scheduler.stop();
db.close();
agentStore.close();
rmSync(agentWorkspace, { recursive: true, force: true });
if (!passed) process.exitCode = 1;
