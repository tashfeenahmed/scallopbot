/**
 * Tests for per-channel proactive message formatting.
 *
 * Covers three exported functions:
 * 1. formatProactiveForTelegram — icon + truncation + footer
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
  it('prepends correct icon for each gap type', () => {
    const types: Record<string, string> = {
      stale_goal: '\uD83C\uDFAF',              // 🎯
      approaching_deadline: '\u23F0',           // ⏰
      unresolved_thread: '\uD83D\uDCAC',       // 💬
      behavioral_anomaly: '\uD83D\uDCCA',      // 📊
    };

    for (const [gapType, icon] of Object.entries(types)) {
      const result = formatProactiveForTelegram(makeInput({ gapType }));
      expect(result.startsWith(icon), `Expected ${gapType} to start with ${icon}`).toBe(true);
    }
  });

  it('uses default icon for unknown type', () => {
    const result = formatProactiveForTelegram(makeInput({ gapType: 'something_unknown' }));
    expect(result.startsWith('\uD83D\uDCA1')).toBe(true); // 💡
  });

  it('truncates long messages at 250 chars', () => {
    const longMessage = 'A'.repeat(300);
    const result = formatProactiveForTelegram(makeInput({ message: longMessage }));
    // Icon + space + 250 chars + "..." + footer
    // The message portion should be truncated at 250 chars
    const lines = result.split('\n\n');
    const messagePart = lines[0];
    // Icon (variable length) + space + 250 chars + "..."
    expect(messagePart.length).toBeLessThanOrEqual(260); // icon + space + 250 + "..."
    expect(messagePart.endsWith('...')).toBe(true);
  });

  it('does not truncate short messages', () => {
    const shortMessage = 'Short message here';
    const result = formatProactiveForTelegram(makeInput({ message: shortMessage }));
    expect(result).toContain(shortMessage);
    expect(result).not.toContain('...');
  });

  it('appends dismiss footer', () => {
    const result = formatProactiveForTelegram(makeInput());
    expect(result).toContain('\n\n_Reply to discuss, or ignore to dismiss._');
    expect(result.endsWith('_Reply to discuss, or ignore to dismiss._')).toBe(true);
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
    // Should return a string (Telegram format)
    expect(typeof result).toBe('string');
    expect(result as string).toContain('_Reply to discuss, or ignore to dismiss._');
  });

  it('routes to websocket formatter for api channel', () => {
    const input = makeInput();
    const result = formatProactiveMessage('api', input);
    // Should return an object (WebSocket format)
    expect(typeof result).toBe('object');
    expect((result as Record<string, unknown>).type).toBe('proactive');
  });
});
