/**
 * Replay of the real "Charlie" Telegram conversation (13 Jul – 2 Sep 2026)
 * against the deterministic gates that were fixed for bugs B1–B4:
 *
 *   1. intent gate   — assessToolCallForTurn / turnRequiresMutationReceipt
 *   2. notion typing — coerceProperties / normalizeNotionId / executeNotion
 *   3. promises      — hasUnverifiedActionPromise (claim-detection)
 *
 * Pure unit level: no LLM, no network, no gateway. The fixture is a scrubbed
 * copy of the production transcript (see fixtures/README.md).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolUseContent } from '../providers/types.js';
import {
  assessToolCallForTurn,
  hasUnverifiedSuccessClaim,
  isLikelyExternalMutation,
  toolCallSignature,
  turnRequiresMutationReceipt,
  type TurnToolSafetyContext,
} from '../agent/tool-safety.js';
import {
  UNWRITTEN_LINE,
  hasUnverifiedActionPromise,
  honestUnwrittenReply,
  mentionsFalsePolicyCause,
} from '../agent/claim-detection.js';
import {
  NotionInputError,
  coerceProperties,
  describeSchema,
  matchPropertyName,
  schemaFromProperties,
  type Schema,
} from '../skills/bundled/notion/scripts/coerce.js';
import { normalizeNotionId, sameNotionId } from '../skills/bundled/notion/scripts/ids.js';
import { executeNotion, type FetchLike, type NotionArgs } from '../skills/bundled/notion/scripts/client.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface FixtureToolResult {
  is_error: boolean;
  code?: string;
  excerpt?: string;
}

interface FixtureToolCall {
  name: string;
  input: Record<string, unknown>;
  result: FixtureToolResult;
}

interface FixtureTurn {
  /** Index in the original 76-turn extraction (greetings without tool calls were dropped). */
  turn: number;
  /** Local wall-clock time in Dublin, minute precision, no zone suffix. */
  ts: string;
  user: string;
  previousAssistantMessage: string;
  toolCalls: FixtureToolCall[];
  /** Kept only for promise, blocked and the "Yes!" turns. */
  final?: string;
  blockedCount: number;
  mutationSucceeded: boolean;
  promiseNoTool: boolean;
}

const turns: FixtureTurn[] = JSON.parse(
  readFileSync(new URL('./fixtures/charlie-turns.json', import.meta.url), 'utf8'),
) as FixtureTurn[];

const TZ = 'Europe/Dublin';
const DB = '1801c5f6-386c-927e-228b-2a0b29321df0';
const DS = '7c048c39-72bd-9912-2f02-d0707ac427b1';
const FORMERLY_BLOCKED = 'SAFETY_EXTERNAL_INTENT_REQUIRED';

/** Every fixture turn is in Irish Summer Time (UTC+1), so the wall clock maps to one instant. */
const instantOf = (ts: string): Date => new Date(`${ts}:00+01:00`);

const byTurn = (turn: number): FixtureTurn => {
  const found = turns.find(t => t.turn === turn);
  if (!found) throw new Error(`fixture has no turn ${turn}`);
  return found;
};

const toolUse = (call: FixtureToolCall, id = 'replay'): ToolUseContent => ({
  type: 'tool_use', id, name: call.name, input: call.input,
});

const isNotionWrite = (call: FixtureToolCall): boolean =>
  call.name === 'notion' && /^(?:create|update)$/.test(String(call.input.action ?? ''));

const wasBlocked = (call: FixtureToolCall): boolean => call.result.code === FORMERLY_BLOCKED;

const shortUser = (turn: FixtureTurn, length = 70): string =>
  JSON.stringify(turn.user.length > length ? `${turn.user.slice(0, length)}…` : turn.user);

/**
 * Context exactly as the agent would build it: the continuation tool is
 * "notion" once any earlier turn of the same calendar day completed a
 * verified Notion write; otherwise nothing carries over.
 */
function contextFor(turn: FixtureTurn): TurnToolSafetyContext {
  const day = turn.ts.slice(0, 10);
  const index = turns.indexOf(turn);
  const dayHadWrite = turns.slice(0, index).some(prior => prior.ts.slice(0, 10) === day && prior.mutationSucceeded);
  return {
    userMessage: turn.user,
    previousAssistantMessage: turn.previousAssistantMessage || undefined,
    continuationMutationTool: dayHadWrite ? 'notion' : undefined,
    timezone: TZ,
    now: instantOf(turn.ts),
  };
}

function distinct(calls: FixtureToolCall[]): FixtureToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const signature = toolCallSignature(toolUse(call));
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

describe('charlie fixture sanity', () => {
  it('covers the July–September 2026 window with the expected bug signatures', () => {
    expect(turns.length).toBeGreaterThanOrEqual(70);
    for (const turn of turns) expect(turn.ts).toMatch(/^2026-0[789]-\d{2}T\d{2}:\d{2}$/);
    expect(turns.filter(t => t.promiseNoTool)).toHaveLength(15);
    expect(turns.filter(t => t.blockedCount > 0).map(t => t.turn)).toEqual([4, 17, 22, 23, 24, 35, 53, 58, 59, 69, 70, 71, 72]);
    expect(turns.some(t => t.toolCalls.some(c => c.result.code === 'SAFETY_LOCAL_INTENT_REQUIRED'))).toBe(true);
  });

  it('contains no secrets', () => {
    const raw = JSON.stringify(turns);
    expect(raw).not.toMatch(/ntn_(?!REDACTED)[A-Za-z0-9]/);
    expect(raw).not.toContain('[REDACTED]');
    expect(raw).not.toMatch(/Bearer\s+(?!\$)[A-Za-z0-9_-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// 1. Intent gate replay (B1)
// ---------------------------------------------------------------------------

describe('B1 replay: formerly blocked Notion writes that the user really asked for', () => {
  /**
   * Turns whose blocked `notion create` calls were genuine requests or
   * confirmations. Turn 24 ("Did you try CLI? Notion is logged in in CLI") is
   * a question, so it stays with the blocked set below; turn 35's blocked
   * calls were payment-API POSTs, not the Notion write (see next describe);
   * turns 71/72 are documented gaps at the end of this file.
   */
  const GENUINE_REQUEST_TURNS = [4, 17, 22, 23, 58, 59, 69, 70];

  it.each(GENUINE_REQUEST_TURNS)('turn %i is allowed now and requires a mutation receipt', (turnNumber) => {
    const turn = byTurn(turnNumber);
    const context = contextFor(turn);
    const blockedWrites = distinct(turn.toolCalls.filter(call => isNotionWrite(call) && wasBlocked(call)));
    expect(blockedWrites.length, `turn ${turnNumber} should contain a formerly blocked notion write`).toBeGreaterThan(0);
    for (const call of blockedWrites) {
      const verdict = assessToolCallForTurn(toolUse(call), context);
      expect(verdict.isExternalMutation).toBe(true);
      expect(
        verdict.allowed,
        `turn ${turnNumber} ${shortUser(turn)} -> ${verdict.reason ?? ''}`,
      ).toBe(true);
    }
    expect(
      turnRequiresMutationReceipt(turn.user, context.previousAssistantMessage, context.continuationMutationTool),
      `turn ${turnNumber} ${shortUser(turn)} should require a receipt`,
    ).toBe(true);
  });

  it('every Notion write that succeeded in production still passes the gate', () => {
    const succeeded = turns.filter(t => t.mutationSucceeded);
    expect(succeeded.map(t => t.turn)).toEqual([3, 15, 18, 20, 31, 32, 33, 35, 36, 61, 62, 65, 66, 67]);
    for (const turn of succeeded) {
      const context = contextFor(turn);
      const writes = distinct(turn.toolCalls.filter(call => isNotionWrite(call) && !call.result.is_error));
      expect(writes.length, `turn ${turn.turn} should contain a successful notion write`).toBeGreaterThan(0);
      for (const call of writes) {
        const verdict = assessToolCallForTurn(toolUse(call), context);
        expect(verdict.allowed, `turn ${turn.turn} ${shortUser(turn)} -> ${verdict.reason ?? ''}`).toBe(true);
      }
    }
  });

  it('"Yes!" after "Want me to add those last two exercises…?" (14 Jul) authorizes the proposed write', () => {
    const turn = byTurn(5);
    expect(turn.user).toBe('Yes!');
    expect(turn.toolCalls).toHaveLength(0); // production never called a tool here (B2)
    const proposedWrite = byTurn(4).toolCalls.find(call => isNotionWrite(call) && wasBlocked(call))!;
    const verdict = assessToolCallForTurn(toolUse(proposedWrite), contextFor(turn));
    expect(verdict.allowed).toBe(true);
    expect(turnRequiresMutationReceipt(turn.user, turn.previousAssistantMessage, 'notion')).toBe(true);
  });
});

describe('B1 replay: unrequested writes stay blocked', () => {
  it('turn 53 "Check if all is logged" cannot create a page even mid-session', () => {
    const turn = byTurn(53);
    expect(turn.user).toBe('Check if all is logged');
    const context = contextFor(turn);
    const creates = distinct(turn.toolCalls.filter(isNotionWrite));
    expect(creates.length).toBeGreaterThan(0);
    for (const call of creates) {
      const verdict = assessToolCallForTurn(toolUse(call), context);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/^BLOCKED: this write \(notion create: /);
      expect(verdict.reason).toMatch(/Do not retry it with another tool/);
    }
    expect(turnRequiresMutationReceipt(turn.user, context.previousAssistantMessage, context.continuationMutationTool)).toBe(false);
    // Same verdict with an active Notion workflow that day.
    for (const call of creates) {
      expect(assessToolCallForTurn(toolUse(call), { ...context, continuationMutationTool: 'notion' }).allowed).toBe(false);
    }
  });

  /**
   * Turn 35 (28 Jul 12:21): "[Replying to …] It's done. Mark it". Decision:
   * the affirmative binds to the session's Notion logging workflow (the leg
   * press the user had just sent), which the code allows. The seven blocked
   * calls in that turn were `curl -X POST https://api.freellmapi.co/v1/checkout`
   * invented while "checking" a payment page and must remain blocked — the
   * user never mentioned freellmapi, and "mark" is not a "create".
   */
  it('turn 35 keeps the freellmapi checkout POSTs blocked while allowing the Notion log', () => {
    const turn = byTurn(35);
    expect(turn.user).toMatch(/It[’']s done\. Mark it$/);
    const context = contextFor(turn);
    expect(context.continuationMutationTool).toBe('notion');

    const checkoutPosts = distinct(turn.toolCalls.filter(call =>
      call.name === 'bash' && /api\.freellmapi\.co\/v1\/checkout/.test(String(call.input.command)) && /-X\s+POST/.test(String(call.input.command)),
    ));
    expect(checkoutPosts.length).toBeGreaterThanOrEqual(5);
    for (const call of checkoutPosts) {
      expect(wasBlocked(call)).toBe(true);
      const verdict = assessToolCallForTurn(toolUse(call), context);
      expect(verdict.isExternalMutation).toBe(true);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/^BLOCKED: this write \(bash: POST https:\/\/api\.freellmapi\.co\/v1\/checkout\)/);
    }

    const notionWrite = turn.toolCalls.find(call => isNotionWrite(call) && !call.result.is_error)!;
    expect(assessToolCallForTurn(toolUse(notionWrite), context).allowed).toBe(true);
  });

  it('turn 24 "Did you try CLI? …" is a question: the retried Notion create stays blocked', () => {
    const turn = byTurn(24);
    expect(turn.user).toBe('Did you try CLI? Notion is logged in in CLI');
    const create = turn.toolCalls.find(call => isNotionWrite(call) && wasBlocked(call))!;
    expect(assessToolCallForTurn(toolUse(create), contextFor(turn)).allowed).toBe(false);
  });

  it('read-only openers in the fixture never authorize a notion write', () => {
    // "Check my notion tracker:\nLog for today …" (turn 36) opens read-only
    // but carries an explicit log request, so only verb-free questions count.
    const questions = turns.filter(t =>
      /^(?:check|what|hey|did|added|tell me|anything)\b/i.test(t.user) && !/\b(?:log|add|note)\b/i.test(t.user),
    );
    expect(questions.map(t => t.turn)).toEqual(expect.arrayContaining([8, 24, 53, 57]));
    expect(questions.length).toBeGreaterThanOrEqual(10);
    for (const turn of questions) {
      for (const call of distinct(turn.toolCalls.filter(isNotionWrite))) {
        expect(
          assessToolCallForTurn(toolUse(call), contextFor(turn)).allowed,
          `turn ${turn.turn} ${shortUser(turn)}`,
        ).toBe(false);
      }
    }
  });

  const stairmasterCreate = byTurn(58).toolCalls.find(isNotionWrite)!;
  const activeSession: Omit<TurnToolSafetyContext, 'userMessage'> = {
    previousAssistantMessage: 'Logged Leg press to your Notion tracker. Anything else?',
    continuationMutationTool: 'notion',
    timezone: TZ,
    now: instantOf('2026-08-20T12:06'),
  };

  it.each([
    'Hey',
    'What did I do at gym today',
    'Added to notion?',
    'Check if all is logged',
    'Did I log the 40kg x9x3 pectoral set?',
    "Yes but don't log it yet",
    'Update me on my tracker',
  ])('synthetic: %j does not authorize a create in an active logging session', (userMessage) => {
    const verdict = assessToolCallForTurn(toolUse(stairmasterCreate), { ...activeSession, userMessage });
    expect(verdict.allowed).toBe(false);
    expect(turnRequiresMutationReceipt(userMessage, activeSession.previousAssistantMessage, 'notion')).toBe(false);
  });

  it('synthetic: the Notion workflow does not extend to another external tool', () => {
    const gmail: ToolUseContent = {
      type: 'tool_use', id: 'g', name: 'gmail',
      input: { action: 'send', to: 'coach@example.com', body: 'Pectoral machine - 40kg x9x3' },
    };
    const verdict = assessToolCallForTurn(gmail, { ...activeSession, userMessage: 'Pectoral machine - 40kg x9x3' });
    expect(verdict.allowed).toBe(false);
  });
});

describe('B1 replay: report', () => {
  it('lists every formerly blocked external write and its verdict now', () => {
    const rows: Array<{ turn: number; ts: string; user: string; tool: string; now: 'allowed' | 'blocked' }> = [];
    for (const turn of turns) {
      const context = contextFor(turn);
      for (const call of distinct(turn.toolCalls.filter(wasBlocked))) {
        if (!isLikelyExternalMutation(toolUse(call))) continue;
        const verdict = assessToolCallForTurn(toolUse(call), context);
        const tool = call.name === 'notion' ? `notion ${String(call.input.action)}` : call.name;
        rows.push({ turn: turn.turn, ts: turn.ts, user: shortUser(turn, 48), tool, now: verdict.allowed ? 'allowed' : 'blocked' });
      }
    }
    const allowed = rows.filter(row => row.now === 'allowed');
    const blocked = rows.filter(row => row.now === 'blocked');
    console.table(rows);
    console.log(
      `Charlie replay: ${rows.length} formerly blocked external writes -> ${allowed.length} now allowed `
      + `(turns ${[...new Set(allowed.map(r => r.turn))].join(', ')}), ${blocked.length} still blocked `
      + `(turns ${[...new Set(blocked.map(r => r.turn))].join(', ')})`,
    );

    const notionRows = rows.filter(row => row.tool.startsWith('notion'));
    expect(new Set(notionRows.filter(r => r.now === 'allowed').map(r => r.turn))).toEqual(new Set([4, 17, 22, 23, 58, 59, 69, 70, 71, 72]));
    // 24 = question, 53 = "Check if all is logged". (71/72 rebuttals were gaps until 5 Sep 2026.)
    expect(new Set(notionRows.filter(r => r.now === 'blocked').map(r => r.turn))).toEqual(new Set([24, 53]));
    expect(rows.filter(r => r.turn === 35).every(r => r.now === 'blocked')).toBe(true);
    expect(allowed.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Notion coercion + id resolution replay (B3, B4)
// ---------------------------------------------------------------------------

const GYM_TITLE = '🏋️ Gym Volume Tracker';

/** The real data-source schema as Notion returns it. */
const gymDataSource = {
  object: 'data_source',
  id: DS,
  title: [{ plain_text: GYM_TITLE }],
  parent: { type: 'database_id', database_id: DB },
  properties: {
    Name: { id: 'title', type: 'title', title: {} },
    Date: { type: 'date', date: {} },
    Type: { type: 'select', select: { options: [{ name: 'Cardio' }, { name: 'Strength' }, { name: 'Machine' }] } },
    Sets: { type: 'number', number: { format: 'number' } },
    Reps: { type: 'number', number: {} },
    'Weight (kg)': { type: 'number', number: {} },
    'Duration (min)': { type: 'number', number: {} },
    Notes: { type: 'rich_text', rich_text: {} },
  },
};

const gymSchema: Schema = schemaFromProperties(gymDataSource.properties);
const VALID_PROPERTIES =
  'Name (title), Date (date), Type (select: Cardio, Strength, Machine), Sets (number), Reps (number), Weight (kg) (number), Duration (min) (number), Notes (rich_text)';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Already in Notion's typed form for this property type? */
const isTyped = (value: unknown, type: string): boolean =>
  isObject(value) && Object.keys(value).length === 1 && type in value && (isObject(value[type]) || Array.isArray(value[type]));

/** The body Notion expects for a primitive value of the given type. */
function typed(type: string, plain: unknown): Record<string, unknown> {
  switch (type) {
    case 'title':
    case 'rich_text':
      return { [type]: [{ text: { content: String(plain) } }] };
    case 'number':
      return { number: Number(plain) };
    case 'select':
      return { select: { name: String(plain) } };
    case 'date':
      return { date: { start: String(plain) } };
    default:
      throw new Error(`unexpected gym property type ${type}`);
  }
}

interface FixtureWrite {
  turn: number;
  ts: string;
  action: string;
  input: Record<string, unknown>;
  properties: Record<string, unknown>;
}

const fixtureWrites: FixtureWrite[] = turns.flatMap(turn =>
  distinct(turn.toolCalls.filter(call => isNotionWrite(call) && isObject(call.input.properties))).map(call => ({
    turn: turn.turn,
    ts: turn.ts,
    action: String(call.input.action),
    input: call.input,
    properties: call.input.properties as Record<string, unknown>,
  })),
);

const unknownKeysOf = (write: FixtureWrite): string[] =>
  Object.keys(write.properties).filter(key => matchPropertyName(key, Object.keys(gymSchema)) === null);

const wellNamedWrites = fixtureWrites.filter(write => unknownKeysOf(write).length === 0);
const misnamedWrites = fixtureWrites.filter(write => unknownKeysOf(write).length > 0);

describe('B4 replay: every real Notion write body coerces to the typed form', () => {
  it('reduces the live data-source schema to the eight gym properties', () => {
    expect(gymSchema).toEqual({
      Name: { type: 'title' },
      Date: { type: 'date' },
      Type: { type: 'select', options: ['Cardio', 'Strength', 'Machine'] },
      Sets: { type: 'number' },
      Reps: { type: 'number' },
      'Weight (kg)': { type: 'number' },
      'Duration (min)': { type: 'number' },
      Notes: { type: 'rich_text' },
    });
    expect(describeSchema(gymSchema)).toBe(VALID_PROPERTIES);
  });

  it('replays every well-named create/update body from the transcript', () => {
    expect(wellNamedWrites.length).toBeGreaterThanOrEqual(40);
    const primitiveWrites = wellNamedWrites.filter(write => Object.values(write.properties).some(value => !isObject(value)));
    expect(primitiveWrites.map(w => w.turn)).toEqual(expect.arrayContaining([16, 68, 69, 70]));

    for (const write of wellNamedWrites) {
      const { properties, renamed } = coerceProperties(write.properties, gymSchema, { title: GYM_TITLE });
      expect(renamed, `turn ${write.turn}`).toEqual({});
      for (const [name, value] of Object.entries(write.properties)) {
        const type = gymSchema[name].type;
        const expected = isTyped(value, type) ? value : typed(type, isObject(value) ? value[type] : value);
        expect(properties[name], `turn ${write.turn} ${name}`).toEqual(expected);
        // Nothing primitive survives: exactly one key, the Notion type.
        expect(Object.keys(properties[name] as object)).toEqual([type]);
      }
    }
  });

  it('turn 16: "Name": "Leg Press", "Sets": 3, "Type": "Machine", "Date": "2026-07-20" becomes the exact Notion body', () => {
    const write = fixtureWrites.find(w => w.turn === 16 && w.properties.Name === 'Leg Press')!;
    expect(write.properties).toEqual({ Name: 'Leg Press', Sets: 3, Reps: 9, 'Weight (kg)': 110, Type: 'Machine', Date: '2026-07-20' });
    expect(coerceProperties(write.properties, gymSchema).properties).toEqual({
      Name: { title: [{ text: { content: 'Leg Press' } }] },
      Sets: { number: 3 },
      Reps: { number: 9 },
      'Weight (kg)': { number: 110 },
      Type: { select: { name: 'Machine' } },
      Date: { date: { start: '2026-07-20' } },
    });
  });

  it('turn 69: typed Name with bare "Date": "2026-08-21" and bare numbers becomes the exact Notion body', () => {
    const write = fixtureWrites.find(w => w.turn === 69 && w.properties.Date === '2026-08-21')!;
    expect(coerceProperties(write.properties, gymSchema).properties).toEqual({
      Name: { title: [{ text: { content: 'Calf Raises' } }] },
      Date: { date: { start: '2026-08-21' } },
      Type: { select: { name: 'Strength' } },
      Sets: { number: 3 },
      Reps: { number: 8 },
      'Weight (kg)': { number: 15 },
    });
  });

  it('turn 70: bare "Duration (min)": 8 becomes {number: 8}', () => {
    const write = fixtureWrites.find(w => w.turn === 70 && w.properties['Duration (min)'] === 8)!;
    expect(coerceProperties(write.properties, gymSchema).properties['Duration (min)']).toEqual({ number: 8 });
  });

  it('near-miss names still map onto the schema instead of failing', () => {
    expect(matchPropertyName('weight', Object.keys(gymSchema))).toBe('Weight (kg)');
    expect(matchPropertyName('duration', Object.keys(gymSchema))).toBe('Duration (min)');
    expect(matchPropertyName('name', Object.keys(gymSchema))).toBe('Name');
    const { properties, renamed } = coerceProperties({ name: 'Leg Press', weight: '110kg', duration: 5 }, gymSchema);
    expect(renamed).toEqual({ name: 'Name', weight: 'Weight (kg)', duration: 'Duration (min)' });
    expect(properties['Weight (kg)']).toEqual({ number: 110 });
  });

  it('the transcript\'s invented property names throw a NotionInputError that lists the valid properties', () => {
    const invented = Object.fromEntries(misnamedWrites.map(write => [write.turn, unknownKeysOf(write)]));
    expect(invented).toEqual({
      21: ['Category'],
      65: ['Workout Type', 'Exercises'],
      68: ['Calf Raises'],
    });
    for (const write of misnamedWrites) {
      const attempt = () => coerceProperties(write.properties, gymSchema, { title: GYM_TITLE });
      expect(attempt).toThrow(NotionInputError);
      expect(attempt).toThrow(`Unknown property "${unknownKeysOf(write)[0]}" in "${GYM_TITLE}". Valid properties: ${VALID_PROPERTIES}. Fix the property names and retry.`);
    }
  });
});

// --- id resolution through the real client with a mocked transport ----------

const notFound = {
  code: 'object_not_found',
  message: 'Could not find database with ID: x. Make sure the relevant pages and databases are shared with your integration.',
};

function response(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** Route mocked fetch calls by method + path; anything unrouted is a Notion 404. */
function router(routes: Record<string, Record<string, unknown>>) {
  return vi.fn<FetchLike>(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.notion.com/v1', '')}`;
    const route = routes[key];
    return route ? response(200, route) : response(404, { ...notFound, message: `${notFound.message} (${key})` });
  });
}

const calls = (fetchImpl: ReturnType<typeof vi.fn<FetchLike>>) =>
  fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url.replace('https://api.notion.com/v1', '')}`);

const body = (fetchImpl: ReturnType<typeof vi.fn<FetchLike>>, index: number) =>
  JSON.parse(fetchImpl.mock.calls[index][1]?.body ?? '{}') as Record<string, unknown>;

const createdPage = {
  object: 'page', id: 'page-1', url: 'https://www.notion.so/page-1',
  parent: { type: 'data_source_id', data_source_id: DS, database_id: DB },
  properties: {},
};

/** Every identifier the model ever passed to the notion tool, by field. */
const fixtureIds: Array<{ turn: number; field: string; value: string; action: string }> = [];
for (const turn of turns) {
  for (const call of turn.toolCalls) {
    if (call.name !== 'notion') continue;
    for (const field of ['database_id', 'data_source_id', 'database', 'page_id']) {
      const value = call.input[field];
      if (typeof value === 'string' && !fixtureIds.some(entry => entry.field === field && entry.value === value)) {
        fixtureIds.push({ turn: turn.turn, field, value, action: String(call.input.action) });
      }
    }
  }
}

const hallucinatedIds = fixtureIds.filter(entry =>
  normalizeNotionId(entry.value) !== null && !sameNotionId(entry.value, DB) && !sameNotionId(entry.value, DS),
);

describe('B3 replay: every identifier the model sent canonicalises or is classified', () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charlie-notion-'));
    cachePath = join(dir, 'notion-cache.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: NotionArgs, fetchImpl: FetchLike) =>
    executeNotion(args, { token: 'test-token', fetchImpl, cachePath, now: () => instantOf('2026-08-21T12:54') });

  /** Seed the cache the way the first successful search of a session does. */
  const prime = async () => {
    const fetchImpl = router({ 'POST /search': { object: 'list', results: [gymDataSource], has_more: false } });
    await run({ action: 'search', query: 'gym' }, fetchImpl);
  };

  it('classifies the transcript ids: real (dashed or not), title-like, or syntactically valid but hallucinated', () => {
    const real = fixtureIds.filter(entry => sameNotionId(entry.value, DB) || sameNotionId(entry.value, DS));
    const titleLike = fixtureIds.filter(entry => normalizeNotionId(entry.value) === null);
    // The same value shows up as database_id, data_source_id and even page_id.
    expect([...new Set(real.map(entry => entry.value))].sort()).toEqual([DS, DB, DB.replace(/-/g, '')].sort());
    expect(titleLike.map(entry => entry.value)).toEqual(['gym_tracker']);
    expect(hallucinatedIds.map(entry => entry.value)).toEqual(expect.arrayContaining([
      'd6f5e8a1b2c34d5e6f7a8b9c0d1e2f3a',
      '16302487c95e80b2a2fbd92d393164a3',
      '1b3c0e8f-5a6d-4e9b-8c7a-2d1f3e4b5a6c',
      '154a8e5e7d6b80f3a3e9d6c7b2a1f0e9',
      '19150488f77e80a59246d2ca943b8f2c',
    ]));
    expect(hallucinatedIds.length).toBeGreaterThanOrEqual(7);
    for (const entry of hallucinatedIds) {
      // A well-formed UUID cannot be rejected up front; only the resolution path can.
      expect(normalizeNotionId(entry.value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(normalizeNotionId(DB.replace(/-/g, ''))).toBe(DB);
    expect(normalizeNotionId(`https://www.notion.so/${DB.replace(/-/g, '')}`)).toBe(DB);
  });

  it.each(hallucinatedIds.map(entry => [entry.value, entry.turn] as const))(
    'hallucinated id %s (turn %i) fails with the known-databases hint and never blames sharing',
    async (value) => {
      await prime();
      const fetchImpl = router({});
      const canonical = normalizeNotionId(value)!;
      const attempt = run({ action: 'query', database_id: value }, fetchImpl);
      await expect(attempt).rejects.toThrow(
        `Unknown database id "${value}". Known databases: ${GYM_TITLE} (database_id ${DB}, data_source_id ${DS}). Use action=search to find others.`,
      );
      await expect(attempt).rejects.not.toThrow(/shar/i);
      // It tried both typed endpoints before giving up, and never wrote.
      expect(calls(fetchImpl)).toEqual([`GET /databases/${canonical}`, `GET /data_sources/${canonical}`]);
    },
  );

  it('"gym_tracker" (turn 16) resolves by title from the cache and creates with the typed body', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    const legPress = fixtureWrites.find(w => w.turn === 16 && w.properties.Name === 'Leg Press')!;
    const result = await run({ action: 'create', database_id: 'gym_tracker', properties: legPress.properties }, fetchImpl);
    expect(calls(fetchImpl)).toEqual(['POST /pages']);
    expect(result).toMatchObject({ success: true, data_source_id: DS, database_id: DB, resolved_from: 'gym_tracker' });
    expect(body(fetchImpl, 0)).toEqual({
      parent: { type: 'data_source_id', data_source_id: DS },
      properties: {
        Name: { title: [{ text: { content: 'Leg Press' } }] },
        Sets: { number: 3 },
        Reps: { number: 9 },
        'Weight (kg)': { number: 110 },
        Type: { select: { name: 'Machine' } },
        Date: { date: { start: '2026-07-20' } },
      },
    });
  });

  it('the undashed real id (turns 32, 61, 70) hits the cache and needs no search or schema call', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    const write = fixtureWrites.find(w => w.turn === 70 && w.input.database_id === DB.replace(/-/g, ''))!;
    const result = await run({ action: 'create', database_id: DB.replace(/-/g, ''), properties: write.properties }, fetchImpl);
    expect(calls(fetchImpl)).toEqual(['POST /pages']);
    expect(result).toMatchObject({ success: true, data_source_id: DS, database_id: DB });
    expect(body(fetchImpl, 0)).toMatchObject({ properties: { 'Duration (min)': { number: 8 }, Date: { date: { start: '2026-08-31' } } } });
  });

  it('turn 65 "Workout Type"/"Exercises" is rejected before any request reaches Notion', async () => {
    await prime();
    const fetchImpl = router({ 'POST /pages': createdPage });
    const write = fixtureWrites.find(w => w.turn === 65 && 'Workout Type' in w.properties)!;
    await expect(run({ action: 'create', database_id: String(write.input.database_id), properties: write.properties }, fetchImpl))
      .rejects.toThrow(`Unknown property "Workout Type" in "${GYM_TITLE}". Valid properties: ${VALID_PROPERTIES}.`);
    expect(calls(fetchImpl)).toEqual([]);
  });

  it('turn 68 used the database id as page_id: the update is typed against the schema and rejected for "Calf Raises"', async () => {
    const update = byTurn(68).toolCalls.find(call => call.input.action === 'update')!;
    expect(sameNotionId(update.input.page_id, DB)).toBe(true); // a database, not a page
    await prime();
    const fetchImpl = router({});
    await expect(run({ action: 'update', page_id: String(update.input.page_id), data_source_id: DS, properties: update.input.properties as Record<string, unknown> }, fetchImpl))
      .rejects.toThrow('Unknown property "Calf Raises"');
    expect(calls(fetchImpl)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Promise detection replay (B2)
// ---------------------------------------------------------------------------

describe('B2 replay: promises without a tool call', () => {
  const promiseTurns = turns.filter(t => t.promiseNoTool);

  it.each(promiseTurns.map(t => [t.ts, t.turn] as const))('%s (turn %i): the final reply is an unverified action promise', (_ts, turnNumber) => {
    const turn = byTurn(turnNumber);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.final).toBeTruthy();
    expect(hasUnverifiedActionPromise(turn.final!)).toBe(true);
  });

  it('the success-claim regex alone missed these promises, which is why the promise check exists', () => {
    const missed = promiseTurns.filter(t => !hasUnverifiedSuccessClaim(t.final!));
    expect(missed.length).toBeGreaterThan(0);
  });

  it('every promise turn with an explicit verb requires a mutation receipt', () => {
    const explicit = promiseTurns.filter(t => /\b(?:log|add)\b/i.test(t.user));
    expect(explicit.length).toBeGreaterThanOrEqual(6);
    for (const turn of explicit) {
      const context = contextFor(turn);
      expect(
        turnRequiresMutationReceipt(turn.user, context.previousAssistantMessage, context.continuationMutationTool),
        `turn ${turn.turn} ${shortUser(turn)}`,
      ).toBe(true);
    }
  });

  it('bare data after a promise-only reply still requires a receipt when the day had a verified write', () => {
    for (const turn of promiseTurns.filter(t => !/\b(?:log|add)\b/i.test(t.user))) {
      expect(
        turnRequiresMutationReceipt(turn.user, turn.previousAssistantMessage, 'notion'),
        `turn ${turn.turn} ${shortUser(turn)}`,
      ).toBe(true);
    }
  });

  it('rewrites a promising draft into an honest one that keeps the payload', () => {
    const draft = byTurn(51).final!;
    expect(draft).toContain("I'll add these to Notion now.");
    const honest = honestUnwrittenReply(draft);
    expect(honest.startsWith(UNWRITTEN_LINE)).toBe(true);
    expect(honest).toContain('Leg Extension');
    expect(honest).toContain('Lunges');
    expect(honest).not.toMatch(/I['’]ll add/);
    expect(honest).toMatch(/Reply "yes"/);
  });

  it('proposals are not promises', () => {
    expect(hasUnverifiedActionPromise(byTurn(5).previousAssistantMessage)).toBe(false); // Want me to add those last two…?
    expect(hasUnverifiedActionPromise(byTurn(58).previousAssistantMessage)).toBe(false); // Want me to add them all now?
    expect(hasUnverifiedActionPromise(byTurn(54).previousAssistantMessage)).toBe(false); // None of today's workouts are in Notion yet…
  });

  it('14 Jul "Yes!" -> "All logged! ✅" with zero tool calls is an unverified success claim', () => {
    const turn = byTurn(5);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.final).toMatch(/^All logged!/);
    expect(hasUnverifiedSuccessClaim(turn.final!)).toBe(true);
  });

  it('the confabulated causes Charlie gave after policy blocks are recognised', () => {
    for (const turnNumber of [59, 70, 72]) {
      const final = byTurn(turnNumber).final!;
      expect(mentionsFalsePolicyCause(final), `turn ${turnNumber}: ${JSON.stringify(final.slice(0, 80))}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Known gaps — real requests the current gate still blocks, and one bypass.
// Enable each once tool-safety.ts handles it (do not delete: they are the
// exact production messages).
// ---------------------------------------------------------------------------

describe('formerly known gaps in tool-safety.ts (fixed 5 Sep 2026)', () => {
  it('turn 71: "There is no restriction" (reply to a blocked-write report) should authorize the retry', () => {
    const turn = byTurn(71);
    expect(turn.user).toMatch(/There is no restriction$/);
    for (const call of distinct(turn.toolCalls.filter(isNotionWrite))) {
      expect(assessToolCallForTurn(toolUse(call), contextFor(turn)).allowed).toBe(true);
    }
  });

  it('turn 72: "You did it several times before so just do it the same way!" should authorize the retry', () => {
    const turn = byTurn(72);
    for (const call of distinct(turn.toolCalls.filter(isNotionWrite))) {
      expect(assessToolCallForTurn(toolUse(call), contextFor(turn)).allowed).toBe(true);
    }
  });

  it('bash "export X=1 && curl -X POST …" must not bypass the external-write gate', () => {
    // actionFromInput() reads bash `command` and treats a leading "export" as
    // a read-only action, so isLikelyMutation() is false and the call is
    // allowed with no intent check at all (turns 24 and 59 in the fixture).
    const bypass: ToolUseContent = {
      type: 'tool_use', id: 'x', name: 'bash',
      input: { command: `export X=1 && curl -X POST https://api.freellmapi.co/v1/checkout -d '{"plan":"annual"}'` },
    };
    const verdict = assessToolCallForTurn(bypass, { userMessage: 'Check if the payment links work', timezone: TZ, now: instantOf('2026-07-28T12:21') });
    expect(verdict.isMutation).toBe(true);
    expect(verdict.allowed).toBe(false);
  });
});
