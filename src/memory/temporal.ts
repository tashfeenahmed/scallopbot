/**
 * Temporal Grounding for ScallopMemory
 *
 * Extracts and manages dual timestamps:
 * - documentDate: When the content was authored/said
 * - eventDate: When the referenced event occurred/will occur
 *
 * Enables accurate temporal queries like:
 * - "What did I say last week?"
 * - "When is my conference?"
 */

/**
 * Temporal extraction result
 */
export interface TemporalExtraction {
  /** When the document was created (always set) */
  documentDate: number;
  /** When the event occurs (if mentioned) */
  eventDate: number | null;
  /** Raw date text extracted */
  rawDateText: string | null;
  /** Whether the date is relative or absolute */
  isRelative: boolean;
}

/**
 * Parsed date with confidence
 */
interface ParsedDate {
  date: Date;
  confidence: number;
  isRelative: boolean;
  rawText: string;
}

/**
 * Date format locale for ambiguous slash-separated dates (e.g., 01/02/2026).
 * - 'us': MM/DD/YYYY (default)
 * - 'eu': DD/MM/YYYY
 */
export type DateLocale = 'us' | 'eu';

/**
 * Options for TemporalExtractor
 */
export interface TemporalExtractorOptions {
  referenceDate?: Date;
  /** Date locale for ambiguous slash-separated dates (default: 'us') */
  dateLocale?: DateLocale;
}

/**
 * Temporal Extractor
 */
export class TemporalExtractor {
  private referenceDate: Date;
  private dateLocale: DateLocale;

  constructor(options?: Date | TemporalExtractorOptions) {
    if (options instanceof Date) {
      // Backwards-compatible: accept Date directly
      this.referenceDate = options;
      this.dateLocale = 'us';
    } else {
      this.referenceDate = options?.referenceDate ?? new Date();
      this.dateLocale = options?.dateLocale ?? 'us';
    }
  }

  /**
   * Update reference date (for testing or specific contexts)
   */
  setReferenceDate(date: Date): void {
    this.referenceDate = date;
  }

  /**
   * Extract temporal information from text
   */
  extract(content: string, documentDate?: number): TemporalExtraction {
    const docDate = documentDate ?? Date.now();

    // Try to extract event date from content
    const eventDate = this.extractEventDate(content, docDate);

    return {
      documentDate: docDate,
      eventDate: eventDate?.date.getTime() ?? null,
      rawDateText: eventDate?.rawText ?? null,
      isRelative: eventDate?.isRelative ?? false,
    };
  }

  /**
   * Extract event date from text
   */
  private extractEventDate(content: string, documentDate: number): ParsedDate | null {
    const refDate = new Date(documentDate);
    const lower = content.toLowerCase();

    // Try relative dates first
    const relative = this.parseRelativeDate(lower, refDate);
    if (relative) return relative;

    // Try absolute dates
    const absolute = this.parseAbsoluteDate(content, refDate);
    if (absolute) return absolute;

    return null;
  }

  /**
   * Parse relative dates (tomorrow, next week, last Friday, etc.)
   */
  private parseRelativeDate(content: string, refDate: Date): ParsedDate | null {
    // Today
    if (content.includes('today')) {
      return {
        date: refDate,
        confidence: 0.9,
        isRelative: true,
        rawText: 'today',
      };
    }

    // Tomorrow
    if (content.includes('tomorrow')) {
      const date = new Date(refDate);
      date.setDate(date.getDate() + 1);
      return {
        date,
        confidence: 0.9,
        isRelative: true,
        rawText: 'tomorrow',
      };
    }

    // Yesterday
    if (content.includes('yesterday')) {
      const date = new Date(refDate);
      date.setDate(date.getDate() - 1);
      return {
        date,
        confidence: 0.9,
        isRelative: true,
        rawText: 'yesterday',
      };
    }

    // Next week/month/year
    const nextMatch = content.match(/next\s+(week|month|year)/i);
    if (nextMatch) {
      const date = new Date(refDate);
      switch (nextMatch[1]) {
        case 'week':
          date.setDate(date.getDate() + 7);
          break;
        case 'month':
          date.setMonth(date.getMonth() + 1);
          break;
        case 'year':
          date.setFullYear(date.getFullYear() + 1);
          break;
      }
      return {
        date,
        confidence: 0.8,
        isRelative: true,
        rawText: nextMatch[0],
      };
    }

    // Last week/month/year
    const lastMatch = content.match(/last\s+(week|month|year)/i);
    if (lastMatch) {
      const date = new Date(refDate);
      switch (lastMatch[1]) {
        case 'week':
          date.setDate(date.getDate() - 7);
          break;
        case 'month':
          date.setMonth(date.getMonth() - 1);
          break;
        case 'year':
          date.setFullYear(date.getFullYear() - 1);
          break;
      }
      return {
        date,
        confidence: 0.8,
        isRelative: true,
        rawText: lastMatch[0],
      };
    }

    // In X days/weeks/months
    const inMatch = content.match(/in\s+(\d+)\s+(days?|weeks?|months?)/i);
    if (inMatch) {
      const amount = parseInt(inMatch[1], 10);
      const unit = inMatch[2].toLowerCase().replace(/s$/, '');
      const date = new Date(refDate);

      switch (unit) {
        case 'day':
          date.setDate(date.getDate() + amount);
          break;
        case 'week':
          date.setDate(date.getDate() + amount * 7);
          break;
        case 'month':
          date.setMonth(date.getMonth() + amount);
          break;
      }

      return {
        date,
        confidence: 0.85,
        isRelative: true,
        rawText: inMatch[0],
      };
    }

    // X days/weeks/months ago
    const agoMatch = content.match(/(\d+)\s+(days?|weeks?|months?)\s+ago/i);
    if (agoMatch) {
      const amount = parseInt(agoMatch[1], 10);
      const unit = agoMatch[2].toLowerCase().replace(/s$/, '');
      const date = new Date(refDate);

      switch (unit) {
        case 'day':
          date.setDate(date.getDate() - amount);
          break;
        case 'week':
          date.setDate(date.getDate() - amount * 7);
          break;
        case 'month':
          date.setMonth(date.getMonth() - amount);
          break;
      }

      return {
        date,
        confidence: 0.85,
        isRelative: true,
        rawText: agoMatch[0],
      };
    }

    // Day of week references
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < dayNames.length; i++) {
      // "next Monday"
      const nextDayMatch = content.match(new RegExp(`next\\s+${dayNames[i]}`, 'i'));
      if (nextDayMatch) {
        const date = this.getNextDayOfWeek(refDate, i);
        return {
          date,
          confidence: 0.85,
          isRelative: true,
          rawText: nextDayMatch[0],
        };
      }

      // "last Monday"
      const lastDayMatch = content.match(new RegExp(`last\\s+${dayNames[i]}`, 'i'));
      if (lastDayMatch) {
        const date = this.getLastDayOfWeek(refDate, i);
        return {
          date,
          confidence: 0.85,
          isRelative: true,
          rawText: lastDayMatch[0],
        };
      }

      // "on Monday" (assumes next occurrence)
      const onDayMatch = content.match(new RegExp(`(?:on|this)\\s+${dayNames[i]}`, 'i'));
      if (onDayMatch) {
        const date = this.getNextDayOfWeek(refDate, i, true);
        return {
          date,
          confidence: 0.7,
          isRelative: true,
          rawText: onDayMatch[0],
        };
      }
    }

    return null;
  }

  /**
   * Parse absolute dates (Feb 15, 2026-03-15, etc.)
   */
  private parseAbsoluteDate(content: string, refDate: Date): ParsedDate | null {
    // ISO format: 2026-02-15
    const isoMatch = content.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const date = new Date(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10)
      );
      return {
        date,
        confidence: 0.95,
        isRelative: false,
        rawText: isoMatch[0],
      };
    }

    // Month day, year: February 15, 2026
    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const monthNamesShort = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    ];

    for (let i = 0; i < monthNames.length; i++) {
      // Full month name: February 15, 2026 or February 15
      const fullPattern = new RegExp(
        `(${monthNames[i]}|${monthNamesShort[i]})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
        'i'
      );
      const fullMatch = content.match(fullPattern);
      if (fullMatch) {
        const day = parseInt(fullMatch[2], 10);
        const year = fullMatch[3] ? parseInt(fullMatch[3], 10) : refDate.getFullYear();
        const date = new Date(year, i, day);
        return {
          date,
          confidence: fullMatch[3] ? 0.95 : 0.8,
          isRelative: false,
          rawText: fullMatch[0],
        };
      }
    }

    // DD/MM/YYYY or MM/DD/YYYY - interpretation depends on locale setting
    const slashMatch = content.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      const first = parseInt(slashMatch[1], 10);
      const second = parseInt(slashMatch[2], 10);
      const year = parseInt(slashMatch[3], 10);

      let month: number;
      let day: number;

      if (this.dateLocale === 'eu') {
        // DD/MM/YYYY
        day = first;
        month = second - 1;
      } else {
        // MM/DD/YYYY (US default)
        month = first - 1;
        day = second;
      }

      const date = new Date(year, month, day);
      return {
        date,
        confidence: 0.75, // Lower confidence for ambiguous format
        isRelative: false,
        rawText: slashMatch[0],
      };
    }

    return null;
  }

  /**
   * Get next occurrence of a day of week
   */
  private getNextDayOfWeek(refDate: Date, targetDay: number, includeToday: boolean = false): Date {
    const date = new Date(refDate);
    const currentDay = date.getDay();

    let daysToAdd: number;
    if (includeToday && currentDay === targetDay) {
      daysToAdd = 0;
    } else if (currentDay < targetDay) {
      daysToAdd = targetDay - currentDay;
    } else {
      daysToAdd = 7 - currentDay + targetDay;
    }

    date.setDate(date.getDate() + daysToAdd);
    return date;
  }

  /**
   * Get last occurrence of a day of week
   */
  private getLastDayOfWeek(refDate: Date, targetDay: number): Date {
    const date = new Date(refDate);
    const currentDay = date.getDay();

    let daysToSubtract: number;
    if (currentDay > targetDay) {
      daysToSubtract = currentDay - targetDay;
    } else {
      daysToSubtract = 7 - targetDay + currentDay;
    }

    date.setDate(date.getDate() - daysToSubtract);
    return date;
  }

  /**
   * Format a date for display
   */
  static formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /**
   * Get relative time description
   */
  static getRelativeTime(timestamp: number, referenceDate?: Date): string {
    const ref = referenceDate ?? new Date();
    const date = new Date(timestamp);
    const diffMs = date.getTime() - ref.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'tomorrow';
    if (diffDays === -1) return 'yesterday';

    if (diffDays > 0) {
      if (diffDays < 7) return `in ${diffDays} days`;
      if (diffDays < 30) return `in ${Math.round(diffDays / 7)} weeks`;
      if (diffDays < 365) return `in ${Math.round(diffDays / 30)} months`;
      return `in ${Math.round(diffDays / 365)} years`;
    } else {
      const absDays = Math.abs(diffDays);
      if (absDays < 7) return `${absDays} days ago`;
      if (absDays < 30) return `${Math.round(absDays / 7)} weeks ago`;
      if (absDays < 365) return `${Math.round(absDays / 30)} months ago`;
      return `${Math.round(absDays / 365)} years ago`;
    }
  }
}

/**
 * Query helpers for temporal searches
 */
export class TemporalQuery {
  /**
   * Get time range for "this week"
   */
  static thisWeek(refDate?: Date): { start: number; end: number } {
    const ref = refDate ?? new Date();
    const start = new Date(ref);
    start.setDate(ref.getDate() - ref.getDay()); // Start of week (Sunday)
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(start.getDate() + 6); // End of week (Saturday)
    end.setHours(23, 59, 59, 999);

    return { start: start.getTime(), end: end.getTime() };
  }

  /**
   * Get time range for "last week"
   */
  static lastWeek(refDate?: Date): { start: number; end: number } {
    const ref = refDate ?? new Date();
    const thisWeekStart = new Date(ref);
    thisWeekStart.setDate(ref.getDate() - ref.getDay());

    const start = new Date(thisWeekStart);
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    return { start: start.getTime(), end: end.getTime() };
  }

  /**
   * Get time range for "this month"
   */
  static thisMonth(refDate?: Date): { start: number; end: number } {
    const ref = refDate ?? new Date();
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);

    return { start: start.getTime(), end: end.getTime() };
  }

  /**
   * Get time range for "last N days"
   */
  static lastDays(days: number, refDate?: Date): { start: number; end: number } {
    const ref = refDate ?? new Date();
    const end = new Date(ref);
    end.setHours(23, 59, 59, 999);

    const start = new Date(ref);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    return { start: start.getTime(), end: end.getTime() };
  }
}

/**
 * Create a TemporalExtractor instance
 */
export function createTemporalExtractor(options?: Date | TemporalExtractorOptions): TemporalExtractor {
  return new TemporalExtractor(options);
}
