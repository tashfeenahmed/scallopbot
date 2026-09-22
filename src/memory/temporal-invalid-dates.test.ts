import { describe, expect, it } from 'vitest';
import { TemporalExtractor } from './temporal.js';

// Reference: Wed 2026-09-16
const ref = new Date(2026, 8, 16);

describe('TemporalExtractor invalid calendar dates', () => {
  const extractor = new TemporalExtractor({ referenceDate: ref });

  it('parses valid ISO dates', () => {
    const result = extractor.extract('conference on 2026-11-03', ref.getTime());
    expect(result.eventDate).not.toBeNull();
    const d = new Date(result.eventDate!);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 10, 3]);
  });

  it('rejects an impossible ISO date instead of rolling it over', () => {
    // new Date(2026, 1, 30) silently becomes Mar 2; the extractor must not
    // store a confident event date for a typo like 2026-02-30.
    const result = extractor.extract('deadline 2026-02-30', ref.getTime());
    expect(result.eventDate).toBeNull();
  });

  it('rejects month 13', () => {
    const result = extractor.extract('deadline 2026-13-04', ref.getTime());
    expect(result.eventDate).toBeNull();
  });

  it('rejects "February 30" instead of storing March 2', () => {
    const result = extractor.extract('the fair starts on February 30, 2026', ref.getTime());
    expect(result.eventDate).toBeNull();
  });

  it('accepts "February 28"', () => {
    const result = extractor.extract('the fair starts on February 28, 2026', ref.getTime());
    expect(result.eventDate).not.toBeNull();
    const d = new Date(result.eventDate!);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 1, 28]);
  });

  it('rejects impossible slash dates', () => {
    expect(extractor.extract('due 13/45/2026', ref.getTime()).eventDate).toBeNull();
    expect(new TemporalExtractor({ referenceDate: ref, dateLocale: 'us' })
      .extract('due 19/31/2026', ref.getTime()).eventDate).toBeNull();
  });

  it('accepts valid slash dates in both locales', () => {
    const eu = new TemporalExtractor({ referenceDate: ref, dateLocale: 'eu' });
    const us = new TemporalExtractor({ referenceDate: ref, dateLocale: 'us' });
    const euDate = new Date(eu.extract('due 05/11/2026', ref.getTime()).eventDate!);
    const usDate = new Date(us.extract('due 05/11/2026', ref.getTime()).eventDate!);
    expect([euDate.getDate(), euDate.getMonth()]).toEqual([5, 10]); // 5 Nov
    expect([usDate.getDate(), usDate.getMonth()]).toEqual([11, 4]); // Nov 5 -> US: May 11
    expect([usDate.getDate(), usDate.getMonth()]).toEqual([11, 4]);
  });
});
