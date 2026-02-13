import { describe, it, expect } from 'vitest';
import { safeBehavioralPatterns } from './gardener-context.js';

describe('safeBehavioralPatterns', () => {
  it('returns correct shape with all required fields', () => {
    const result = safeBehavioralPatterns('user-1');
    expect(result).toEqual({
      userId: 'user-1',
      communicationStyle: null,
      expertiseAreas: [],
      responsePreferences: {},
      activeHours: [],
      messageFrequency: null,
      sessionEngagement: null,
      topicSwitch: null,
      responseLength: null,
      affectState: null,
      smoothedAffect: null,
      updatedAt: 0,
    });
  });

  it('uses provided userId', () => {
    const result = safeBehavioralPatterns('alice');
    expect(result.userId).toBe('alice');
  });
});
