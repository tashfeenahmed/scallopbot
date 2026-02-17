/**
 * Tests for per-channel proactive message formatting.
 *
 * Covers three exported functions:
 * 1. formatProactiveForTelegram — passes message through as-is
 * 2. formatProactiveForWebSocket — structured object with all fields
 * 3. formatProactiveMessage — channel router
 *
 * All functions are pure — no I/O, no channel imports.
 */

import { describe, it, expect } from 'vitest';
import {
  formatProactiveForTelegram,
  formatProactiveForWebSocket,
  formatProactiveMessage,
  type ProactiveFormatInput,
} from './proactive-format.js';

// ============ Test Helpers ============

/** Create a ProactiveFormatInput with sensible defaults */
function makeInput(overrides?: Partial<ProactiveFormatInput>): ProactiveFormatInput {
  return {
    message: 'How is your project going?',
    gapType: 'stale_goal',
    urgency: 'medium',
    source: 'inner_thoughts',
    ...overrides,
  };
}

// ============ formatProactiveForTelegram ============

describe('formatProactiveForTelegram', () => {
  it('returns the message as-is without icons or footer', () => {
    const result = formatProactiveForTelegram(makeInput());
    expect(result).toBe('How is your project going?');
  });

  it('does not truncate long messages', () => {
    const longMessage = 'A'.repeat(300);
    const result = formatProactiveForTelegram(makeInput({ message: longMessage }));
    expect(result).toBe(longMessage);
    expect(result).not.toContain('...');
  });

  it('does not add dismiss footer', () => {
    const result = formatProactiveForTelegram(makeInput());
    expect(result).not.toContain('dismiss');
    expect(result).not.toContain('Reply to');
  });

  it('does not prepend emojis', () => {
    const result = formatProactiveForTelegram(makeInput());
    expect(result).not.toMatch(/[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u);
  });
});

// ============ formatProactiveForWebSocket ============

describe('formatProactiveForWebSocket', () => {
  it('returns structured object with all fields', () => {
    const input = makeInput({
      message: 'Check your goals',
      gapType: 'stale_goal',
      urgency: 'high',
      source: 'gap_scanner',
    });
    const result = formatProactiveForWebSocket(input);

    expect(result).toEqual({
      type: 'proactive',
      content: 'Check your goals',
      category: 'stale_goal',
      urgency: 'high',
      source: 'gap_scanner',
    });
  });

  it('defaults category to general when gapType undefined', () => {
    const input = makeInput({ gapType: undefined });
    const result = formatProactiveForWebSocket(input);
    expect(result.category).toBe('general');
  });
});

// ============ formatProactiveMessage ============

describe('formatProactiveMessage', () => {
  it('routes to telegram formatter for telegram channel', () => {
    const input = makeInput();
    const result = formatProactiveMessage('telegram', input);
    expect(typeof result).toBe('string');
    expect(result as string).toBe(input.message);
  });

  it('routes to websocket formatter for api channel', () => {
    const input = makeInput();
    const result = formatProactiveMessage('api', input);
    // Should return an object (WebSocket format)
    expect(typeof result).toBe('object');
    expect((result as Record<string, unknown>).type).toBe('proactive');
  });

  it('handles task_result source correctly', () => {
    const input = makeInput({ source: 'task_result', gapType: undefined });
    const result = formatProactiveMessage('api', input);
    expect(typeof result).toBe('object');
    const wsResult = result as { type: string; source: string; category: string };
    expect(wsResult.source).toBe('task_result');
    expect(wsResult.category).toBe('general');
  });
});
