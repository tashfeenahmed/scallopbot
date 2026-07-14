import { describe, expect, it } from 'vitest';
import type { ToolUseContent } from '../providers/types.js';
import {
  assessToolCallForTurn,
  boundResponseToolCalls,
  boundToolCalls,
  digestToolOutput,
  isExternalBashMutation,
  isLikelyExternalMutation,
  localIsoDate,
  toolCallSignature,
  toolOperationIdentity,
  toolOutputIndicatesFailure,
  turnRequiresMutationReceipt,
  removeUnsupportedWorkoutComparisons,
} from './tool-safety.js';

const notionWrite = (input: Record<string, unknown>): ToolUseContent => ({
  type: 'tool_use', id: 'n1', name: 'notion', input,
});

const notionCurlCreate = (id = 'curl-notion'): ToolUseContent => ({
  type: 'tool_use', id, name: 'bash', input: {
    command: `curl -s -X POST https://api.notion.com/v1/pages \\
      -H "Content-Type: application/json" \\
      --data '{"parent":{"database_id":"gym"},"properties":{"Weight":{"number":14}}}'`,
  },
});

const boardAdd = (title: string, state = 'inbox'): ToolUseContent => ({
  type: 'tool_use', id: `board-${title}`, name: 'board', input: {
    action: 'add', kind: 'task', title, status: state,
  },
});

describe('turn-scoped tool safety', () => {
  it('blocks an unrequested sensitive external write', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', date: '2026-07-11' }),
      { userMessage: "I'm feeling sick and skipping the gym", timezone: 'Europe/Dublin', now: new Date('2026-07-11T12:00:00Z') },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/outside the current user request/i);
    expect(verdict.reason).not.toMatch(/confirmation/i);
  });

  it('allows an explicitly requested sensitive write', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', date: '2026-07-11' }),
      { userMessage: 'Log today that I am feeling sick', timezone: 'Europe/Dublin', now: new Date('2026-07-11T12:00:00Z') },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('accepts a natural prefixed request to log a workout without another confirmation', () => {
    const verdict = assessToolCallForTurn(
      notionCurlCreate(),
      {
        userMessage: 'For today, can you log my gym session in our Notion tracker? It was 14 kg, 8 reps, 3 sets.',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.isExternalMutation).toBe(true);
  });

  it.each(['Track this workout', 'Note this workout', 'Document this workout']) (
    'treats an outcome request as direct authorization: %s',
    (userMessage) => {
      const verdict = assessToolCallForTurn(
        notionCurlCreate(),
        { userMessage, timezone: 'Europe/Dublin' },
      );
      expect(verdict.allowed).toBe(true);
    },
  );

  it('binds a bare yes to a natural Notion confirmation for a bash-based write', () => {
    const verdict = assessToolCallForTurn(
      notionCurlCreate(),
      {
        userMessage: 'Yes',
        previousAssistantMessage: 'Confirm: Should I write these 4 exercises to your Notion Gym Volume Tracker now?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it.each([
    'Yes write to notion',
    'I explicitly instruct you to write to my Notion Gym Volume Tracker database',
    "I authorize you to create 4 new pages in my Notion Gym Volume Tracker database for today's workout",
  ])('accepts target-specific authorization without magic wording: %s', (userMessage) => {
    const verdict = assessToolCallForTurn(
      notionCurlCreate(),
      {
        userMessage,
        previousAssistantMessage: 'Should I write these four gym exercises to your Notion tracker now?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not mistake an informational “update me on” request for write consent', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'update', page: 'health-dashboard' }),
      { userMessage: 'Update me on my health dashboard', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/external write/i);
  });

  it('does not treat bare confirmation as consent without a matching prior prompt', () => {
    const noPrior = assessToolCallForTurn(
      notionWrite({ action: 'create' }),
      { userMessage: 'yes', timezone: 'Europe/Dublin' },
    );
    const unrelatedPrior = assessToolCallForTurn(
      notionWrite({ action: 'create' }),
      {
        userMessage: 'go ahead',
        previousAssistantMessage: 'Should I send that email through Gmail?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(noPrior.allowed).toBe(false);
    expect(unrelatedPrior.allowed).toBe(false);
  });

  it('binds confirmation to the immediately prior target and action', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', note: 'project update' }),
      {
        userMessage: 'yes',
        previousAssistantMessage: 'This will create a project entry in Notion. Shall I proceed?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not treat an incidental integration noun as a write command', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'g1', name: 'gmail', input: { action: 'send' } },
      { userMessage: 'Can you summarize the email?', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
  });

  it('treats a progress message to the active conversation as part of replying', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'm1', name: 'send_message', input: { message: 'Still working on it.' } },
      { userMessage: 'Please refactor the project', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.isExternalMutation).toBe(true);
  });

  it('inspects payload sensitivity instead of trusting unrelated generic intent', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', note: 'medical diagnosis from an older turn' }),
      { userMessage: 'Log this item', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/sensitive/i);
  });

  it('fails closed for an undeclared mutating integration', () => {
    const strava: ToolUseContent = {
      type: 'tool_use', id: 's1', name: 'strava',
      input: { action: 'create', note: 'medical diagnosis' },
    };
    expect(isLikelyExternalMutation(strava)).toBe(true);
    const verdict = assessToolCallForTurn(
      strava,
      { userMessage: 'Show me my recent training', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
  });

  it('intent-locks local writes while allowing an explicit fix request', () => {
    const write: ToolUseContent = {
      type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'notes.md', content: 'x' },
    };
    const informational = assessToolCallForTurn(
      write,
      { userMessage: 'Explain how to fix the project', timezone: 'Europe/Dublin' },
    );
    const requested = assessToolCallForTurn(
      write,
      { userMessage: 'Fix the project', timezone: 'Europe/Dublin' },
    );
    expect(informational.allowed).toBe(false);
    expect(informational.isExternalMutation).toBe(false);
    expect(requested.allowed).toBe(true);
  });

  it('treats a priorities-list reply as authorization to capture board items', () => {
    const verdict = assessToolCallForTurn(
      boardAdd('Personal projects'),
      {
        userMessage: 'Gym\nPersonal projects\nWork projects\nMeetings\nPut the bin out at 7pm',
        previousAssistantMessage: "What's your main priority for today?",
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not mark today\'s task done from an older accomplishment', () => {
    const verdict = assessToolCallForTurn(
      boardAdd('Gym', 'done'),
      {
        userMessage: 'Gym\nPersonal projects\nWork projects\nMeetings\nPut the bin out at 7pm',
        previousAssistantMessage: "What's your main priority for today?",
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('TASK_COMPLETION_EVIDENCE_REQUIRED');
    expect(verdict.reason).toMatch(/older memory/i);
  });

  it('allows an explicit current-turn completion', () => {
    const verdict = assessToolCallForTurn(
      boardAdd('Gym', 'done'),
      { userMessage: 'Mark Gym done', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('keeps a corrected new-day task pending without another permission prompt', () => {
    const verdict = assessToolCallForTurn(
      boardAdd('Gym', 'in_progress'),
      {
        userMessage: 'Today is a new day. Gym not done.',
        previousAssistantMessage: 'Should I add these tasks to your board and set the reminder?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('blocks an unrelated board write without asking the user for permission', () => {
    const verdict = assessToolCallForTurn(
      boardAdd('Invented task'),
      { userMessage: 'Explain my priorities', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/outside the current user request/i);
    expect(verdict.reason).toMatch(/do not ask for permission/i);
  });

  it.each(['Build the PDF', 'Render the report', 'Compile the document', 'Export the analysis']) (
    'recognizes explicit artifact mutation intent: %s',
    (userMessage) => {
      const verdict = assessToolCallForTurn(
        { type: 'tool_use', id: 'build-1', name: 'run_code', input: { language: 'python', code: 'write_pdf()' } },
        { userMessage, timezone: 'Europe/Dublin' },
      );
      expect(verdict.allowed).toBe(true);
    },
  );

  it('allows a local correction when the user says the delivered artifact was wrong', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'fix-artifact', name: 'run_code', input: { language: 'python', code: 'write_pdf()' } },
      {
        userMessage: 'This is the old one, not the typist one!',
        previousAssistantMessage: 'Sent! The new PDF is in Telegram.',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('extracts a direct send request after a Telegram reply wrapper', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'send-reply', name: 'send_file', input: { file_path: 'output/report.pdf' } },
      {
        userMessage: '[Replying to You (assistant): "The PDF is ready."]\n\nSend it to me',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('binds bare confirmation to the requested send action, not incidental “external write” prose', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'send-confirmed', name: 'send_file', input: { file_path: 'output/report.pdf' } },
      {
        userMessage: 'Yes',
        previousAssistantMessage: 'The system needs confirmation for this external write. Confirm: Send the PDF now?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('blocks ambiguous shorthand before structured external writes', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', sets: 4, reps: 3 }),
      { userMessage: 'Log 14kg each hand and 4x3', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/ambiguous/i);
  });

  it('accepts conventional three-part workout notation in an active logging thread', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({
        action: 'create', name: 'Leg Press', sets: 3, reps: 8, weight_kg: 110,
      }),
      {
        userMessage: 'Leg press - 3x8x110kg',
        previousAssistantMessage: 'Leg curls were logged to your Notion tracker. Anything else to add?',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('blocks a model-generated date that conflicts with today in the user timezone', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({ action: 'create', workout_date: '2026-07-10' }),
      { userMessage: 'Log this for today', timezone: 'Europe/Dublin', now: new Date('2026-07-11T12:00:00Z') },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('2026-07-11');
  });

  it('uses calendar dates rather than server-local arithmetic', () => {
    expect(localIsoDate(new Date('2026-01-01T00:30:00Z'), 'America/Los_Angeles')).toBe('2025-12-31');
  });

  it('produces stable signatures independent of object key order', () => {
    expect(toolCallSignature(notionWrite({ a: 1, b: 2 })))
      .toBe(toolCallSignature(notionWrite({ b: 2, a: 1 })));
  });

  it('builds stable privacy-safe operation identities', () => {
    const first = toolOperationIdentity('s1', 'Send this email', notionWrite({ b: 2, a: 1 }));
    const retry = toolOperationIdentity('s1', '  send   this EMAIL ', notionWrite({ a: 1, b: 2 }));
    expect(first).toEqual(retry);
    expect(first.operationId).toHaveLength(64);
    expect(JSON.stringify(first)).not.toContain('email');
  });

  it('detects mutating shell clients beyond curl', () => {
    expect(isExternalBashMutation('wget --method=POST https://example.com/items')).toBe(true);
    expect(isExternalBashMutation(`python -c "import requests; requests.post('https://example.com')"`)).toBe(true);
    expect(isExternalBashMutation(`node -e "fetch('https://example.com',{method:'PATCH'})"`)).toBe(true);
    expect(isExternalBashMutation('http POST https://example.com/items name=x')).toBe(true);
    expect(isExternalBashMutation('curl https://example.com/items')).toBe(false);
    expect(isExternalBashMutation('wget --method=POST http://localhost:3000/items')).toBe(false);
  });

  it('treats Notion POST query endpoints as read-only', () => {
    const query = `curl -s -X POST https://api.notion.com/v1/databases/db-id/query \\
      -H "Content-Type: application/json" --data '{"page_size":1}'`;
    expect(isExternalBashMutation(query)).toBe(false);
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'notion-query', name: 'bash', input: { command: query } },
      { userMessage: 'Show me the latest workout entry', timezone: 'Europe/Dublin' },
    );
    expect(verdict.allowed).toBe(true);
    expect(isExternalBashMutation(
      'curl -X DELETE https://api.notion.com/v1/databases/db-id/query',
    )).toBe(true);
    expect(isExternalBashMutation(
      `curl -s --fail-with-body -X POST https://api.notion.com/v1/search --data '{"query":"gym"}'`,
    )).toBe(false);
    expect(isExternalBashMutation(
      `curl -s --fail-with-body -X POST https://api.notion.com/v1/data_sources/$DATA_SOURCE_ID/query --data '{"page_size":5}'`,
    )).toBe(false);
  });

  it('classifies an external write inside run_code as external and honors the active request', () => {
    const tool: ToolUseContent = {
      type: 'tool_use',
      id: 'run-code-notion',
      name: 'run_code',
      input: {
        language: 'python',
        code: `import requests\nrequests.post('https://api.notion.com/v1/pages', json={'Weight': 14})`,
      },
    };
    expect(isLikelyExternalMutation(tool)).toBe(true);
    const allowed = assessToolCallForTurn(
      tool,
      { userMessage: 'Write this workout to my Notion tracker', timezone: 'Europe/Dublin' },
    );
    const blocked = assessToolCallForTurn(
      tool,
      { userMessage: 'Explain how the Notion tracker works', timezone: 'Europe/Dublin' },
    );
    expect(allowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(blocked.isExternalMutation).toBe(true);
  });

  it('lets a sub-agent execute the user-authorized Notion write it was assigned', () => {
    const verdict = assessToolCallForTurn(
      notionCurlCreate(),
      {
        userMessage: 'Write 4 workout entries to the user\'s Notion Gym Volume Tracker database.',
        timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('recognizes typed and HTTP failures despite a zero process exit', () => {
    expect(toolOutputIndicatesFailure('{"success":false,"error":"bad"}')).toBe(true);
    expect(toolOutputIndicatesFailure('HTTP/2 429')).toBe(true);
    expect(toolOutputIndicatesFailure('{"success":true,"status":201}')).toBe(false);
    expect(toolOutputIndicatesFailure('Logging: Pushups\n✓ Pushups logged - ID: ERROR')).toBe(true);
    expect(toolOutputIndicatesFailure('Step one completed\nError: validation failed')).toBe(true);
  });

  it('requires a mutation receipt for structured continuation data', () => {
    expect(turnRequiresMutationReceipt(
      'Leg press - 3x8x110kg',
      'Leg curls were logged to your Notion tracker. Anything else to add?',
    )).toBe(true);
    expect(turnRequiresMutationReceipt('How many reps did I do?', 'Your tracker is in Notion.')).toBe(false);
  });

  it('binds a generic workout continuation to the exact recently successful tool', () => {
    const previous = 'Want me to add those last two exercises to your workout log?';
    expect(turnRequiresMutationReceipt('Yes!', previous, 'notion')).toBe(true);
    expect(turnRequiresMutationReceipt('Yes!', previous)).toBe(false);

    const notion = assessToolCallForTurn(
      notionWrite({ action: 'create', name: 'Seated Cable Row', weight_kg: 65 }),
      {
        userMessage: 'Yes!', previousAssistantMessage: previous,
        continuationMutationTool: 'notion', timezone: 'Europe/Dublin',
      },
    );
    expect(notion.allowed).toBe(true);

    const wrongExternalTool = assessToolCallForTurn(
      { type: 'tool_use', id: 'wrong-mail', name: 'gmail', input: { action: 'send', body: 'workout' } },
      {
        userMessage: 'Yes!', previousAssistantMessage: previous,
        continuationMutationTool: 'gmail', timezone: 'Europe/Dublin',
      },
    );
    expect(wrongExternalTool.allowed).toBe(false);

    const board = assessToolCallForTurn(
      { type: 'tool_use', id: 'wrong-fallback', name: 'board', input: { action: 'add', title: 'Log workout' } },
      {
        userMessage: 'Yes!', previousAssistantMessage: previous,
        continuationMutationTool: 'notion', timezone: 'Europe/Dublin',
      },
    );
    expect(board.allowed).toBe(false);
  });

  it('rejects exercise modalities invented by a structured write', () => {
    const verdict = assessToolCallForTurn(
      notionWrite({
        action: 'create', name: 'Dumbbell Chest Press', notes: '15kg each arm',
      }),
      {
        userMessage: 'Chest press - 15kgx10x3',
        previousAssistantMessage: 'Your workout was logged to your Notion tracker. Anything else to add?',
        continuationMutationTool: 'notion', timezone: 'Europe/Dublin',
      },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('STRUCTURED_LABEL_EXPANSION');
  });

  it('removes a workout PR claim when only a write receipt exists', () => {
    const cleaned = removeUnsupportedWorkoutComparisons(
      'All logged. Seated Cable Row was a 5kg jump and a new PR.',
      'Seated cable row - 65kgx8x3',
      false,
    );
    expect(cleaned).toEqual({ response: 'All logged.', removed: true });
    expect(removeUnsupportedWorkoutComparisons(
      'That is a new PR.', 'I hit a new PR today', false,
    ).removed).toBe(false);
    expect(removeUnsupportedWorkoutComparisons(
      'That is a new PR.', 'Compare this workout', true,
    ).removed).toBe(false);
  });

  it('creates privacy-safe deterministic output evidence', () => {
    const receipt = digestToolOutput('private tool payload');
    expect(receipt.outputBytes).toBe(20);
    expect(receipt.outputDigest).toHaveLength(64);
    expect(JSON.stringify(receipt)).not.toContain('private tool payload');
  });

  it('bounds malformed batches and rejects duplicate ids/calls', () => {
    const calls: ToolUseContent[] = [
      { type: 'tool_use', id: '1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: '1', name: 'read_file', input: { path: 'b' } },
      { type: 'tool_use', id: '3', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: '4', name: 'read_file', input: { path: 'c' } },
    ];
    const bounded = boundToolCalls(calls, 1);
    expect(bounded.accepted.map((call) => call.id)).toEqual(['1']);
    expect(bounded.dropped.map((entry) => entry.reason)).toEqual([
      'duplicate_id', 'duplicate_call', 'limit',
    ]);
  });

  it('rejects an anomalous response as a whole instead of executing an arbitrary prefix', () => {
    const calls: ToolUseContent[] = Array.from({ length: 65 }, (_, index) => ({
      type: 'tool_use', id: `call-${index}`, name: 'read_file', input: { path: `${index}` },
    }));

    const bounded = boundResponseToolCalls(calls, 64);

    expect(bounded.anomalousBurst).toBe(true);
    expect(bounded.accepted).toHaveLength(0);
    expect(bounded.dropped).toHaveLength(65);
  });
});
