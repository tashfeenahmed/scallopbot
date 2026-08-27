/**
 * Tool definitions and handlers for the ScallopBot MCP server.
 *
 * Three tools expose the memory store to any MCP client: `memory_store`,
 * `memory_recall` and `memory_temporal`. All three run against the same SQLite
 * file the bot uses, so anything stored here is immediately visible to the bot
 * and vice versa.
 */

import type { ScallopMemoryStore } from '../memory/scallop-store.js';
import type { ScallopMemoryEntry } from '../memory/db.js';
import { textResult, type ToolResult } from './protocol.js';

/** Named ranges `ScallopMemoryStore.searchByTime` understands directly. */
const NAMED_RANGES = ['thisWeek', 'lastWeek', 'thisMonth'] as const;
type NamedRange = (typeof NAMED_RANGES)[number];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'memory_store',
    description:
      'Store a memory in ScallopBot long-term memory. The memory is written to the ' +
      'same database the bot reads, so it becomes part of the assistant\'s recall ' +
      'immediately. Dates mentioned in the text are extracted automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The memory content to store, as a self-contained statement.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional free-form tags, kept on the memory metadata.',
        },
        importance: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'Optional importance 1-10 (default 5). Higher decays more slowly.',
        },
        timestamp: {
          type: 'string',
          description:
            'Optional ISO-8601 date/time the memory is *about* (its event date). ' +
            'Omit to let ScallopBot extract a date from the text.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recall',
    description:
      'Recall memories relevant to a query using ScallopBot hybrid retrieval ' +
      '(BM25 keyword scoring fused with embedding similarity, plus optional LLM ' +
      're-ranking). Falls back to keyword-only scoring when no embedding provider ' +
      'is configured; the result says which mode was used.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Maximum memories to return (default 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_temporal',
    description:
      'Answer "what happened between X and Y" over ScallopBot memory. Give either ' +
      'an explicit start/end pair or a named range (thisWeek, lastWeek, thisMonth). ' +
      'Results are ordered by event date, most recent first. Add an optional query ' +
      'to rank within the window instead of listing it chronologically.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO-8601 start of the window (inclusive).' },
        end: { type: 'string', description: 'ISO-8601 end of the window (inclusive).' },
        range: {
          type: 'string',
          enum: [...NAMED_RANGES],
          description: 'Named range, as an alternative to start/end.',
        },
        query: {
          type: 'string',
          description: 'Optional topic to rank by within the window.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Maximum memories to return (default 20).',
        },
      },
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  store: ScallopMemoryStore;
  userId: string;
  /** True when an embedding provider is wired up; drives the recall mode note. */
  hasEmbedder: boolean;
}

/** Thrown for bad tool arguments so the dispatcher can answer -32602. */
export class ToolInputError extends Error {}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`"${key}" must be a number`);
  }
  if (value < min || value > max) {
    throw new ToolInputError(`"${key}" must be between ${min} and ${max}`);
  }
  return value;
}

function parseInstant(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`"${key}" must be an ISO-8601 string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ToolInputError(`"${key}" is not a valid ISO-8601 date: ${value}`);
  }
  return parsed;
}

function parseTags(args: Record<string, unknown>): string[] | undefined {
  const value = args.tags;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) {
    throw new ToolInputError('"tags" must be an array of strings');
  }
  return value as string[];
}

function formatDate(epochMs: number | null): string {
  return epochMs === null ? 'undated' : new Date(epochMs).toISOString().slice(0, 10);
}

function formatEntry(entry: ScallopMemoryEntry, index: number, score?: number): string {
  const when = entry.eventDate !== null ? formatDate(entry.eventDate) : formatDate(entry.documentDate);
  const scoreNote = score === undefined ? '' : ` score=${score.toFixed(3)}`;
  return `${index + 1}. [${when}] ${entry.content}\n   (id=${entry.id} category=${entry.category} importance=${entry.importance}${scoreNote})`;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export function createToolHandlers(ctx: ToolContext): Record<string, ToolHandler> {
  const { store, userId, hasEmbedder } = ctx;

  return {
    async memory_store(args) {
      const text = requireString(args, 'text');
      const tags = parseTags(args);
      const importance = optionalNumber(args, 'importance', 1, 10);
      const eventDate = parseInstant(args, 'timestamp');

      // `eventDate` is only passed when the caller supplied one. Passing the key
      // at all (even as undefined) suppresses ScallopBot's own date extraction,
      // so an omitted timestamp must omit the property entirely.
      const memory = await store.add({
        userId,
        content: text,
        importance,
        learnedFrom: 'mcp',
        metadata: tags && tags.length > 0 ? { tags, via: 'mcp' } : { via: 'mcp' },
        ...(eventDate !== undefined ? { eventDate } : {}),
      });

      const tagNote = tags && tags.length > 0 ? ` tags=[${tags.join(', ')}]` : '';
      return textResult(
        `Stored memory ${memory.id}\n` +
          `content: ${memory.content}\n` +
          `category: ${memory.category} importance: ${memory.importance} ` +
          `event date: ${formatDate(memory.eventDate)}${tagNote}`
      );
    },

    async memory_recall(args) {
      const query = requireString(args, 'query');
      const limit = optionalNumber(args, 'limit', 1, 50) ?? 10;

      const results = await store.search(query, { userId, limit });
      const mode = hasEmbedder
        ? 'hybrid (BM25 + embeddings)'
        : 'BM25 keyword-only -- no embedding provider configured, so semantic ' +
          'similarity was not used';

      if (results.length === 0) {
        return textResult(`No memories matched "${query}". Retrieval mode: ${mode}.`);
      }

      const lines = results.map((result, i) => formatEntry(result.memory, i, result.score));
      return textResult(
        `${results.length} memor${results.length === 1 ? 'y' : 'ies'} for "${query}" ` +
          `(retrieval mode: ${mode}):\n\n${lines.join('\n')}`
      );
    },

    async memory_temporal(args) {
      const limit = optionalNumber(args, 'limit', 1, 50) ?? 20;
      const start = parseInstant(args, 'start');
      const end = parseInstant(args, 'end');
      const rawRange = args.range;
      const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query : undefined;

      let range: NamedRange | { start: number; end: number };
      let windowLabel: string;

      if (start !== undefined || end !== undefined) {
        if (start === undefined || end === undefined) {
          throw new ToolInputError('"start" and "end" must be given together');
        }
        if (end < start) {
          throw new ToolInputError('"end" must not be earlier than "start"');
        }
        range = { start, end };
        windowLabel = `${formatDate(start)} to ${formatDate(end)}`;
      } else if (typeof rawRange === 'string') {
        if (!(NAMED_RANGES as readonly string[]).includes(rawRange)) {
          throw new ToolInputError(
            `"range" must be one of ${NAMED_RANGES.join(', ')}, or give start and end`
          );
        }
        range = rawRange as NamedRange;
        windowLabel = rawRange;
      } else {
        throw new ToolInputError(
          `provide either "start" and "end", or "range" (${NAMED_RANGES.join(', ')})`
        );
      }

      // With a query we rank inside the window using the full hybrid search;
      // without one we list the window chronologically, which is what
      // "what happened between X and Y" actually asks for.
      if (query && typeof range === 'object') {
        const results = await store.search(query, { userId, limit, eventDateRange: range });
        if (results.length === 0) {
          return textResult(`No memories about "${query}" between ${windowLabel}.`);
        }
        const lines = results.map((r, i) => formatEntry(r.memory, i, r.score));
        return textResult(
          `${results.length} memories about "${query}" between ${windowLabel}:\n\n${lines.join('\n')}`
        );
      }

      const entries = store.searchByTime(userId, range, { limit, useEventDate: true });
      if (entries.length === 0) {
        return textResult(
          `No dated memories in ${windowLabel}. Only memories carrying an event date ` +
            `appear in temporal queries; undated facts are reachable via memory_recall.`
        );
      }

      const lines = entries.map((entry, i) => formatEntry(entry, i));
      return textResult(
        `${entries.length} memor${entries.length === 1 ? 'y' : 'ies'} in ${windowLabel} ` +
          `(most recent first):\n\n${lines.join('\n')}`
      );
    },
  };
}
