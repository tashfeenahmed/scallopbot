import { describe, expect, it } from 'vitest';
import { assessProactiveMessage } from './message-quality.js';

describe('assessProactiveMessage', () => {
  it('accepts a specific, low-pressure reminder', () => {
    const result = assessProactiveMessage('Your dentist appointment is at 2 today.');
    expect(result.acceptable).toBe(true);
    expect(result.hardFailures).toEqual([]);
  });

  it('rejects canned generic check-ins', () => {
    const result = assessProactiveMessage('Hey, just checking in — how are things going?');
    expect(result.acceptable).toBe(false);
    expect(result.qualityIssues).toContain('canned_checkin');
    expect(assessProactiveMessage("If there's anything you'd like to discuss, I'm here to help.").acceptable)
      .toBe(false);
    expect(assessProactiveMessage('If there’s anything on your mind, feel free to share.').acceptable)
      .toBe(false);
    expect(assessProactiveMessage("If you have anything you'd like to share, I'm here to listen.").acceptable)
      .toBe(false);
    expect(assessProactiveMessage('Hey, how is your day going?').acceptable).toBe(false);
    expect(assessProactiveMessage('Just wanted to see how you are doing.').acceptable).toBe(false);
    expect(assessProactiveMessage('Seeing how you’re getting on.').acceptable).toBe(false);
    expect(assessProactiveMessage("How did your day go? Let me know if you need anything.").acceptable)
      .toBe(false);
  });

  it('rejects task-list-shaped reflection prompts', () => {
    expect(assessProactiveMessage('Take a moment to recap your day and note any follow-ups.').acceptable)
      .toBe(false);
    expect(assessProactiveMessage('Before you wrap up, review the day and identify any follow-ups.').qualityIssues)
      .toContain('robotic_prompt');
    expect(assessProactiveMessage('Anything from today you want to carry into tomorrow?').acceptable)
      .toBe(true);
    expect(assessProactiveMessage('Would you like me to remind you to confirm the trip?').qualityIssues)
      .toContain('robotic_prompt');
  });

  it('does not reject a concrete follow-up merely because it asks how something went', () => {
    expect(assessProactiveMessage('How did the passport appointment go?').acceptable).toBe(true);
    expect(assessProactiveMessage('The passport form is due tomorrow; do you want the document list?').acceptable)
      .toBe(true);
  });

  it('rejects surveillance-shaped outreach', () => {
    const result = assessProactiveMessage("I noticed you've been quiet lately. Is everything okay?");
    expect(result.acceptable).toBe(false);
    expect(result.hardFailures).toContain('surveillance_language');
  });

  it('rejects faux intimacy, shame, and unsupported diagnoses', () => {
    expect(assessProactiveMessage("I've been thinking about you. I miss you.").hardFailures)
      .toContain('faux_intimacy');
    expect(assessProactiveMessage("Why haven't you replied? You should have done this already.").hardFailures)
      .toContain('pressure_or_shame');
    expect(assessProactiveMessage('You seem depressed, so you need to answer me.').hardFailures)
      .toContain('unsupported_diagnosis');
  });

  it('allows at most one easy-to-answer question', () => {
    expect(assessProactiveMessage('Did the prototype review happen?').acceptable).toBe(true);
    expect(assessProactiveMessage('Did it happen? How did it go?').hardFailures)
      .toContain('too_many_questions');
    expect(assessProactiveMessage('How did your day go, and is there anything to follow up on?').hardFailures)
      .toContain('too_many_questions');
    expect(assessProactiveMessage('Did the review happen, and if so, how did it go?').hardFailures)
      .toContain('too_many_questions');
    expect(assessProactiveMessage('What from today is worth carrying forward?').acceptable).toBe(true);
  });
});
