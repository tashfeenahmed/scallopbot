import { describe, expect, it } from 'vitest';
import {
  appendPolicyBlockTruth,
  hasUnverifiedActionPromise,
  honestUnwrittenReply,
  mentionsFalsePolicyCause,
  POLICY_BLOCK_TRUTH,
  UNWRITTEN_LINE,
} from './claim-detection.js';

describe('hasUnverifiedActionPromise', () => {
  it.each([
    "I'll add these to Notion now.",
    "I'll get these into Notion now.",
    "Logging today's session (2026-08-10): Pectoral machine 45kg x6x3. I'll get these into Notion now.",
    'Adding these to your gym tracker…',
    "I'll log that for you.",
    'Will add to Notion.',
    'Let me log that.',
    "I'm going to save this to the tracker.",
    "I'm logging it in Notion now.",
    'Got it — I will now record this in the database.',
    'Logging today’s session: Leg press 100kg x8x3',
  ])('detects the promise: %s', (text) => {
    expect(hasUnverifiedActionPromise(text)).toBe(true);
  });

  it.each([
    'Want me to add those last two exercises to your workout log?',
    "I'll add them if you say yes.",
    "I can't add this — the Notion tool is unavailable.",
    'I will not add anything until you confirm.',
    'Leg press was logged to Notion.',
    'Here is a summary of your week: 3 sessions, 12 sets.',
    'Sending you the summary below.',
    'The numbers will add up to 3 sets in total.',
    'Should I add these to Notion?',
  ])('does not treat as a promise: %s', (text) => {
    expect(hasUnverifiedActionPromise(text)).toBe(false);
  });
});

describe('honestUnwrittenReply', () => {
  it('drops the promise and success sentences but keeps the payload', () => {
    const reply = honestUnwrittenReply(
      "Logging today's session (2026-08-10):\n- Pectoral machine 45kg x6x3\n- Seated row 65kg x8x3\nI'll get these into Notion now. All logged! ✅",
    );
    expect(reply.startsWith(UNWRITTEN_LINE)).toBe(true);
    expect(reply).toContain('Pectoral machine 45kg x6x3');
    expect(reply).toContain('Seated row 65kg x8x3');
    expect(reply).not.toMatch(/I'll|All logged|Logging today/);
    expect(hasUnverifiedActionPromise(reply)).toBe(false);
  });

  it('falls back to a one-line honest reply when nothing else remains', () => {
    expect(honestUnwrittenReply("I'll add these to Notion now.")).toBe(
      `${UNWRITTEN_LINE} Reply "yes" and I will write it now.`,
    );
  });
});

describe('policy-block truth', () => {
  it('detects invented causes', () => {
    expect(mentionsFalsePolicyCause('The clawdbot integration lacks access; please share the database with it.')).toBe(true);
    expect(mentionsFalsePolicyCause("I'm blocked by a system restriction, add it manually.")).toBe(true);
    expect(mentionsFalsePolicyCause("This is enforced at the platform level and I can't override it.")).toBe(true);
    expect(mentionsFalsePolicyCause('Here are your sets for today.')).toBe(false);
  });

  it('appends the deterministic sentence once', () => {
    const once = appendPolicyBlockTruth('I hit a system restriction.');
    expect(once.endsWith(POLICY_BLOCK_TRUTH)).toBe(true);
    expect(appendPolicyBlockTruth(once)).toBe(once);
  });
});
