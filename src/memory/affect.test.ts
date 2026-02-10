/**
 * Tests for affect classifier functions.
 *
 * Pure functions that classify user message text into valence/arousal
 * dimensions with emotion label mapping via Russell's circumplex model.
 * No database access, no side effects, no async.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAffect,
  mapToEmotion,
  type RawAffect,
  type EmotionLabel,
} from './affect.js';

// ============ classifyAffect — basic positive/negative/neutral ============

describe('classifyAffect — basic classification', () => {
  it('classifies clearly positive text as positive valence', () => {
    const result = classifyAffect("I'm so happy today!");
    expect(result.valence).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies clearly negative text as negative valence', () => {
    const result = classifyAffect('This is terrible and frustrating');
    expect(result.valence).toBeLessThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies neutral/factual text near zero valence', () => {
    const result = classifyAffect('the meeting is at 3pm');
    expect(result.emotion).toBe('neutral');
    expect(result.confidence).toBe(0);
  });

  it('returns neutral emotion and zero confidence for empty string', () => {
    const result = classifyAffect('');
    expect(result.valence).toBe(0);
    expect(result.arousal).toBe(0);
    expect(result.emotion).toBe('neutral');
    expect(result.confidence).toBe(0);
  });

  it('returns confidence proportional to matched words', () => {
    const highCoverage = classifyAffect('happy joyful wonderful amazing');
    const lowCoverage = classifyAffect(
      'the project deliverable metrics happy stakeholder alignment',
    );
    expect(highCoverage.confidence).toBeGreaterThan(lowCoverage.confidence);
  });

  it('returns values in expected ranges', () => {
    const result = classifyAffect('I feel absolutely wonderful and excited');
    expect(result.valence).toBeGreaterThanOrEqual(-1);
    expect(result.valence).toBeLessThanOrEqual(1);
    expect(result.arousal).toBeGreaterThanOrEqual(-1);
    expect(result.arousal).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ============ classifyAffect — negation handling ============

describe('classifyAffect — negation', () => {
  it('flips "not happy" to negative valence', () => {
    const result = classifyAffect("I'm not happy");
    expect(result.valence).toBeLessThan(0);
  });

  it('flips "not bad" to positive valence', () => {
    const result = classifyAffect('not bad at all');
    expect(result.valence).toBeGreaterThan(0);
  });

  it('handles contraction negation "don\'t like"', () => {
    const result = classifyAffect("I don't like this");
    expect(result.valence).toBeLessThan(0);
  });

  it('handles "never" as negation within 3-token window', () => {
    const result = classifyAffect('I never feel sad about it');
    // "never" negates "sad" → positive
    expect(result.valence).toBeGreaterThan(0);
  });

  it('does not negate when negation word is more than 3 tokens away', () => {
    const result = classifyAffect('not really sure but I feel happy');
    // "not" is far from "happy", so "happy" remains positive
    expect(result.valence).toBeGreaterThan(0);
  });
});

// ============ classifyAffect — booster/intensifier handling ============

describe('classifyAffect — boosters/intensifiers', () => {
  it('"very happy" has higher valence than "happy" alone', () => {
    const boosted = classifyAffect('very happy');
    const plain = classifyAffect('happy');
    expect(boosted.valence).toBeGreaterThan(plain.valence);
  });

  it('"extremely angry" has more negative valence than "angry" alone', () => {
    const boosted = classifyAffect('extremely angry');
    const plain = classifyAffect('angry');
    expect(boosted.valence).toBeLessThan(plain.valence);
  });

  it('"slightly annoyed" has less negative valence than "annoyed" alone', () => {
    const dampened = classifyAffect('slightly annoyed');
    const plain = classifyAffect('annoyed');
    // "slightly" is a dampener, so dampened should be closer to zero
    expect(dampened.valence).toBeGreaterThan(plain.valence);
  });
});

// ============ mapToEmotion — Russell circumplex quadrants ============

describe('mapToEmotion — circumplex quadrants', () => {
  it('maps positive valence + high arousal to "excited"', () => {
    expect(mapToEmotion(0.5, 0.5)).toBe('excited');
  });

  it('maps positive valence + moderate arousal to "happy"', () => {
    expect(mapToEmotion(0.3, 0.15)).toBe('happy');
  });

  it('maps positive valence + low arousal to "calm"', () => {
    expect(mapToEmotion(0.2, -0.2)).toBe('calm');
  });

  it('maps high positive valence + low arousal to "content"', () => {
    expect(mapToEmotion(0.5, -0.3)).toBe('content');
  });

  it('maps negative valence + low arousal to "sad"', () => {
    expect(mapToEmotion(-0.3, -0.3)).toBe('sad');
  });

  it('maps very negative valence + high arousal to "angry"', () => {
    expect(mapToEmotion(-0.5, 0.5)).toBe('angry');
  });

  it('maps negative valence + moderate arousal to "anxious"', () => {
    expect(mapToEmotion(-0.2, 0.25)).toBe('anxious');
  });

  it('maps negative valence + mild arousal to "frustrated"', () => {
    expect(mapToEmotion(-0.15, 0.05)).toBe('frustrated');
  });

  it('maps near-zero valence and arousal to "neutral"', () => {
    expect(mapToEmotion(0.05, 0.05)).toBe('neutral');
    expect(mapToEmotion(0, 0)).toBe('neutral');
    expect(mapToEmotion(-0.05, 0.1)).toBe('neutral');
  });
});

// ============ classifyAffect — emotion quadrant integration ============

describe('classifyAffect — emotion quadrant integration', () => {
  it('classifies excited text into Q1 (positive valence, high arousal)', () => {
    const result = classifyAffect("I'm thrilled and ecstatic!");
    expect(result.valence).toBeGreaterThan(0);
    expect(result.arousal).toBeGreaterThan(0);
    expect(['excited', 'happy']).toContain(result.emotion);
  });

  it('classifies sad/tired text into Q3 (negative valence, low arousal)', () => {
    const result = classifyAffect('I feel sad and tired');
    expect(result.valence).toBeLessThan(0);
    expect(result.arousal).toBeLessThan(0);
    expect(result.emotion).toBe('sad');
  });

  it('classifies angry/frustrated text into Q4 (negative valence, high arousal)', () => {
    const result = classifyAffect('This is terrible and frustrating');
    expect(result.valence).toBeLessThan(0);
    expect(['angry', 'anxious', 'frustrated']).toContain(result.emotion);
  });

  it('classifies calm/peaceful text into Q2 (positive valence, low arousal)', () => {
    const result = classifyAffect('Everything is calm and peaceful');
    expect(result.valence).toBeGreaterThan(0);
    expect(result.arousal).toBeLessThan(0);
    expect(['calm', 'content']).toContain(result.emotion);
  });
});

// ============ classifyAffect — emoji handling ============

describe('classifyAffect — emoji', () => {
  it('detects positive sentiment from positive emoji', () => {
    const result = classifyAffect('great job! 😊👍');
    expect(result.valence).toBeGreaterThan(0);
  });

  it('detects negative sentiment from negative emoji', () => {
    const result = classifyAffect('oh no 😢😡');
    expect(result.valence).toBeLessThan(0);
  });

  it('handles emoji-only messages', () => {
    const result = classifyAffect('😊');
    expect(result.valence).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });
});

// ============ classifyAffect — edge cases ============

describe('classifyAffect — edge cases', () => {
  it('handles whitespace-only input', () => {
    const result = classifyAffect('   \t\n  ');
    expect(result.valence).toBe(0);
    expect(result.arousal).toBe(0);
    expect(result.emotion).toBe('neutral');
    expect(result.confidence).toBe(0);
  });

  it('handles mixed case input', () => {
    const result = classifyAffect('I am VERY HAPPY');
    expect(result.valence).toBeGreaterThan(0);
  });

  it('handles punctuation-heavy input', () => {
    const result = classifyAffect('happy!!! amazing!!!');
    expect(result.valence).toBeGreaterThan(0);
  });

  it('arousal is independent from valence magnitude', () => {
    // "depressed" is high-intensity negative but LOW arousal
    const depressed = classifyAffect('I feel depressed');
    expect(depressed.valence).toBeLessThan(0);
    expect(depressed.arousal).toBeLessThanOrEqual(0);

    // "furious" is high-intensity negative but HIGH arousal
    const furious = classifyAffect('I am furious');
    expect(furious.valence).toBeLessThan(0);
    expect(furious.arousal).toBeGreaterThan(0);
  });

  it('RawAffect type has all required fields', () => {
    const result: RawAffect = classifyAffect('test');
    expect(result).toHaveProperty('valence');
    expect(result).toHaveProperty('arousal');
    expect(result).toHaveProperty('emotion');
    expect(result).toHaveProperty('confidence');
  });
});
