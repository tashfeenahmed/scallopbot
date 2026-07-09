import { describe, it, expect } from 'vitest';
import { looksLikeInternalProactiveText, sanitizeProactiveMessage } from './message-safety.js';

describe('sanitizeProactiveMessage', () => {
  it('keeps natural user-facing check-ins', () => {
    expect(sanitizeProactiveMessage('Hey, how did the workout go today?')).toBe(
      'Hey, how did the workout go today?',
    );
  });

  it('strips harmless message prefixes', () => {
    expect(sanitizeProactiveMessage('Message to send: "Hey, just checking how the prototype is going."')).toBe(
      'Hey, just checking how the prototype is going.',
    );
  });

  it('extracts a message field from JSON wrappers', () => {
    expect(sanitizeProactiveMessage(JSON.stringify({ message: 'Quick reminder, you have the dentist at 2.' }))).toBe(
      'Quick reminder, you have the dentist at 2.',
    );
  });

  it('rejects instruction-shaped internal notes', () => {
    expect(sanitizeProactiveMessage('Ask the user whether they finished the agent prototype.')).toBeNull();
    expect(sanitizeProactiveMessage('The assistant should send a short follow-up about the gym.')).toBeNull();
    expect(sanitizeProactiveMessage('Guidance: check in with the user about stale goals.')).toBeNull();
  });

  it('classifies raw JSON without a user-facing field as internal', () => {
    expect(looksLikeInternalProactiveText('{"action":"nudge","index":1}')).toBe(true);
  });
});
