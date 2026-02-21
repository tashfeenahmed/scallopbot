/**
 * Tests for getRecentChatContext utility.
 *
 * Verifies: null on empty DB, null when stale, formatted output,
 * per-message truncation, ContentBlock[] parsing, custom maxMessages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRecentChatContext } from './chat-context.js';
import type { ScallopDatabase, SessionMessageRow } from '../memory/db.js';

// ============ Constants ============

const NOW = 1_705_320_000_000; // 2024-01-15T12:00:00.000Z
const HOUR_MS = 60 * 60 * 1000;

// ============ Helpers ============

function makeMessage(overrides?: Partial<SessionMessageRow>): SessionMessageRow {
  return {
    id: 1,
    sessionId: 'sess-1',
    role: 'user',
    content: 'Hello there',
    createdAt: NOW - HOUR_MS,
    ...overrides,
  };
}

function makeMockDb(messages: SessionMessageRow[]): ScallopDatabase {
  return {
    getAllMessagesPaginated: vi.fn().mockReturnValue({ messages, hasMore: false }),
  } as unknown as ScallopDatabase;
}

// ============ Tests ============

describe('getRecentChatContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no messages exist', () => {
    const db = makeMockDb([]);
    expect(getRecentChatContext(db)).toBeNull();
  });

  it('returns null when last message is stale (>48h)', () => {
    const staleMsg = makeMessage({ createdAt: NOW - 49 * HOUR_MS });
    const db = makeMockDb([staleMsg]);
    expect(getRecentChatContext(db)).toBeNull();
  });

  it('returns formatted context for recent messages', () => {
    const messages = [
      makeMessage({ id: 1, role: 'user', content: 'What is the weather?', createdAt: NOW - 2 * HOUR_MS }),
      makeMessage({ id: 2, role: 'assistant', content: 'It is sunny today.', createdAt: NOW - HOUR_MS }),
    ];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db);
    expect(result).not.toBeNull();
    expect(result!.messageCount).toBe(2);
    expect(result!.lastMessageAt).toBe(NOW - HOUR_MS);
    expect(result!.formattedContext).toBe(
      'User: What is the weather?\nAssistant: It is sunny today.'
    );
  });

  it('truncates long messages at 300 chars by default', () => {
    const longContent = 'A'.repeat(500);
    const messages = [makeMessage({ content: longContent, createdAt: NOW - HOUR_MS })];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db)!;
    // 300 chars + '…' suffix
    const line = result.formattedContext;
    expect(line.startsWith('User: ')).toBe(true);
    const text = line.slice('User: '.length);
    expect(text.length).toBe(301); // 300 A's + …
    expect(text.endsWith('…')).toBe(true);
  });

  it('parses ContentBlock[] JSON content', () => {
    const blocks = JSON.stringify([
      { type: 'text', text: 'Hello from blocks' },
      { type: 'image', source: { data: '...' } },
      { type: 'text', text: 'Second block' },
    ]);
    const messages = [
      makeMessage({ role: 'assistant', content: blocks, createdAt: NOW - HOUR_MS }),
    ];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db)!;
    expect(result.formattedContext).toBe('Assistant: Hello from blocks Second block');
  });

  it('respects custom maxMessages option', () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage({ id: i + 1, content: `Message ${i + 1}`, createdAt: NOW - (5 - i) * HOUR_MS })
    );
    const db = makeMockDb(messages);

    getRecentChatContext(db, { maxMessages: 3 });
    expect(db.getAllMessagesPaginated).toHaveBeenCalledWith(3);
  });

  it('respects custom maxCharsPerMessage option', () => {
    const messages = [makeMessage({ content: 'A'.repeat(200), createdAt: NOW - HOUR_MS })];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db, { maxCharsPerMessage: 50 })!;
    const text = result.formattedContext.slice('User: '.length);
    expect(text.length).toBe(51); // 50 A's + …
  });

  it('respects custom stalenessMs option', () => {
    const messages = [makeMessage({ createdAt: NOW - 2 * HOUR_MS })];
    const db = makeMockDb(messages);

    // With 1-hour staleness, a 2h-old message is stale
    expect(getRecentChatContext(db, { stalenessMs: HOUR_MS })).toBeNull();
    // With 3-hour staleness, it's still fresh
    expect(getRecentChatContext(db, { stalenessMs: 3 * HOUR_MS })).not.toBeNull();
  });

  it('collapses multi-line messages to single line', () => {
    const messages = [
      makeMessage({ content: 'Line 1\nLine 2\n\nLine 3', createdAt: NOW - HOUR_MS }),
    ];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db)!;
    expect(result.formattedContext).toBe('User: Line 1 Line 2 Line 3');
  });

  it('skips messages with empty content after extraction', () => {
    const messages = [
      makeMessage({ content: '', createdAt: NOW - 2 * HOUR_MS }),
      makeMessage({ id: 2, role: 'assistant', content: 'Valid reply', createdAt: NOW - HOUR_MS }),
    ];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db)!;
    expect(result.messageCount).toBe(1);
    expect(result.formattedContext).toBe('Assistant: Valid reply');
  });
});
