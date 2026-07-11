import { compactCompletedConversationHistory } from '../src/memory/session-message-view.js';
import { boundToolCalls } from '../src/agent/tool-safety.js';
import { rerankResults } from '../src/memory/reranker.js';
import {
  buildEvidenceClaimLedger,
  verifyResponseEvidenceClaims,
} from '../src/security/evidence-grounding.js';
import type { LLMProvider, Message, ToolUseContent } from '../src/providers/types.js';

function replayFixture(): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < 10; index++) {
    messages.push(
      { role: 'user', content: `question ${index}` },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't'.repeat(2_000) },
          { type: 'tool_use', id: `tool-${index}`, name: 'bash', input: { command: 'x'.repeat(500) } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: 'o'.repeat(8_000) }],
      },
      { role: 'assistant', content: `answer ${index}` },
    );
  }
  messages.push({ role: 'user', content: 'current request' });
  return messages;
}

async function main(): Promise<void> {
  const raw = replayFixture();
  const replay = compactCompletedConversationHistory(raw);
  const rawBytes = Buffer.byteLength(JSON.stringify(raw));
  const replayBytes = Buffer.byteLength(JSON.stringify(replay));

  const malformedCalls: ToolUseContent[] = Array.from({ length: 186 }, (_, index) => ({
    type: 'tool_use', id: `call-${index}`, name: 'read_file', input: { path: `file-${index}` },
  }));
  const bounded = boundToolCalls(malformedCalls, 8);

  const stalledProvider: LLMProvider = {
    name: 'benchmark-stalled',
    isAvailable: () => true,
    complete: async () => new Promise(() => {}),
  };
  const rerankStarted = Date.now();
  await rerankResults(
    'benchmark query',
    [{ id: 'memory', content: 'benchmark memory', originalScore: 0.7 }],
    stalledProvider,
    { timeoutMs: 50 },
  );
  const rerankFallbackMs = Date.now() - rerankStarted;

  const evidenceLedger = buildEvidenceClaimLedger('Source reports 455 subscribers and 2,350 views.');
  const matchingClaim = verifyResponseEvidenceClaims(
    'There are 455 subscribers and 2.35K views.',
    [evidenceLedger],
  );
  const fabricatedClaim = verifyResponseEvidenceClaims(
    'There are 999 subscribers and 2.35K views.',
    [evidenceLedger],
  );

  const replayReductionPercent = Number(((1 - replayBytes / rawBytes) * 100).toFixed(1));
  const toolReductionPercent = Number((bounded.dropped.length / malformedCalls.length * 100).toFixed(1));
  const passed = replayReductionPercent >= 90
    && bounded.accepted.length <= 8
    && rerankFallbackMs <= 500
    && matchingClaim.passed
    && !fabricatedClaim.passed;

  console.log(JSON.stringify({
    passed,
    replay: {
      rawMessages: raw.length,
      replayMessages: replay.length,
      rawBytes,
      replayBytes,
      reductionPercent: replayReductionPercent,
    },
    malformedToolBatch: {
      emitted: malformedCalls.length,
      executable: bounded.accepted.length,
      rejected: bounded.dropped.length,
      reductionPercent: toolReductionPercent,
    },
    stalledReranker: {
      fallbackMs: rerankFallbackMs,
      configuredBudgetMs: 50,
    },
    evidenceGrounding: {
      matchingClaimAccepted: matchingClaim.passed,
      fabricatedClaimRejected: !fabricatedClaim.passed,
      storedRawValues: JSON.stringify(evidenceLedger).includes('455'),
    },
  }, null, 2));

  if (!passed) process.exitCode = 1;
}

await main();
