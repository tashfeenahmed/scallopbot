import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_RECIPES_PER_USER,
  ToolRecipeStore,
  buildWorkingCallsBlock,
  describeInputShape,
  errorFamily,
  getRecipeHints,
  redactInput,
  resolveToolRecipesPath,
  summarizeTarget,
} from './tool-recipes.js';
import { describesUnmadeToolCall } from './turn-recovery.js';

const GYM_DB = '1801c5f6-386c-927e-228b-2a0b29321df0';
const legPress = {
  action: 'create',
  database_id: GYM_DB,
  properties: { Name: 'Leg Press', Date: '2026-08-21', Type: 'Machine', Sets: 3, Reps: 9, 'Weight (kg)': 110 },
};

describe('tool recipes', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-recipes-'));
    file = path.join(dir, 'nested', 'tool-recipes.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('shape + redaction helpers', () => {
    it('describes property names and value types, never values', () => {
      expect(describeInputShape(legPress)).toEqual({
        action: 'string',
        database_id: 'string',
        properties: { Name: 'string', Date: 'date', Type: 'string', Sets: 'number', Reps: 'number', 'Weight (kg)': 'number' },
      });
    });

    it('drops secret-looking keys and truncates long strings', () => {
      const redacted = redactInput({
        api_key: 'sk-live-123',
        auth: { token: 'abc', user: 'me' },
        note: 'x'.repeat(100),
        id: GYM_DB,
      }) as Record<string, unknown>;
      expect(redacted.api_key).toBeUndefined();
      expect((redacted.auth as Record<string, unknown>).token).toBeUndefined();
      expect((redacted.auth as Record<string, unknown>).user).toBe('me');
      expect(redacted.note).toBe(`${'x'.repeat(40)}…`);
      expect(redacted.id).toBe(GYM_DB);
    });

    it('summarises the target from id/database/title fields only', () => {
      expect(summarizeTarget(legPress)).toBe(`database_id ${GYM_DB}`);
      expect(summarizeTarget({ action: 'create', database: 'gym tracker', properties: {}, notion_token: 'x' }))
        .toBe('database gym tracker');
    });

    it('collapses errors into an id-free family', () => {
      expect(errorFamily('Error: HTTP 404 object_not_found: Could not find database with ID: 1b3c0e8f-5a6d. Make sure the relevant pages and databases are shared'))
        .toBe('not_found (HTTP 404)');
      expect(errorFamily('body.properties.Name.id should be defined, instead was undefined')).toBe('validation');
      expect(errorFamily('')).toBe('unknown_error');
    });
  });

  describe('store', () => {
    it('records, merges, persists (0600, atomic) and reloads', () => {
      const store = new ToolRecipeStore(file);
      store.noteFailure('u1', 'notion', { action: 'create', database_id: 'bogus' }, 'HTTP 404 object_not_found');
      store.recordSuccess('u1', 'notion', legPress, new Date('2026-08-21T10:00:00Z'));
      store.recordSuccess('u1', 'notion', {
        ...legPress,
        properties: { ...legPress.properties, Name: 'Row', Type: 'Strength', 'Duration (min)': 5 },
      }, new Date('2026-08-22T10:00:00Z'));

      const [recipe] = store.list('u1', 'notion');
      expect(recipe.action).toBe('create');
      expect(recipe.successCount).toBe(2);
      expect(recipe.lastSuccessAt).toBe('2026-08-22T10:00:00.000Z');
      expect(recipe.lastFailureHint).toBe('not_found (HTTP 404)');
      expect(recipe.inputShape.properties).toMatchObject({ Name: 'string', Sets: 'number', 'Duration (min)': 'number' });
      expect((recipe.exampleInput.properties as Record<string, unknown>).Name).toBe('Row');

      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'))).toEqual([]);

      const reloaded = new ToolRecipeStore(file);
      expect(reloaded.list('u1')).toHaveLength(1);
      expect(reloaded.list('u1')[0].successCount).toBe(2);
    });

    it('starts empty on a corrupt file and keeps working', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not json');
      const store = new ToolRecipeStore(file);
      expect(store.list('u1')).toEqual([]);
      store.recordSuccess('u1', 'board', { action: 'add', title: 'Gym' });
      expect(new ToolRecipeStore(file).list('u1')).toHaveLength(1);
    });

    it('keys by user + tool + action and caps at 40 per user, evicting the oldest', () => {
      const store = new ToolRecipeStore(file);
      store.recordSuccess('u1', 'notion', { action: 'update', page_id: 'p1' }, new Date('2026-01-01T00:00:00Z'));
      for (let i = 0; i < MAX_RECIPES_PER_USER; i++) {
        store.recordSuccess('u1', `tool_${i}`, { action: 'x' }, new Date(2026, 1, 1 + i));
      }
      store.recordSuccess('u2', 'notion', { action: 'update', page_id: 'p2' }, new Date('2026-01-01T00:00:00Z'));
      expect(store.list('u1')).toHaveLength(MAX_RECIPES_PER_USER);
      expect(store.list('u1', 'notion')).toEqual([]); // oldest evicted
      expect(store.list('u2', 'notion')).toHaveLength(1); // other users untouched
    });

    it('is in-memory under vitest when no data dir is configured', () => {
      const saved = process.env.SCALLOPBOT_DATA_DIR;
      delete process.env.SCALLOPBOT_DATA_DIR;
      try {
        expect(resolveToolRecipesPath()).toBeNull();
        const store = new ToolRecipeStore();
        store.recordSuccess('u1', 'notion', legPress);
        expect(store.list('u1')).toHaveLength(1);
      } finally {
        if (saved !== undefined) process.env.SCALLOPBOT_DATA_DIR = saved;
      }
    });

    it('resolves the file under SCALLOPBOT_DATA_DIR', () => {
      const saved = process.env.SCALLOPBOT_DATA_DIR;
      process.env.SCALLOPBOT_DATA_DIR = dir;
      try {
        expect(resolveToolRecipesPath()).toBe(path.join(dir, 'tool-recipes.json'));
      } finally {
        if (saved === undefined) delete process.env.SCALLOPBOT_DATA_DIR;
        else process.env.SCALLOPBOT_DATA_DIR = saved;
      }
    });
  });

  describe('WORKING CALLS block', () => {
    function seeded(): ToolRecipeStore {
      const store = new ToolRecipeStore(file);
      const days = ['2026-08-19', '2026-08-20', '2026-08-21'];
      const types = ['Machine', 'Cardio', 'Machine'];
      days.forEach((day, i) => store.recordSuccess('u1', 'notion', {
        ...legPress,
        properties: { ...legPress.properties, Date: day, Type: types[i], Name: `Exercise ${i}` },
      }, new Date(`${day}T10:00:00Z`)));
      return store;
    }

    it('injects when the user mentions the tool, and renders a compact typed shape', () => {
      const block = buildWorkingCallsBlock(seeded(), { userId: 'u1', userMessage: 'log this in notion: leg press 110kg x9x3' });
      expect(block).toContain('## WORKING CALLS (recent successes — copy these shapes exactly)');
      expect(block).toContain(`- notion create → database_id ${GYM_DB}, properties {Name: string, Date: date, Type: select[Machine|Cardio], Sets: number, Reps: number, Weight (kg): number}; last ok 2026-08-21.`);
      expect(block).toContain('Example: {"action":"create","database_id"');
      expect(block).not.toContain('Exercise 0'); // example is the latest input only
      expect(block.length).toBeLessThanOrEqual(900 + 2);
    });

    it('injects on skill trigger words and on the previous assistant message, otherwise stays silent', () => {
      const store = seeded();
      const triggersFor = (tool: string) => (tool === 'notion' ? ['notion', 'database', 'tracker'] : undefined);
      expect(buildWorkingCallsBlock(store, { userId: 'u1', userMessage: 'add this to my tracker', triggersFor })).toContain('WORKING CALLS');
      expect(buildWorkingCallsBlock(store, {
        userId: 'u1',
        userMessage: 'Pectoral machine - 40kg x9x3',
        previousAssistantMessage: 'Logged Leg Press to Notion.',
      })).toContain('WORKING CALLS');
      expect(buildWorkingCallsBlock(store, { userId: 'u1', userMessage: 'what is the weather like?' })).toBe('');
      // Bare data continuation after a successful write with the same tool.
      expect(buildWorkingCallsBlock(store, { userId: 'u1', userMessage: 'Seated cable row - 65kgx8x3', recentTool: 'notion' })).toContain('WORKING CALLS');
      expect(buildWorkingCallsBlock(store, { userId: 'u1', userMessage: 'Seated cable row - 65kgx8x3', recentTool: 'gmail' })).toBe('');
      expect(buildWorkingCallsBlock(store, { userId: 'u2', userMessage: 'log in notion' })).toBe('');
    });

    it('never injects more than 3 recipes and never exceeds 900 chars', () => {
      const store = new ToolRecipeStore(file);
      for (let i = 0; i < 6; i++) {
        store.recordSuccess('u1', 'notion', {
          action: `action_${i}`,
          database_id: GYM_DB,
          properties: { Name: 'x', Notes: 'a fairly long note that will be truncated at forty characters, yes' },
        }, new Date(2026, 7, 1 + i));
      }
      const block = buildWorkingCallsBlock(store, { userId: 'u1', userMessage: 'notion please' });
      expect(block.split('\n- ').length - 1).toBeLessThanOrEqual(3);
      expect(block.length).toBeLessThanOrEqual(902);
    });

    it('exposes recipe hints for a future error path', () => {
      const store = seeded();
      expect(getRecipeHints('u1', 'notion', store)).toMatch(/^Last working shape: notion create → database_id/);
      expect(getRecipeHints('u1', 'gmail', store)).toBeNull();
    });
  });
});

describe('describesUnmadeToolCall', () => {
  it('flags announced-but-absent tool calls', () => {
    expect(describesUnmadeToolCall('Let me check the tracker for today.')).toBe(true);
    expect(describesUnmadeToolCall("I'll call the notion tool now.")).toBe(true);
    expect(describesUnmadeToolCall('Calling the notion tool to fetch the schema…')).toBe(true);
    expect(describesUnmadeToolCall('Using notion now…', ['notion'])).toBe(true);
  });

  it('ignores plain replies, questions, hedges and refusals', () => {
    expect(describesUnmadeToolCall('Logged: Leg Press 110kg x9x3 on 2026-08-21.')).toBe(false);
    expect(describesUnmadeToolCall('Want me to check the tracker?')).toBe(false);
    expect(describesUnmadeToolCall("I can't call Notion because the integration is not shared.")).toBe(false);
    expect(describesUnmadeToolCall('You could check the tracker yourself instead.')).toBe(false);
    expect(describesUnmadeToolCall('')).toBe(false);
  });
});
