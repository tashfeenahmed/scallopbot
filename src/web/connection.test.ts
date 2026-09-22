import { describe, expect, it } from 'vitest';
import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RECONNECT,
  composerPlaceholder,
  connectionBanner,
  reconnectDelay,
  shouldGiveUp,
} from '../../web/src/hooks/connection';

describe('reconnectDelay', () => {
  it('doubles from the base delay and caps at the ceiling', () => {
    expect(reconnectDelay(0)).toBe(BASE_DELAY_MS);
    expect(reconnectDelay(1)).toBe(BASE_DELAY_MS * 2);
    expect(reconnectDelay(4)).toBe(BASE_DELAY_MS * 16);
    expect(reconnectDelay(5)).toBe(MAX_DELAY_MS); // 32s would exceed the cap
    expect(reconnectDelay(20)).toBe(MAX_DELAY_MS);
  });
});

describe('shouldGiveUp', () => {
  it('keeps retrying below the attempt budget and stops at it', () => {
    expect(shouldGiveUp(MAX_RECONNECT - 1)).toBe(false);
    expect(shouldGiveUp(MAX_RECONNECT)).toBe(true);
  });
});

describe('connectionBanner', () => {
  it('stays silent while connected', () => {
    expect(connectionBanner('connected')).toBeNull();
  });

  it('explains an in-flight reconnect and offers early retry', () => {
    const b = connectionBanner('connecting');
    expect(b?.tone).toBe('busy');
    expect(b?.showRetry).toBe(true);
  });

  it('flags the dead state as actionable', () => {
    const b = connectionBanner('disconnected');
    expect(b?.tone).toBe('dead');
    expect(b?.showRetry).toBe(true);
  });
});

describe('composerPlaceholder', () => {
  it('tells the user why the input is disabled when offline', () => {
    expect(composerPlaceholder('connected')).toContain('Message');
    expect(composerPlaceholder('disconnected')).toContain('connection');
    expect(composerPlaceholder('connecting')).toContain('connection');
  });
});
