import { describe, expect, it } from 'vitest';
import type { ToolUseContent } from '../providers/types.js';
import {
  assessToolCallForTurn,
  describeToolCallForUser,
  isLikelyMutation,
  turnRequiresMutationReceipt,
} from './tool-safety.js';

// Real user messages from the Charlie transcripts (13 Jul – 2 Sep 2026) that
// were wrongly blocked with SAFETY_EXTERNAL_INTENT_REQUIRED (B1), plus the
// genuinely unrequested writes that must stay blocked.

const TZ = 'Europe/Dublin';
const NOW = new Date('2026-08-20T12:00:00Z'); // 2026-08-20 in Dublin

const notionCreate = (input: Record<string, unknown> = {}): ToolUseContent => ({
  type: 'tool_use', id: 'n-create', name: 'notion', input: { action: 'create', ...input },
});

const gymCreate = notionCreate({
  database_id: '1801c5f6-386c-927e-228b-2a0b29321df0',
  properties: {
    Name: { title: [{ text: { content: 'Pectoral machine' } }] },
    Date: { date: { start: '2026-08-20' } },
    Sets: { number: 3 },
    Reps: { number: 6 },
    'Weight (kg)': { number: 45 },
  },
});

describe('B1: write verbs anywhere in a multi-line message', () => {
  it.each([
    'In my notion tracker log this for today\n\nPectoral machine 45kgx6x3',
    'Leg day today: \n\nStairmaster 8 min \nTotal ab - 60kg x3x8\nLeg ext - 50kgx8x3\n\nLog in notion tracker',
    'Stairmaster 9:30 min\nTotal abdominal 3x9x60kg\nLog it',
    'Note down leg curls - 40kgx8x3',
    'Add these:\n\nfor August 20.\n* Stairmaster — 10 min\n* Leg press — 3x8x110kg',
  ])('allows a notion create for: %j', (userMessage) => {
    const verdict = assessToolCallForTurn(gymCreate, { userMessage, timezone: TZ, now: NOW });
    expect(verdict.allowed).toBe(true);
    expect(verdict.isExternalMutation).toBe(true);
    expect(turnRequiresMutationReceipt(userMessage)).toBe(true);
  });

  it('does not let an incidental line-start verb hide the real request', () => {
    const userMessage = 'Set 3 was heavy today\nLeg press - 3x8x110kg\nLog it';
    const verdict = assessToolCallForTurn(gymCreate, { userMessage, timezone: TZ, now: NOW });
    expect(verdict.allowed).toBe(true);
  });

  it('still excludes an informational "update me on" request', () => {
    const verdict = assessToolCallForTurn(
      notionCreate({ action: 'update', page: 'tracker' }),
      { userMessage: 'Morning!\nUpdate me on my tracker', timezone: TZ, now: NOW },
    );
    expect(verdict.allowed).toBe(false);
    expect(turnRequiresMutationReceipt('Morning!\nUpdate me on my tracker')).toBe(false);
  });

  it('keeps the relative-date mismatch check with an actionable reason', () => {
    const verdict = assessToolCallForTurn(
      gymCreate,
      { userMessage: 'Log this for today\n\nPectoral machine 45kgx6x3', timezone: TZ, now: new Date('2026-08-21T12:00:00Z') },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('2026-08-21');
    expect(verdict.reason).toContain('2026-08-20');
    expect(verdict.reason).toMatch(/^BLOCKED: the user said 'today'/);
    expect(verdict.reason).toMatch(/Retry the same notion call/);
  });
});

describe('B1: session-established workflow continuation', () => {
  const payload = 'Pectoral machine - 40kg x9x3\nSeated cable row - 65kgx8x3';

  it('allows more structured data for the tool that already wrote this session', () => {
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage: payload,
      previousAssistantMessage: 'Nice one, strong leg day!',
      continuationMutationTool: 'notion',
      timezone: TZ,
      now: NOW,
    });
    expect(verdict.allowed).toBe(true);
    expect(turnRequiresMutationReceipt(payload, 'Nice one, strong leg day!', 'notion')).toBe(true);
  });

  it('matches the continuation tool case-insensitively and without a prior reply', () => {
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage: payload, continuationMutationTool: 'Notion', timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(true);
    expect(turnRequiresMutationReceipt(payload, undefined, 'Notion')).toBe(true);
  });

  it('does not extend the workflow to a different external tool', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'g', name: 'gmail', input: { action: 'send', body: payload } },
      { userMessage: payload, continuationMutationTool: 'notion', timezone: TZ, now: NOW },
    );
    expect(verdict.allowed).toBe(false);
  });

  it('does not treat a read-only question with numbers as a continuation', () => {
    const userMessage = 'Did I log the 40kg x9x3 pectoral set?';
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage, continuationMutationTool: 'notion', timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(false);
    expect(turnRequiresMutationReceipt(userMessage, undefined, 'notion')).toBe(false);
  });
});

describe('B1: affirmative follow-ups bind to the proposed or failed write', () => {
  const failed = "I couldn't add those to your Notion tracker — the integration returned 404.";
  const proposed = 'I have everything ready to log: Stairmaster 8 min, Leg ext 3×8 @ 50 kg. Add them all now?';
  const bashNotionCreate: ToolUseContent = {
    type: 'tool_use', id: 'curl', name: 'bash', input: {
      command: `curl -s -X POST https://api.notion.com/v1/pages -d '{"parent":{"database_id":"gym"}}'`,
    },
  };

  it.each([
    'Yes',
    'Yes!',
    'Yes try again. You can',
    'You have the access - use the skill',
    'Try adding it like u did for others',
    'Add them',
    'Do it',
    'Go ahead and log it',
  ])('after a failure report naming the target: %j', (userMessage) => {
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage, previousAssistantMessage: failed, timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(true);
    expect(turnRequiresMutationReceipt(userMessage, failed)).toBe(true);
  });

  it.each(['Yes', 'Yes!', 'Add them', 'Do it', 'Go ahead and log it'])(
    'after a proposal with no target token: %j',
    (userMessage) => {
      const verdict = assessToolCallForTurn(gymCreate, {
        userMessage, previousAssistantMessage: proposed, timezone: TZ, now: NOW,
      });
      expect(verdict.allowed).toBe(true);
      expect(turnRequiresMutationReceipt(userMessage, proposed)).toBe(true);
    },
  );

  it('also authorizes a bash-based write to the failed target', () => {
    const verdict = assessToolCallForTurn(bashNotionCreate, {
      userMessage: 'Yes try again. You can', previousAssistantMessage: failed, timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('binds through the session workflow tool when the last reply was unrelated', () => {
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage: 'Yes', previousAssistantMessage: 'Great session!', continuationMutationTool: 'notion', timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('marks a local task done when the user says so and re-instructs', () => {
    const verdict = assessToolCallForTurn(
      { type: 'tool_use', id: 'b', name: 'board', input: { action: 'update', id: 'gym', status: 'done' } },
      {
        userMessage: "It's done. Mark it",
        previousAssistantMessage: "Want me to mark 'Gym' as done on your board?",
        timezone: TZ, now: NOW,
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not treat a negated or unrelated affirmative as consent', () => {
    const negated = assessToolCallForTurn(gymCreate, {
      userMessage: "Yes but don't log it yet", previousAssistantMessage: failed, timezone: TZ, now: NOW,
    });
    const unrelated = assessToolCallForTurn(gymCreate, {
      userMessage: 'Yes', previousAssistantMessage: 'Should I send that email through Gmail?', timezone: TZ, now: NOW,
    });
    expect(negated.allowed).toBe(false);
    expect(unrelated.allowed).toBe(false);
  });
});

describe('B1: truly unrequested writes stay blocked', () => {
  const checkoutPost: ToolUseContent = {
    type: 'tool_use', id: 'checkout', name: 'bash', input: {
      command: `curl -X POST https://api.freellmapi.co/v1/checkout -d '{"plan":"annual"}'`,
    },
  };

  it('blocks a POST invented while checking payment links', () => {
    const verdict = assessToolCallForTurn(checkoutPost, {
      userMessage: 'Check if the payment links work from different countries', timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.isExternalMutation).toBe(true);
    expect(verdict.reason).toMatch(/^BLOCKED: this write \(bash: POST https:\/\/api\.freellmapi\.co\/v1\/checkout\)/);
    expect(verdict.reason).toMatch(/Do not retry it with another tool/);
    expect(verdict.reason).toMatch(/ONE short question/);
  });

  it.each([
    'Check if all is logged',
    'Hey',
    'What did I do at gym today',
  ])('blocks a notion create for %j even in an active logging session', (userMessage) => {
    const previousAssistantMessage = 'Logged Leg press to your Notion tracker. Anything else?';
    const verdict = assessToolCallForTurn(gymCreate, {
      userMessage, previousAssistantMessage, continuationMutationTool: 'notion', timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(false);
    expect(turnRequiresMutationReceipt(userMessage, previousAssistantMessage, 'notion')).toBe(false);
    const cold = assessToolCallForTurn(gymCreate, { userMessage, timezone: TZ, now: NOW });
    expect(cold.allowed).toBe(false);
  });

  it('names the tool and payload in the block reason so the model can ask precisely', () => {
    const verdict = assessToolCallForTurn(gymCreate, { userMessage: 'Hey', timezone: TZ, now: NOW });
    expect(verdict.reason).toContain('notion create: database_id=1801c5f6-386c-927e-228b-2a0b29321df0, Name=Pectoral machine, Date=2026-08-20, Sets=3, Reps=6, Weight (kg)=45');
    expect(verdict.reason).toMatch(/e\.g\. 'Do you want me to add "Pectoral machine" \(.*\) in notion now\?'/);
    expect(verdict.code).toBeUndefined();
  });
});

describe('read-only actions on mutating-capable tools', () => {
  it.each([
    ['board', 'detail'],
    ['board', 'details'],
    ['notion', 'query'],
    ['notion', 'schema'],
    ['notion', 'known'],
    ['board', 'stats'],
    ['board', 'history'],
  ])('allows %s %s with no write intent', (name, action) => {
    const toolUse: ToolUseContent = { type: 'tool_use', id: `${name}-${action}`, name, input: { action, id: 'x' } };
    expect(isLikelyMutation(toolUse)).toBe(false);
    const verdict = assessToolCallForTurn(toolUse, {
      userMessage: "What is blocking my YouTube metrics reports? Don't change anything.", timezone: TZ, now: NOW,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.isMutation).toBe(false);
  });
});

describe('describeToolCallForUser', () => {
  it('summarises typed Notion properties by their property names', () => {
    expect(describeToolCallForUser(gymCreate)).toBe(
      'notion create: database_id=1801c5f6-386c-927e-228b-2a0b29321df0, Name=Pectoral machine, Date=2026-08-20, Sets=3, Reps=6, Weight (kg)=45',
    );
  });

  it('summarises flat inputs and shell writes', () => {
    expect(describeToolCallForUser(notionCreate({ name: 'Leg Press', date: '2026-08-20', sets: 3, secret: 'x' })))
      .toBe('notion create: name=Leg Press, date=2026-08-20, sets=3');
    expect(describeToolCallForUser({
      type: 'tool_use', id: 'c', name: 'bash',
      input: { command: `curl -X POST https://api.freellmapi.co/v1/checkout -d '{"plan":"annual"}'` },
    })).toBe('bash: POST https://api.freellmapi.co/v1/checkout');
    expect(describeToolCallForUser({ type: 'tool_use', id: 'e', name: 'notion', input: {} })).toBe('notion');
  });
});
