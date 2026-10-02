import { describe, expect, it } from 'vitest';
import { unusableWebContentReason } from './content-quality.js';

describe('webfetch content quality', () => {
  it.each([
    ['404 Not Found', 'soft 404'],
    ['Code: NoSuchBucket', 'missing storage'],
    ['One last step. Please solve the challenge below to continue.', 'bot challenge'],
    ['The document has moved to https://consent.google.com/', 'consent redirect'],
  ])('rejects unusable success-shell content: %s', (content, reason) => {
    expect(unusableWebContentReason(content)).toContain(reason);
  });

  it('accepts substantive source content', () => {
    expect(unusableWebContentReason('LandTech provides land and planning data to developers.')).toBeNull();
  });
});
