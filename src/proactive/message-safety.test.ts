import { describe, it, expect, vi } from 'vitest';
import {
  looksLikeInternalProactiveText,
  prepareUserFacingProactiveMessage,
  renderCompletedWorkDigest,
  renderUserFacingProactiveMessage,
  sanitizeProactiveMessage,
  summarizeTaskResultForDelivery,
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
    expect(sanitizeProactiveMessage('The next step is to ask whether the review happened.')).toBeNull();
    expect(sanitizeProactiveMessage('Draft: Ask whether the review happened.')).toBeNull();
    expect(sanitizeProactiveMessage('A useful follow-up would be to ask about the review.')).toBeNull();
    expect(sanitizeProactiveMessage('The reminder should check whether the review happened.')).toBeNull();
  });

  it('classifies raw JSON without a user-facing field as internal', () => {
    expect(looksLikeInternalProactiveText('{"action":"nudge","index":1}')).toBe(true);
  });
});

describe('summarizeTaskResultForDelivery', () => {
  it('passes concise results through and condenses long recurring reports', async () => {
    await expect(summarizeTaskResultForDelivery('No material change today.'))
      .resolves.toBe('No material change today.');

    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Subscribers rose to 12,430, up 80 since yesterday. The strongest new video added 51.' }] },
      }),
    };
    const longResult = `Channel report\n${'Detailed verified metric and analysis. '.repeat(60)}`;
    await expect(summarizeTaskResultForDelivery(longResult, router as any, ['Subscribers were 12,350 yesterday.']))
      .resolves.toBe('Subscribers rose to 12,430, up 80 since yesterday. The strongest new video added 51.');
    expect(router.executeWithFallback.mock.calls[0][0].purpose).toBe('proactive_task_summary');
  });
});

describe('renderCompletedWorkDigest', () => {
  it('renders results without exposing raw task titles and has a safe fallback', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'The release is live and all health checks passed.' }] },
      }),
    };
    const entries = [{
      title: 'INTERNAL: run deployment verification task',
      result: 'Release 1.4 is live. All health checks passed.',
    }];

    await expect(renderCompletedWorkDigest(entries, router as any))
      .resolves.toBe('The release is live and all health checks passed.');
    expect(router.executeWithFallback.mock.calls[0][0].purpose)
      .toBe('proactive_completed_work_digest');

    const fallback = await renderCompletedWorkDigest(entries);
    expect(fallback).toBe('Release 1.4 is live.');
    expect(fallback).not.toContain('INTERNAL');
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
            { type: 'text', text: 'Your priorities and deadlines are on the list for today. Which one matters most?' },
          ],
        },
      }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Daily check-in with Sam - ask about priorities, deadlines, and how things are going',
      router as any,
    )).resolves.toBe('Your priorities and deadlines are on the list for today. Which one matters most?');
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
          response: { content: [{ type: 'text', text: 'Is there one follow-up from today worth carrying into tomorrow?' }] },
        }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Evening check-in with Sam - recap what happened today, any follow-ups needed',
      router as any,
    )).resolves.toBe('Anything from today worth carrying forward?');
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('realizes requested reflection labels safely without a router and varies repeats', async () => {
    const raw = 'Evening check-in with Sam - recap today and identify any follow-ups';
    await expect(renderUserFacingProactiveMessage(raw)).resolves
      .toBe('Anything from today worth carrying forward?');
    await expect(renderUserFacingProactiveMessage(raw, undefined, {
      recentMessages: ['Anything from today worth carrying forward?'],
    })).resolves.toBe('What from today do you want to pick up tomorrow?');
  });

  it('does not miscast the scheduler-label recipient as a third party', async () => {
    const router = {
      executeWithFallback: vi.fn()
        .mockResolvedValueOnce({
          response: { content: [{ type: 'text', text: 'Review today’s conversations with Sam and note any follow-ups.' }] },
        })
        .mockResolvedValueOnce({
          response: { content: [{ type: 'text', text: 'Is there one follow-up from today worth carrying into tomorrow?' }] },
        }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Evening check-in with Sam - recap today and identify any follow-ups',
      router as any,
    )).resolves.toBe('Anything from today worth carrying forward?');
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('re-realizes safe generated text with context and recent-message variety', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'The prototype review was due this afternoon. Did it go ahead?' }] },
      }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Hey, how is the prototype review going?',
      router as any,
      {
        forceRewrite: true,
        context: 'The review was scheduled for this afternoon.',
        recentMessages: ['Hey, how is the launch going?'],
        messageType: 'follow_up',
      },
    )).resolves.toBe('The prototype review was due this afternoon. Did it go ahead?');

    const request = router.executeWithFallback.mock.calls[0][0];
    expect(request.messages[0].content).toContain('The review was scheduled');
    expect(request.messages[0].content).toContain('RECENT PROACTIVE MESSAGES');
    expect(request.system).toContain('ask at most one');
    expect(request.system).toContain('do not output SKIP merely');
  });

  it('deterministically removes a canned opening from a grounded topic', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'SKIP' }] },
      }),
    };
    await expect(renderUserFacingProactiveMessage(
      'Hey, just checking in — how are things going with the prototype?',
      router as any,
      { forceRewrite: true, context: 'The prototype review was scheduled for this afternoon.' },
    )).resolves.toBe('Any update on the prototype?');
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('deterministically realizes grounded tentative and confirmed reminders', async () => {
    const router = { executeWithFallback: vi.fn() };
    await expect(renderUserFacingProactiveMessage(
      'The user might travel on Friday. Remind them to confirm only if the plan is still tentative.',
      router as any,
      { forceRewrite: true, context: 'The trip is tentative, not confirmed.' },
    )).resolves.toBe(
      'If your travel plans for Friday are still tentative, you may want to confirm them.',
    );
    await expect(renderUserFacingProactiveMessage(
      'Dentist appointment at 2pm',
      router as any,
      { forceRewrite: true, context: 'Confirmed appointment today at 2pm.' },
    )).resolves.toBe('Your dentist appointment is at 2pm.');
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('rejects socially unsafe or canned rewrite candidates', async () => {
    const router = {
      executeWithFallback: vi.fn()
        .mockResolvedValueOnce({ response: { content: [{ type: 'text', text: "I noticed you've been quiet. Is everything okay?" }] } })
        .mockResolvedValueOnce({ response: { content: [{ type: 'text', text: 'Hey, just checking in — how are things going?' }] } }),
    };

    await expect(renderUserFacingProactiveMessage(
      'Check in with the user.',
      router as any,
    )).resolves.toBeNull();
    expect(router.executeWithFallback).toHaveBeenCalledTimes(2);
  });

  it('allows the delivery-time renderer to stay silent when current context resolved the intent', async () => {
    const router = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'SKIP' }] },
      }),
    };
    await expect(renderUserFacingProactiveMessage(
      'Did the review happen?',
      router as any,
      { forceRewrite: true, context: 'The review was cancelled; no follow-up is needed.' },
    )).resolves.toBeNull();
    expect(router.executeWithFallback).not.toHaveBeenCalled();
  });

  it('distinguishes an intentional SKIP from a transient renderer failure', async () => {
    const skipRouter = {
      executeWithFallback: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'SKIP' }] },
      }),
    };
    await expect(prepareUserFacingProactiveMessage(
      'Did the review happen?',
      skipRouter as any,
      { forceRewrite: true },
    )).resolves.toEqual({ outcome: 'skip' });

    const failedRouter = {
      executeWithFallback: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(prepareUserFacingProactiveMessage(
      'Did the review happen?',
      failedRouter as any,
      { forceRewrite: true },
    )).resolves.toEqual({ outcome: 'failed' });
    expect(failedRouter.executeWithFallback).toHaveBeenCalledTimes(2);
  });

  it('never falls back to generated or intent-shaped original text after rewrite failure', async () => {
    const router = {
      executeWithFallback: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };

    await expect(renderUserFacingProactiveMessage(
      'Did the review happen?',
      router as any,
      { forceRewrite: true },
    )).resolves.toBeNull();
    await expect(renderUserFacingProactiveMessage(
      'The next step is to ask whether the review happened.',
      router as any,
    )).resolves.toBeNull();
  });

  it('fails closed on socially unsafe plain text when no router can rewrite it', async () => {
    await expect(renderUserFacingProactiveMessage(
      "I've been thinking about you. I miss you.",
    )).resolves.toBeNull();
  });
});
