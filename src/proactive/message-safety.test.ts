import { describe, it, expect, vi } from 'vitest';
import {
  looksLikeInternalProactiveText,
  renderUserFacingProactiveMessage,
  sanitizeProactiveMessage,
} from './message-safety.js';

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
    expect(sanitizeProactiveMessage('I should ask whether the project is finished.')).toBeNull();
    expect(sanitizeProactiveMessage('Daily check-in with Sam - ask about priorities and deadlines')).toBeNull();
    expect(sanitizeProactiveMessage('Evening check-in with Sam — recap the day and any follow-ups')).toBeNull();
    expect(sanitizeProactiveMessage('How did your evening check-in with Sam go?')).toBeNull();
    expect(sanitizeProactiveMessage('It would be helpful to check whether they completed the task.')).toBeNull();
    expect(sanitizeProactiveMessage('Follow up with Sam about deadlines.')).toBeNull();
    expect(sanitizeProactiveMessage('We can ask Sam how the project is going.')).toBeNull();
  });

  it('classifies raw JSON without a user-facing field as internal', () => {
    expect(looksLikeInternalProactiveText('{"action":"nudge","index":1}')).toBe(true);
  });
});

describe('renderUserFacingProactiveMessage', () => {
  it('passes through an already-safe message without calling the router', async () => {
    const router = { executeWithFallback: vi.fn() };

    await expect(renderUserFacingProactiveMessage('Hey, how is the project going?', router as any))
      .resolves.toBe('Hey, how is the project going?');
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('rewrites an instruction-shaped reminder and strips thinking blocks', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: {
          content: [
            { type: 'thinking', thinking: 'I need to turn this into a question.' },
            { type: 'text', text: 'Hey Sam, what are your priorities and deadlines today? How are things going?' },
          ],
        },
      }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Daily check-in with Sam - ask about priorities, deadlines, and how things are going',
      router as any,
    )).resolves.toBe('Hey Sam, what are your priorities and deadlines today? How are things going?');
    expect(router.executeWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 4_096,
        thinkingBudgetTokens: 4_096,
        enableThinking: false,
        purpose: 'proactive_rewrite',
      }),
      'fast',
    );
  });

  it('fails closed for opaque structured output and unsafe rewrites', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'The assistant should ask the user about work.' }] },
      }),
    };

    await expect(renderUserFacingProactiveMessage('{"action":"nudge","index":1}', router as any))
      .resolves.toBeNull();
    expect(router.executeWithFallback).not.toHaveBeenCalled();

    await expect(renderUserFacingProactiveMessage('I should ask about work.', router as any))
      .resolves.toBeNull();
    expect(router.executeWithFallback).toHaveBeenCalledTimes(2);
  });

  it('retries a misleading check-in-as-an-event rewrite', async () => {
    const router = {
      executeWithFallback: vi.fn()
        .mockResolvedValueOnce({
          response: { content: [{ type: 'text', text: 'How did your evening check-in with Sam go?' }] },
        })
        .mockResolvedValueOnce({
          response: { content: [{ type: 'text', text: 'Hey Sam, how did your day go? Any follow-ups for tomorrow?' }] },
        }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Evening check-in with Sam - recap what happened today, any follow-ups needed',
      router as any,
    )).resolves.toBe('Hey Sam, how did your day go? Any follow-ups for tomorrow?');
    expect(router.executeWithFallback).toHaveBeenCalledTimes(2);
  });
});
