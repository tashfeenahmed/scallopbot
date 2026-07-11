import { describe, it, expect } from 'vitest';
import {
  buildEvaluatorPrompt,
  classifyProactivePreference,
  parseEvaluatorResponse,
  parseProactivePreferences,
  proactiveTopicMatchesText,
  resolveProactiveDial,
  shouldEvaluate,
} from './proactive-evaluator.js';
import type { GapSignal } from './gap-scanner.js';

function makeSignal(overrides?: Partial<GapSignal>): GapSignal {
  return {
    type: 'unresolved_thread',
    severity: 'low',
    description: 'Recent session follow-up',
    context: { sessionId: 'session-1' },
    sourceId: 'summary-1',
    ...overrides,
  };
}

function makeEvalInput(userPreferences: string[] = []) {
  return {
    sessionSummary: null,
    behavioralPatterns: null,
    activeGoals: [],
    boardItems: [],
    allSessionSummaries: [],
    existingItems: [],
    dial: 'moderate' as const,
    affect: null,
    lastProactiveAt: null,
    activeHours: [],
    userId: 'telegram:42',
    userPreferences,
  };
}

describe('proactive preference parsing', () => {
  it('recognizes explicit positive preferences without treating mere mentions as opt-ins', () => {
    expect(classifyProactivePreference('User prefers the assistant to be proactive.')).toMatchObject({
      polarity: 'positive',
      scope: 'global',
      isGlobalOptOut: false,
    });
    expect(classifyProactivePreference('We discussed proactive messaging architecture.')).toBeNull();
    expect(classifyProactivePreference('Please update the system prompt.')).toBeNull();
    expect(classifyProactivePreference('Wait for me to start the deployment.')).toBeNull();
    expect(classifyProactivePreference("Don't deploy unless I ask.")).toBeNull();
  });

  it('does not turn reminder content or negative sentiment into global opt-in consent', () => {
    expect(classifyProactivePreference('Reminder: buy milk tomorrow')).toBeNull();
    expect(classifyProactivePreference('Reminder: please buy milk tomorrow')).toBeNull();
    expect(classifyProactivePreference('More proactive work is planned for the release')).toBeNull();
    expect(classifyProactivePreference('Reminders stress me out')).toMatchObject({
      polarity: 'negative',
      scope: 'global',
      isGlobalOptOut: true,
    });
    expect(classifyProactivePreference('Check-ins are annoying')).toMatchObject({
      polarity: 'negative',
      scope: 'global',
      isGlobalOptOut: true,
    });

    const profile = parseProactivePreferences([
      'Reminder: buy milk tomorrow',
      'Check-ins are annoying',
    ]);
    expect(profile.hasPositive).toBe(false);
    expect(profile.hasNegative).toBe(true);
    expect(profile.globalOptOut).toBe(true);
    expect(profile.shouldElevate).toBe(false);
  });

  it('matches topic boundaries as tokens, including short topics', () => {
    expect(classifyProactivePreference("Don't remind me about IT.")).toMatchObject({
      polarity: 'negative', scope: 'topic', topic: 'IT', isGlobalOptOut: false,
    });
    expect(proactiveTopicMatchesText('IT', 'The IT migration is still blocked.')).toBe(true);
    expect(proactiveTopicMatchesText('IT', 'Waiting for the migration result.')).toBe(false);
    expect(proactiveTopicMatchesText('IT', 'It was already handled.')).toBe(false);
    expect(proactiveTopicMatchesText('art', 'The startup review is tomorrow.')).toBe(false);
    expect(proactiveTopicMatchesText('release tests', 'The release-tests passed.')).toBe(true);
  });

  it('recognizes an unqualified negative preference as a global opt-out', () => {
    expect(classifyProactivePreference("Please don't check in with me.")).toMatchObject({
      polarity: 'negative',
      scope: 'global',
      isGlobalOptOut: true,
    });
    expect(classifyProactivePreference('Only respond when I message you first.')).toMatchObject({
      polarity: 'negative',
      scope: 'global',
      isGlobalOptOut: true,
    });
  });

  it('keeps topic and timing boundaries scoped instead of turning them into global opt-outs', () => {
    expect(classifyProactivePreference('Do not remind me about medication.')).toMatchObject({
      polarity: 'negative',
      scope: 'topic',
      topic: 'medication',
      isGlobalOptOut: false,
    });
    expect(classifyProactivePreference('No check-ins after 9pm.')).toMatchObject({
      polarity: 'negative',
      scope: 'topic',
      topic: 'after 9pm',
      isGlobalOptOut: false,
    });
    expect(classifyProactivePreference("Don't message me about politics.")).toMatchObject({
      polarity: 'negative',
      scope: 'topic',
      topic: 'politics',
      isGlobalOptOut: false,
    });
  });

  it('treats requests for lower frequency as negative limits, not opt-outs', () => {
    const rule = classifyProactivePreference('Please check in less often.');
    expect(rule).toMatchObject({
      polarity: 'negative',
      scope: 'global',
      isGlobalOptOut: false,
    });
    const profile = parseProactivePreferences([rule!.text]);
    expect(resolveProactiveDial('eager', profile)).toBe('moderate');
  });

  it('does not misread "do not forget" as a negative preference', () => {
    expect(classifyProactivePreference("Don't forget to remind me to take my medication.")).toMatchObject({
      polarity: 'positive',
      scope: 'topic',
      topic: 'take my medication',
      isGlobalOptOut: false,
    });
  });

  it('lets any negative rule prevent automatic eager elevation', () => {
    const profile = parseProactivePreferences([
      'Please check in with me proactively.',
      "Don't remind me about medication.",
    ]);

    expect(profile.hasPositive).toBe(true);
    expect(profile.hasNegative).toBe(true);
    expect(profile.globalOptOut).toBe(false);
    expect(profile.shouldElevate).toBe(false);
    expect(resolveProactiveDial('moderate', profile)).toBe('moderate');
  });

  it('allows an unopposed explicit opt-in to elevate the dial', () => {
    const profile = parseProactivePreferences(['Please be more proactive and check in with me.']);

    expect(profile.shouldElevate).toBe(true);
    expect(resolveProactiveDial('conservative', profile)).toBe('eager');
  });

  it('does not turn a topic-only reminder into broad eager permission', () => {
    const profile = parseProactivePreferences([
      'Please remind me about my medication.',
      'Please be proactive in running the release tests.',
    ]);

    expect(profile.hasPositive).toBe(true);
    expect(profile.positive[0].scope).toBe('topic');
    expect(profile.positive[1]).toMatchObject({ scope: 'topic', topic: 'running the release tests' });
    expect(profile.shouldElevate).toBe(false);
    expect(resolveProactiveDial('moderate', profile)).toBe('moderate');
  });

  it('skips evaluation before an LLM call for a global opt-out', () => {
    expect(shouldEvaluate(makeEvalInput(['Never send me proactive messages.']))).toBe('preference_opt_out');
  });
});

describe('parseEvaluatorResponse', () => {
  it('accepts user-facing nudge messages', () => {
    const result = parseEvaluatorResponse(
      JSON.stringify({
        items: [{ index: 1, action: 'nudge', userFacingMessage: 'Hey, how did the prototype review go?', urgency: 'low' }],
      }),
      [makeSignal()],
    );

    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Hey, how did the prototype review go?');
  });

  it('skips instruction-shaped nudge messages', () => {
    const result = parseEvaluatorResponse(
      JSON.stringify({
        items: [{ index: 1, action: 'nudge', userFacingMessage: 'The assistant should ask the user about the prototype.', urgency: 'low' }],
      }),
      [makeSignal()],
    );

    expect(result).toEqual([]);
  });

  it('rejects legacy message fields instead of treating planner output as recipient text', () => {
    expect(parseEvaluatorResponse(JSON.stringify({
      items: [{ index: 1, action: 'nudge', message: 'Hey, this field is ambiguous.' }],
    }), [makeSignal()])).toEqual([]);
  });

  it('grounds evaluation in the recent chat transcript', () => {
    const prompt = buildEvaluatorPrompt({
      sessionSummary: null,
      behavioralPatterns: null,
      activeGoals: [],
      boardItems: [],
      allSessionSummaries: [{
        id: 'earlier-session',
        sessionId: 'session-earlier',
        userId: 'telegram:42',
        summary: 'The user was preparing the prototype review and asked for a follow-up later.',
        topics: ['prototype review'],
        messageCount: 4,
        durationMs: 10 * 60_000,
        embedding: null,
        createdAt: 1_705_000_000_000,
      }],
      existingItems: [],
      dial: 'moderate',
      affect: null,
      lastProactiveAt: null,
      activeHours: [],
      userId: 'telegram:42',
      recentChatContext: 'User: I already finished the prototype review.\nAssistant: Great work.',
    }, [makeSignal()]);

    expect(prompt.system).toContain('Deliberate privately');
    expect(String(prompt.messages[0].content)).toContain('I already finished the prototype review.');
    expect(String(prompt.messages[0].content)).toContain('preparing the prototype review');
  });
});
