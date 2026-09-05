import { describe, expect, it } from 'vitest';
import { coerceProperties, coerceValue, matchPropertyName, schemaFromProperties, type Schema } from './coerce.js';

const gymSchema: Schema = {
  Name: { type: 'title' },
  Date: { type: 'date' },
  Type: { type: 'select', options: ['Cardio', 'Strength', 'Machine'] },
  Sets: { type: 'number' },
  Reps: { type: 'number' },
  'Weight (kg)': { type: 'number' },
  'Duration (min)': { type: 'number' },
  Notes: { type: 'rich_text' },
  Done: { type: 'checkbox' },
  Tags: { type: 'multi_select', options: ['PR', 'Deload'] },
  Stage: { type: 'status', options: ['Planned', 'Complete'] },
  Link: { type: 'url' },
  Total: { type: 'formula' },
};

describe('schemaFromProperties', () => {
  it('reduces a Notion data-source schema to types and option names', () => {
    const schema = schemaFromProperties({
      Name: { id: 'title', name: 'Name', type: 'title', title: {} },
      Type: { type: 'select', select: { options: [{ id: 'a', name: 'Cardio', color: 'red' }, { name: 'Strength' }] } },
      Stage: { type: 'status', status: { options: [{ name: 'Planned' }], groups: [] } },
      Sets: { type: 'number', number: { format: 'number' } },
      Broken: 'not-an-object',
    });
    expect(schema).toEqual({
      Name: { type: 'title' },
      Type: { type: 'select', options: ['Cardio', 'Strength'] },
      Stage: { type: 'status', options: ['Planned'] },
      Sets: { type: 'number' },
    });
  });
});

describe('matchPropertyName', () => {
  const names = Object.keys(gymSchema);
  it('matches exact, case-insensitive, and whitespace/punctuation-insensitive names', () => {
    expect(matchPropertyName('Sets', names)).toBe('Sets');
    expect(matchPropertyName('sets', names)).toBe('Sets');
    expect(matchPropertyName('weight (kg)', names)).toBe('Weight (kg)');
    expect(matchPropertyName('weight_kg', names)).toBe('Weight (kg)');
    expect(matchPropertyName('WEIGHT(KG)', names)).toBe('Weight (kg)');
  });
  it('matches a bare word to its unique unit-suffixed property', () => {
    expect(matchPropertyName('Weight', names)).toBe('Weight (kg)');
    expect(matchPropertyName('duration', names)).toBe('Duration (min)');
  });
  it('refuses ambiguous or unknown names', () => {
    expect(matchPropertyName('Exercise', names)).toBeNull();
    expect(matchPropertyName('', names)).toBeNull();
    expect(matchPropertyName('D', names)).toBeNull(); // Date, Duration (min), Done
  });
});

describe('coerceValue', () => {
  it('wraps primitives according to the property type', () => {
    expect(coerceValue('Name', gymSchema.Name, 'Leg Press')).toEqual({ title: [{ text: { content: 'Leg Press' } }] });
    expect(coerceValue('Notes', gymSchema.Notes, 'felt good')).toEqual({ rich_text: [{ text: { content: 'felt good' } }] });
    expect(coerceValue('Sets', gymSchema.Sets, 3)).toEqual({ number: 3 });
    expect(coerceValue('Sets', gymSchema.Sets, '45')).toEqual({ number: 45 });
    expect(coerceValue('Sets', gymSchema.Sets, '8.5')).toEqual({ number: 8.5 });
    expect(coerceValue('Weight (kg)', gymSchema['Weight (kg)'], '45kg')).toEqual({ number: 45 });
    expect(coerceValue('Type', gymSchema.Type, 'Cardio')).toEqual({ select: { name: 'Cardio' } });
    expect(coerceValue('Type', gymSchema.Type, 'machine')).toEqual({ select: { name: 'Machine' } });
    expect(coerceValue('Date', gymSchema.Date, '2026-08-21')).toEqual({ date: { start: '2026-08-21' } });
    expect(coerceValue('Done', gymSchema.Done, true)).toEqual({ checkbox: true });
    expect(coerceValue('Done', gymSchema.Done, 'yes')).toEqual({ checkbox: true });
    expect(coerceValue('Tags', gymSchema.Tags, 'PR, deload')).toEqual({ multi_select: [{ name: 'PR' }, { name: 'Deload' }] });
    expect(coerceValue('Tags', gymSchema.Tags, ['PR'])).toEqual({ multi_select: [{ name: 'PR' }] });
    expect(coerceValue('Link', gymSchema.Link, 'https://x.y')).toEqual({ url: 'https://x.y' });
    expect(coerceValue('Stage', gymSchema.Stage, 'complete')).toEqual({ status: { name: 'Complete' } });
  });

  it('accepts half-typed shorthand and passes fully typed values through unchanged', () => {
    expect(coerceValue('Type', gymSchema.Type, { select: 'Cardio' })).toEqual({ select: { name: 'Cardio' } });
    expect(coerceValue('Date', gymSchema.Date, { date: '2026-08-21' })).toEqual({ date: { start: '2026-08-21' } });
    expect(coerceValue('Name', gymSchema.Name, { title: 'Row' })).toEqual({ title: [{ text: { content: 'Row' } }] });
    expect(coerceValue('Sets', gymSchema.Sets, { number: '4' })).toEqual({ number: 4 });
    const typedTitle = { title: [{ type: 'text', text: { content: 'Row' }, annotations: { bold: true } }] };
    expect(coerceValue('Name', gymSchema.Name, typedTitle)).toEqual(typedTitle);
    const typedDate = { date: { start: '2026-08-21', end: '2026-08-22' } };
    expect(coerceValue('Date', gymSchema.Date, typedDate)).toEqual(typedDate);
    // Query-result shapes (with id/type metadata) are reduced to the typed value.
    expect(coerceValue('Sets', gymSchema.Sets, { id: 'abc', type: 'number', number: 5 })).toEqual({ number: 5 });
    // rich_text supplied for a title property is re-wrapped instead of rejected.
    expect(coerceValue('Name', gymSchema.Name, { rich_text: [{ text: { content: 'Row' } }] }))
      .toEqual({ title: [{ text: { content: 'Row' } }] });
  });

  it('clears values with null', () => {
    expect(coerceValue('Sets', gymSchema.Sets, null)).toEqual({ number: null });
    expect(coerceValue('Type', gymSchema.Type, null)).toEqual({ select: null });
    expect(coerceValue('Notes', gymSchema.Notes, null)).toEqual({ rich_text: [] });
    expect(coerceValue('Date', gymSchema.Date, '')).toEqual({ date: null });
  });

  it('rejects values it cannot type, naming the fix', () => {
    expect(() => coerceValue('Sets', gymSchema.Sets, 'three')).toThrow(/"Sets" \(number\).*plain number/);
    expect(() => coerceValue('Date', gymSchema.Date, 'yesterday')).toThrow(/ISO date like 2026-08-21/);
    expect(() => coerceValue('Stage', gymSchema.Stage, 'Nope')).toThrow(/Valid options: Planned, Complete/);
    expect(() => coerceValue('Total', gymSchema.Total, 5)).toThrow(/read-only \(formula\)/);
  });
});

describe('coerceProperties', () => {
  it('renames near-miss keys and coerces every value before any request', () => {
    const { properties, renamed } = coerceProperties({
      Name: 'Pectoral machine', sets: 3, Reps: '6', 'weight (kg)': '45', Date: '2026-08-21', type: 'Machine',
    }, gymSchema, { title: 'Gym' });
    expect(properties).toEqual({
      Name: { title: [{ text: { content: 'Pectoral machine' } }] },
      Sets: { number: 3 },
      Reps: { number: 6 },
      'Weight (kg)': { number: 45 },
      Date: { date: { start: '2026-08-21' } },
      Type: { select: { name: 'Machine' } },
    });
    expect(renamed).toEqual({ sets: 'Sets', 'weight (kg)': 'Weight (kg)', type: 'Type' });
  });

  it('lists the valid properties when a key does not exist', () => {
    expect(() => coerceProperties({ Exercise: 'Row' }, gymSchema, { title: 'Gym Volume Tracker' })).toThrow(
      /Unknown property "Exercise" in "Gym Volume Tracker"\. Valid properties: Name \(title\), Date \(date\), Type \(select: Cardio, Strength, Machine\), Sets \(number\)/,
    );
  });
});
