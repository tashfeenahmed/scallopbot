/**
 * Tests for getRecentChatContext utility.
 *
 * Verifies: null on empty DB, null when stale, formatted output,
 * per-message truncation, ContentBlock[] parsing, custom maxMessages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getRecentChatContext, hasUnresolvedArtifactWork } from './chat-context.js';
import type { ScallopDatabase, SessionMessageRow } from '../memory/db.js';
import { inferSessionMessageKind } from '../memory/session-message-kinds.js';

// ============ Constants ============

const NOW = 1_705_320_000_000; // 2024-01-15T12:00:00.000Z
const HOUR_MS = 60 * 60 * 1000;

// ============ Helpers ============

function makeMessage(overrides?: Partial<SessionMessageRow>): SessionMessageRow {
  const role = overrides?.role ?? 'user';
  const content = overrides?.content ?? 'Hello there';
  return {
    id: 1,
    sessionId: 'sess-1',
    role,
    content,
    messageKind: overrides?.messageKind ?? inferSessionMessageKind(role, content),
    createdAt: NOW - HOUR_MS,
    ...overrides,
  };
}

function makeMockDb(messages: SessionMessageRow[]): ScallopDatabase {
  return {
    getAllMessagesPaginated: vi.fn().mockReturnValue({ messages, hasMore: false }),
    getRecentMessagesByUserId: vi.fn().mockReturnValue(messages),
    getSession: vi.fn().mockReturnValue({ id: 'sess-1', metadata: { userId: 'telegram:123' } }),
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

  it('optionally includes local timestamps so proactive context cannot blur days', () => {
    const messages = [
      makeMessage({ id: 1, role: 'user', content: 'Leg day completed', createdAt: Date.parse('2024-01-14T12:00:00Z') }),
      makeMessage({ id: 2, role: 'assistant', content: 'Logged', createdAt: Date.parse('2024-01-14T12:01:00Z') }),
    ];
    const result = getRecentChatContext(makeMockDb(messages), {
      includeTimestamps: true,
      timeZone: 'Europe/Dublin',
      nowMs: NOW,
    });

    expect(result?.formattedContext).toBe(
      '[2024-01-14 12:00 Europe/Dublin] User: Leg day completed\n'
      + '[2024-01-14 12:01 Europe/Dublin] Assistant: Logged',
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
    expect(db.getAllMessagesPaginated).toHaveBeenCalledWith(100);
  });

  it('uses a user-scoped query when a user ID is supplied', () => {
    const messages = [makeMessage({ content: 'Private chat', createdAt: NOW - HOUR_MS })];
    const db = makeMockDb(messages);

    const result = getRecentChatContext(db, 'telegram:123');

    expect(result?.formattedContext).toBe('User: Private chat');
    expect(db.getRecentMessagesByUserId).toHaveBeenCalledWith('telegram:123', 200);
    expect(db.getAllMessagesPaginated).not.toHaveBeenCalled();
  });

  it('passes only explicitly authorized aliases for canonical owner chat', () => {
    const messages = [makeMessage({ content: 'Owner chat', createdAt: NOW - HOUR_MS })];
    const db = makeMockDb(messages);
    const aliases = ['default', 'owner-example', 'telegram:owner-example'];

    const result = getRecentChatContext(db, 'default', { identityCandidates: aliases });

    expect(result?.formattedContext).toBe('User: Owner chat');
    expect(db.getRecentMessagesByUserId).toHaveBeenCalledWith('default', 200, aliases);
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

  it('does not include tool results or sub-agent protocol as user conversation', () => {
    const messages = [
      makeMessage({ id: 1, content: 'Real user message', createdAt: NOW - 2 * HOUR_MS }),
      makeMessage({
        id: 2,
        content: JSON.stringify([{ type: 'tool_result', tool_use_id: '1', content: 'private output' }]),
        createdAt: NOW - HOUR_MS,
      }),
    ];
    const db = makeMockDb(messages);
    expect(getRecentChatContext(db)?.formattedContext).toBe('User: Real user message');

    vi.mocked(db.getSession).mockReturnValue({
      id: 'sess-1', metadata: { userId: 'telegram:123', isSubAgent: true },
    } as never);
    expect(getRecentChatContext(db)).toBeNull();
  });

  it('does not revive archived conversation context after a new-chat boundary', () => {
    const db = makeMockDb([makeMessage({ content: 'Old unrelated topic' })]);
    vi.mocked(db.getSession).mockReturnValue({
      id: 'sess-1', metadata: { userId: 'telegram:123' }, archivedAt: NOW,
    } as never);
    expect(getRecentChatContext(db)).toBeNull();
  });

  it('detects an unresolved generated artifact but not a verified delivery', () => {
    expect(hasUnresolvedArtifactWork(
      'User: Build the report\nAssistant: The PDF is ready at output/report.pdf',
    )).toBe(true);
    expect(hasUnresolvedArtifactWork(
      'User: Send the report\nAssistant: File sent successfully to Telegram',
    )).toBe(false);
  });
});
