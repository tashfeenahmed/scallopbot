import { describe, expect, it } from 'vitest';
import { findPersonalDataReason, sanitizeEvolutionEvidence } from './privacy.js';

describe('evolution privacy boundary', () => {
  it('redacts common personal and secret-bearing evidence', () => {
    process.env.TEST_API_TOKEN = 'super-secret-value';
    try {
      const sanitized = sanitizeEvolutionEvidence(
        "My name is Alice Smith, email alice@example.com, call +1 202-555-0147, host 192.168.1.50, home /Users/alice/project, token super-secret-value",
      );
      expect(sanitized).toContain('My name is [PERSON]');
      expect(sanitized).toContain('[EMAIL]');
      expect(sanitized).toContain('[PHONE]');
      expect(sanitized).toContain('[IP_ADDRESS]');
      expect(sanitized).toContain('[HOME_PATH]');
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain('Alice Smith');
      expect(sanitized).not.toContain('alice@example.com');
    } finally {
      delete process.env.TEST_API_TOKEN;
    }
  });

  it('rejects user-specific data in generated procedural artifacts', () => {
    expect(findPersonalDataReason('Contact alice@example.com for this workflow')).toBe('email address');
    expect(findPersonalDataReason('Store this under /home/alice/private')).toBe('user home path');
    expect(findPersonalDataReason('Connect to 192.168.1.50 for this workflow')).toBe('IP address');
    expect(findPersonalDataReason('A generic workflow with no personal facts')).toBeNull();
  });
});
