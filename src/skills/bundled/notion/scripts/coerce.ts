/**
 * Schema-driven coercion of Notion page property values.
 *
 * Small models send `"Sets": 3` or `"Date": "2026-08-21"`; Notion needs
 * `{number: 3}` and `{date: {start: "2026-08-21"}}`. Given the data-source
 * schema this module turns primitives into typed values, fixes near-miss
 * property names ("weight (kg)" -> "Weight (kg)"), and produces errors that
 * name the valid properties so the next call is right.
 */

export interface SchemaProperty {
  type: string;
  options?: string[];
}

export type Schema = Record<string, SchemaProperty>;

export class NotionInputError extends Error {}

const READ_ONLY_TYPES = new Set([
  'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time',
  'last_edited_by', 'unique_id', 'button', 'verification',
]);

const OPTION_TYPES = new Set(['select', 'status', 'multi_select']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Build a compact schema from a Notion data-source `properties` map. */
export function schemaFromProperties(raw: unknown): Schema {
  const schema: Schema = {};
  if (!isPlainObject(raw)) return schema;
  for (const [name, definition] of Object.entries(raw)) {
    if (!isPlainObject(definition) || typeof definition.type !== 'string') continue;
    const type = definition.type;
    const property: SchemaProperty = { type };
    if (OPTION_TYPES.has(type)) {
      const config = definition[type];
      const options = isPlainObject(config) && Array.isArray(config.options) ? config.options : [];
      property.options = options.flatMap(option => (
        isPlainObject(option) && typeof option.name === 'string' ? [option.name] : []
      ));
    }
    schema[name] = property;
  }
  return schema;
}

/** "Name (title), Type (select: Cardio, Strength), Sets (number)" */
export function describeSchema(schema: Schema): string {
  return Object.entries(schema)
    .filter(([, property]) => !READ_ONLY_TYPES.has(property.type))
    .map(([name, property]) => (
      property.options && property.options.length > 0
        ? `${name} (${property.type}: ${property.options.join(', ')})`
        : `${name} (${property.type})`
    ))
    .join(', ');
}

const squash = (value: string): string => value.normalize('NFKD').toLowerCase().replace(/\s+/g, '');
const alnum = (value: string): string => squash(value).replace(/[^a-z0-9]+/g, '');
const firstWord = (value: string): string => alnum(value.trim().split(/[\s(]/)[0] ?? '');

/**
 * Map a caller-supplied property name to a schema property name. Exact first,
 * then case/whitespace-insensitive, then punctuation-insensitive, then a
 * unique prefix / first-word match ("Weight" -> "Weight (kg)").
 */
export function matchPropertyName(key: string, names: string[]): string | null {
  if (names.includes(key)) return key;
  const unique = (candidates: string[]): string | null => (candidates.length === 1 ? candidates[0] : null);
  const squashed = squash(key);
  const bySquash = unique(names.filter(name => squash(name) === squashed));
  if (bySquash) return bySquash;
  const stripped = alnum(key);
  if (!stripped) return null;
  const byAlnum = unique(names.filter(name => alnum(name) === stripped));
  if (byAlnum) return byAlnum;
  return unique(names.filter(name => alnum(name).startsWith(stripped) || firstWord(name) === stripped));
}

function textValue(value: unknown): Array<Record<string, unknown>> {
  if (value === null || value === undefined || value === '') return [];
  return [{ text: { content: String(value) } }];
}

function plainTextOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!isPlainObject(part)) return '';
    if (typeof part.plain_text === 'string') return part.plain_text;
    return isPlainObject(part.text) && typeof part.text.content === 'string' ? part.text.content : '';
  }).join('');
}

function parseNumber(name: string, value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotionInputError(`Property "${name}" (number) cannot take ${String(value)}.`);
    return value;
  }
  if (typeof value === 'string') {
    const match = value.trim().replace(/,/g, '').match(/^([-+]?\d+(?:\.\d+)?)\s*[a-zA-Z%]*$/);
    if (match) return Number(match[1]);
  }
  throw new NotionInputError(
    `Property "${name}" (number) cannot take ${JSON.stringify(value)}. Send a plain number like 45 or 8.5.`,
  );
}

function optionName(name: string, type: string, value: unknown, options: string[] | undefined): string {
  const raw = isPlainObject(value) && typeof value.name === 'string' ? value.name : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new NotionInputError(
      `Property "${name}" (${type}) cannot take ${JSON.stringify(value)}. Send an option name${
        options && options.length > 0 ? ` such as ${options.join(', ')}` : ''}.`,
    );
  }
  const wanted = String(raw).trim();
  if (!options || options.length === 0) return wanted;
  const exact = options.find(option => option === wanted);
  if (exact) return exact;
  const loose = options.find(option => alnum(option) === alnum(wanted));
  if (loose) return loose;
  if (type === 'status') {
    throw new NotionInputError(
      `Property "${name}" (status) has no option "${wanted}". Valid options: ${options.join(', ')}.`,
    );
  }
  return wanted;
}

function parseDate(name: string, value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
      return { start: trimmed };
    }
  }
  if (isPlainObject(value) && typeof value.start === 'string') return value;
  throw new NotionInputError(
    `Property "${name}" (date) cannot take ${JSON.stringify(value)}. Send an ISO date like 2026-08-21.`,
  );
}

function parseCheckbox(name: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on', 'checked', 'done'].includes(text)) return true;
    if (['false', 'no', '0', 'off', 'unchecked', ''].includes(text)) return false;
  }
  throw new NotionInputError(`Property "${name}" (checkbox) cannot take ${JSON.stringify(value)}. Send true or false.`);
}

function idList(name: string, type: string, value: unknown): Array<{ id: string }> {
  if (value === null || value === undefined || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === 'string' && item.trim()) return { id: item.trim() };
    if (isPlainObject(item) && typeof item.id === 'string') return { id: item.id };
    throw new NotionInputError(`Property "${name}" (${type}) cannot take ${JSON.stringify(item)}. Send page/user IDs.`);
  });
}

function multiSelectNames(name: string, value: unknown, options: string[] | undefined): Array<{ name: string }> {
  if (value === null || value === undefined || value === '') return [];
  const items = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',').map(part => part.trim()).filter(Boolean) : [value]);
  return items.map(item => ({ name: optionName(name, 'multi_select', item, options) }));
}

/** Coerce a single value for a property of the given type. */
export function coerceValue(name: string, property: SchemaProperty, value: unknown): Record<string, unknown> {
  const { type, options } = property;
  if (READ_ONLY_TYPES.has(type)) {
    throw new NotionInputError(`Property "${name}" is read-only (${type}) and cannot be written. Remove it.`);
  }

  // Already typed: `{number: 3}`, `{title: [...]}`, `{select: {name}}`. Only
  // primitives nested inside the type key are upgraded; the rest passes through.
  if (isPlainObject(value)) {
    const typeKeys = Object.keys(value).filter(key => key !== 'id' && key !== 'type');
    if (typeKeys.length === 1 && typeKeys[0] === type) {
      const inner = value[type];
      const typed = isPlainObject(inner) || Array.isArray(inner) ? inner : null;
      if (typed && !(type === 'multi_select' && Array.isArray(inner) && inner.some(item => typeof item === 'string'))) {
        return { [type]: inner };
      }
      return coerceValue(name, property, inner);
    }
    if (typeKeys.length === 1 && (type === 'title' || type === 'rich_text') && (typeKeys[0] === 'title' || typeKeys[0] === 'rich_text')) {
      return { [type]: textValue(plainTextOf(value[typeKeys[0]])) };
    }
    if (typeKeys.length === 1 && typeKeys[0] !== type && (typeKeys[0] === 'select' || typeKeys[0] === 'status') && (type === 'select' || type === 'status')) {
      return coerceValue(name, property, value[typeKeys[0]]);
    }
  }

  switch (type) {
    case 'title':
    case 'rich_text': {
      if (Array.isArray(value)) return { [type]: textValue(value.map(String).join(' ')) };
      if (isPlainObject(value)) break;
      return { [type]: textValue(value) };
    }
    case 'number':
      return { number: parseNumber(name, value) };
    case 'select':
    case 'status':
      return { [type]: value === null || value === undefined || value === '' ? null : { name: optionName(name, type, value, options) } };
    case 'multi_select':
      return { multi_select: multiSelectNames(name, value, options) };
    case 'date':
      return { date: parseDate(name, value) };
    case 'checkbox':
      return { checkbox: parseCheckbox(name, value) };
    case 'url':
    case 'email':
    case 'phone_number': {
      if (value === null || value === undefined || value === '') return { [type]: null };
      if (typeof value === 'string' || typeof value === 'number') return { [type]: String(value).trim() };
      break;
    }
    case 'relation':
    case 'people':
      return { [type]: idList(name, type, value) };
    case 'files': {
      if (Array.isArray(value)) return { files: value };
      if (typeof value === 'string' && value.trim()) return { files: [{ name: value.trim(), external: { url: value.trim() } }] };
      if (value === null || value === undefined) return { files: [] };
      break;
    }
    default:
      if (isPlainObject(value) || Array.isArray(value)) return { [type]: value };
      break;
  }
  throw new NotionInputError(
    `Property "${name}" (${type}) cannot take ${JSON.stringify(value)}.`,
  );
}

export interface CoercedProperties {
  properties: Record<string, unknown>;
  /** Caller key -> schema property name, for keys that were corrected. */
  renamed: Record<string, string>;
}

/**
 * Coerce every supplied property against the schema. Throws NotionInputError
 * (naming the valid properties) before any network call when a key cannot be
 * mapped or a value cannot be typed.
 */
export function coerceProperties(
  input: Record<string, unknown>,
  schema: Schema,
  context: { title?: string } = {},
): CoercedProperties {
  const names = Object.keys(schema);
  const properties: Record<string, unknown> = {};
  const renamed: Record<string, string> = {};
  const where = context.title ? ` in "${context.title}"` : '';
  for (const [key, value] of Object.entries(input)) {
    const name = matchPropertyName(key, names);
    if (!name) {
      throw new NotionInputError(
        `Unknown property "${key}"${where}. Valid properties: ${describeSchema(schema)}. Fix the property names and retry.`,
      );
    }
    if (name !== key) renamed[key] = name;
    if (name in properties) {
      throw new NotionInputError(`Property "${name}" was supplied twice (as "${key}" and another key).`);
    }
    properties[name] = coerceValue(name, schema[name], value);
  }
  return { properties, renamed };
}
