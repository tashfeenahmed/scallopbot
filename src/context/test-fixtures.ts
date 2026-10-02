/** Synthetic transcripts for context-management tests (not shipped behaviour). */
import type { ContentBlock, CompletionRequest, CompletionResponse, LLMProvider, Message } from '../providers/types.js';

export interface FixtureTurnOptions {
  /** Tool calls per turn. */
  tools?: number;
  /** Characters per tool result. */
  resultChars?: number;
}

/** Build `turns` complete turns: human → (tool_use → tool_result)×k → final answer. */
export function makeToolSession(turns: number, options: FixtureTurnOptions = {}): Message[] {
  const tools = options.tools ?? 2;
  const resultChars = options.resultChars ?? 2_000;
  const messages: Message[] = [];
  let callId = 0;
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: 'user', content: `Turn ${turn}: please check src/module${turn}.ts and run the tests (preference: use pnpm)` });
    for (let tool = 0; tool < tools; tool++) {
      const id = `call_${callId++}`;
      const isRead = tool % 2 === 0;
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use', id, name: isRead ? 'read_file' : 'bash',
          input: isRead ? { path: `src/module${turn}.ts`, start_line: 1, end_line: 200 } : { command: `npm test -- module${turn}` },
        }],
      });
      const body = isRead
        ? `export const value${turn} = ${turn};\n` + 'x'.repeat(resultChars)
        : `FAILED module${turn}.test.ts\nError: expected ${turn} got ${turn + 1}\nexit code: 1\n` + 'y'.repeat(resultChars);
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: body, is_error: !isRead && turn % 3 === 0 }],
      });
    }
    messages.push({ role: 'assistant', content: `Done with turn ${turn}. Commit a1b2c3d${turn % 10} pushed for PR #${100 + turn}.` });
  }
  return messages;
}

/** Validate provider tool pairing invariants; returns a list of violations. */
export function pairingViolations(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    const uses = message.content.filter(block => block.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>[];
    if (message.role === 'assistant' && uses.length > 0) {
      const next = messages[index + 1];
      if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
        problems.push(`tool_use at ${index} not followed by tool_result message`);
        return;
      }
      const results = next.content.filter(block => block.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>[];
      for (const use of uses) {
        if (!results.some(result => result.tool_use_id === use.id)) problems.push(`tool_use ${use.id} at ${index} has no result`);
      }
      const firstNonResult = next.content.findIndex(block => block.type !== 'tool_result');
      if (firstNonResult >= 0 && next.content.slice(firstNonResult).some(block => block.type === 'tool_result')) {
        problems.push(`tool_result blocks not first at ${index + 1}`);
      }
    }
    if (message.role === 'user') {
      const results = message.content.filter(block => block.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>[];
      if (results.length === 0) return;
      const previous = messages[index - 1];
      const prevUses = previous && previous.role === 'assistant' && Array.isArray(previous.content)
        ? previous.content.filter(block => block.type === 'tool_use').map(block => (block as { id: string }).id)
        : [];
      for (const result of results) {
        if (!prevUses.includes(result.tool_use_id)) problems.push(`orphan tool_result ${result.tool_use_id} at ${index}`);
      }
    }
  });
  return problems;
}

export class FakeProvider implements LLMProvider {
  name = 'fake';
  model = 'fake-model';
  requests: CompletionRequest[] = [];
  constructor(private readonly reply: string | ((request: CompletionRequest) => Promise<string> | string)) {}
  isAvailable(): boolean { return true; }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const text = typeof this.reply === 'function' ? await this.reply(request) : this.reply;
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: this.model };
  }
}

export const VALID_SUMMARY = [
  '## Goal', 'Fix the failing module tests.',
  '## Constraints & Preferences', 'Use pnpm.',
  '## Completed Actions', '1. READ src/module0.ts — ok [read_file]',
  '## Active State', 'Running tests.',
  '## Blocked', 'None',
  '## Key Decisions', 'Keep the API.',
  '## Errors & Fixes', 'expected 0 got 1',
  '## Relevant Files', 'src/module0.ts',
  '## Critical Context', 'None',
].join('\n');
