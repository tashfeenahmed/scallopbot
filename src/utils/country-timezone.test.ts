import { describe, it, expect } from 'vitest';
import { getTimezoneByCountry, resolveTimezone } from './country-timezone.js';

describe('getTimezoneByCountry', () => {
  it('should return timezone for a known country', () => {
    expect(getTimezoneByCountry('Ireland')).toBe('Europe/Dublin');
    expect(getTimezoneByCountry('Japan')).toBe('Asia/Tokyo');
    expect(getTimezoneByCountry('Germany')).toBe('Europe/Berlin');
  });

  it('should be case-insensitive', () => {
    expect(getTimezoneByCountry('ireland')).toBe('Europe/Dublin');
    expect(getTimezoneByCountry('IRELAND')).toBe('Europe/Dublin');
    expect(getTimezoneByCountry('IrElAnD')).toBe('Europe/Dublin');
  });

  it('should trim whitespace', () => {
    expect(getTimezoneByCountry('  Ireland  ')).toBe('Europe/Dublin');
    expect(getTimezoneByCountry('\tJapan\n')).toBe('Asia/Tokyo');
  });

  it('should return null for unknown country', () => {
    expect(getTimezoneByCountry('Narnia')).toBeNull();
    expect(getTimezoneByCountry('Atlantis')).toBeNull();
  });

  it('should handle common shorthand names', () => {
    expect(getTimezoneByCountry('USA')).toBe('America/New_York');
    expect(getTimezoneByCountry('US')).toBe('America/New_York');
    expect(getTimezoneByCountry('UK')).toBe('Europe/London');
    expect(getTimezoneByCountry('UAE')).toBe('Asia/Dubai');
  });

  it('should handle alternative country names', () => {
    expect(getTimezoneByCountry('United States')).toBe('America/New_York');
    expect(getTimezoneByCountry('United Kingdom')).toBe('Europe/London');
    expect(getTimezoneByCountry('United Arab Emirates')).toBe('Asia/Dubai');
    expect(getTimezoneByCountry('South Korea')).toBe('Asia/Seoul');
    expect(getTimezoneByCountry('North Korea')).toBe('Asia/Pyongyang');
  });

  it('should handle UK constituent countries', () => {
    expect(getTimezoneByCountry('England')).toBe('Europe/London');
    expect(getTimezoneByCountry('Scotland')).toBe('Europe/London');
    expect(getTimezoneByCountry('Wales')).toBe('Europe/London');
    expect(getTimezoneByCountry('Northern Ireland')).toBe('Europe/London');
  });

  it('should handle Czech Republic / Czechia', () => {
    expect(getTimezoneByCountry('Czech Republic')).toBe('Europe/Prague');
    expect(getTimezoneByCountry('Czechia')).toBe('Europe/Prague');
  });

  it('should return null for empty string', () => {
    expect(getTimezoneByCountry('')).toBeNull();
    expect(getTimezoneByCountry('   ')).toBeNull();
  });

  it('should map a wide selection of countries correctly', () => {
    const cases: [string, string][] = [
      ['India', 'Asia/Kolkata'],
      ['China', 'Asia/Shanghai'],
      ['Brazil', 'America/Sao_Paulo'],
      ['Australia', 'Australia/Sydney'],
      ['Canada', 'America/Toronto'],
      ['Mexico', 'America/Mexico_City'],
      ['France', 'Europe/Paris'],
      ['Italy', 'Europe/Rome'],
      ['Spain', 'Europe/Madrid'],
      ['Nigeria', 'Africa/Lagos'],
      ['Kenya', 'Africa/Nairobi'],
      ['Egypt', 'Africa/Cairo'],
      ['Thailand', 'Asia/Bangkok'],
      ['Singapore', 'Asia/Singapore'],
      ['New Zealand', 'Pacific/Auckland'],
      ['Pakistan', 'Asia/Karachi'],
      ['Turkey', 'Europe/Istanbul'],
      ['Saudi Arabia', 'Asia/Riyadh'],
      ['Philippines', 'Asia/Manila'],
      ['Argentina', 'America/Argentina/Buenos_Aires'],
    ];
    for (const [country, expected] of cases) {
      expect(getTimezoneByCountry(country), `expected ${country} → ${expected}`).toBe(expected);
    }
  });
});

describe('resolveTimezone', () => {
  it('should resolve a valid IANA timezone directly', () => {
    const result = resolveTimezone('Europe/Dublin');
    expect(result).toEqual({ timezone: 'Europe/Dublin', source: 'iana' });
  });

  it('should resolve common IANA timezones', () => {
    expect(resolveTimezone('America/New_York')).toEqual({ timezone: 'America/New_York', source: 'iana' });
    expect(resolveTimezone('Asia/Tokyo')).toEqual({ timezone: 'Asia/Tokyo', source: 'iana' });
    expect(resolveTimezone('UTC')).toEqual({ timezone: 'UTC', source: 'iana' });
    expect(resolveTimezone('US/Pacific')).toEqual({ timezone: 'US/Pacific', source: 'iana' });
  });

  it('should resolve a country name to timezone', () => {
    const result = resolveTimezone('Ireland');
    expect(result).toEqual({ timezone: 'Europe/Dublin', source: 'country' });
  });

  it('should resolve country names case-insensitively', () => {
    // Note: "japan" is also a valid IANA timezone (case-insensitive), so IANA wins.
    // Use a country that is NOT a valid IANA name to test country fallback.
    expect(resolveTimezone('Germany')).toEqual({ timezone: 'Europe/Berlin', source: 'country' });
    expect(resolveTimezone('IRELAND')).toEqual({ timezone: 'Europe/Dublin', source: 'country' });
    expect(resolveTimezone('usa')).toEqual({ timezone: 'America/New_York', source: 'country' });
  });

  it('should prefer IANA over country when input is a valid IANA name', () => {
    // "EST" is not a valid IANA timezone, but some tz strings might overlap
    // This tests that IANA validation runs first
    const result = resolveTimezone('Europe/London');
    expect(result).toEqual({ timezone: 'Europe/London', source: 'iana' });
  });

  it('should return null for unrecognised input', () => {
    expect(resolveTimezone('Neverland')).toBeNull();
    expect(resolveTimezone('Foo/Bar')).toBeNull();
    expect(resolveTimezone('123')).toBeNull();
  });

  it('should return null for empty input', () => {
    expect(resolveTimezone('')).toBeNull();
    expect(resolveTimezone('   ')).toBeNull();
  });

  it('should handle input with extra whitespace', () => {
    expect(resolveTimezone('  Ireland  ')).toEqual({ timezone: 'Europe/Dublin', source: 'country' });
    expect(resolveTimezone('  Europe/Dublin  ')).toEqual({ timezone: 'Europe/Dublin', source: 'iana' });
  });

  it('should resolve shorthand country names', () => {
    expect(resolveTimezone('USA')).toEqual({ timezone: 'America/New_York', source: 'country' });
    expect(resolveTimezone('UK')).toEqual({ timezone: 'Europe/London', source: 'country' });
    expect(resolveTimezone('UAE')).toEqual({ timezone: 'Asia/Dubai', source: 'country' });
  });
});
