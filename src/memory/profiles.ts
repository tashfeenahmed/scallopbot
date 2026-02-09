/**
 * User Profile Manager for ScallopMemory
 *
 * Manages three types of user profiles:
 * - Static Profile: Permanent characteristics (name, timezone, preferences)
 * - Dynamic Profile: Recent context (topics, mood, projects)
 * - Behavioral Patterns: Inferred from history (communication style, expertise)
 */

import type {
  ScallopDatabase,
  DynamicProfile,
  BehavioralPatterns,
  ScallopMemoryEntry,
} from './db.js';

/**
 * Full user profile combining all three components
 */
export interface FullUserProfile {
  userId: string;
  static: Record<string, string>;
  dynamic: DynamicProfile | null;
  behavioral: BehavioralPatterns | null;
}

/**
 * Profile injection format for LLM context
 */
export interface ProfileContext {
  staticProfile: string;
  dynamicContext: string;
  behavioralPatterns: string;
  relevantMemories: string;
}

/**
 * Options for profile update from conversation
 */
export interface ProfileUpdateOptions {
  /** Maximum recent topics to track (default: 10) */
  maxRecentTopics?: number;
  /** Maximum active projects to track (default: 5) */
  maxActiveProjects?: number;
  /** Days to consider for active projects (default: 7) */
  activeProjectDays?: number;
}

/**
 * User Profile Manager
 */
export class ProfileManager {
  private db: ScallopDatabase;
  private options: Required<ProfileUpdateOptions>;

  constructor(db: ScallopDatabase, options: ProfileUpdateOptions = {}) {
    this.db = db;
    this.options = {
      maxRecentTopics: options.maxRecentTopics ?? 10,
      maxActiveProjects: options.maxActiveProjects ?? 5,
      activeProjectDays: options.activeProjectDays ?? 7,
    };
  }

  // ============ Static Profile Operations ============

  /**
   * Set a static profile value
   */
  setStaticValue(userId: string, key: string, value: string, confidence: number = 0.9): void {
    this.db.setProfileValue(userId, key, value, confidence);
  }

  /**
   * Get a static profile value
   */
  getStaticValue(userId: string, key: string): string | null {
    const entry = this.db.getProfileValue(userId, key);
    return entry?.value ?? null;
  }

  /**
   * Get all static profile values
   */
  getStaticProfile(userId: string): Record<string, string> {
    const entries = this.db.getProfile(userId);
    const profile: Record<string, string> = {};
    for (const entry of entries) {
      profile[entry.key] = entry.value;
    }
    return profile;
  }

  /**
   * Delete a static profile value
   */
  deleteStaticValue(userId: string, key: string): boolean {
    return this.db.deleteProfileValue(userId, key);
  }

  /**
   * Update static profile from extracted facts
   */
  updateStaticFromFacts(userId: string, facts: ScallopMemoryEntry[]): void {
    for (const fact of facts) {
      // Only extract profile from user-subject facts
      const subject = fact.metadata?.subject as string | undefined;
      if (subject && subject !== 'user') continue;

      // Skip long content (likely assistant responses stored as facts, not actual extracted facts)
      if (fact.content.length > 100) continue;

      const content = fact.content;
      const lower = content.toLowerCase();

      // Extract name: "Name: X", "Name is X", "Named X", "Called X"
      const nameMatch = lower.match(/^(?:name[:\s]+(?:is\s+)?|named\s+|called\s+)(.+)/i);
      if (nameMatch) {
        // Preserve original case from the fact content
        const nameValue = content.slice(content.length - nameMatch[1].length).trim();
        this.setStaticValue(userId, 'name', nameValue, fact.confidence);
      }

      // Extract location: "Lives in X", "Based in X", "Located in X"
      // Only match at start of content to avoid false positives from longer text
      const locationMatch = lower.match(/^(?:lives in|based in|located in)\s+(.+)/i);
      if (locationMatch) {
        // Clean extracted location: take only the first phrase (before commas, periods, noise words)
        const rawLoc = locationMatch[1].trim();
        const loc = rawLoc.split(/[,.]|\bbtw\b|\bthough\b|\bbut\b/i)[0].trim();
        if (loc) {
          this.setStaticValue(userId, 'location', loc, fact.confidence);
        }
      }

      // Extract timezone (if mentioned) — validate it's a real IANA timezone
      const tzMatch = lower.match(/timezone[:\s]+([a-z_\/]+)/i);
      if (tzMatch) {
        const tz = tzMatch[1];
        if (ProfileManager.isValidTimezone(tz)) {
          this.setStaticValue(userId, 'timezone', tz, fact.confidence);
        }
      }

      // Extract language preference
      const langMatch = lower.match(/(?:speaks?|language)[:\s]+([a-z]+)/i);
      if (langMatch) {
        this.setStaticValue(userId, 'language', langMatch[1], fact.confidence);
      }

      // Extract occupation: "Occupation: X", "Works as X", "Works at X"
      // Require start-of-string to avoid false positives like "cron job"
      const occupationMatch = lower.match(/^(?:occupation[:\s]+|works (?:as|at)\s+|job is\s+)(.+)/i);
      if (occupationMatch) {
        this.setStaticValue(userId, 'occupation', occupationMatch[1].trim(), fact.confidence);
      }
    }
  }

  /**
   * Validate that a timezone string is a valid IANA timezone.
   */
  static isValidTimezone(tz: string): boolean {
    // Must contain a slash (e.g., America/New_York) or be UTC
    if (tz === 'UTC' || tz === 'GMT') return true;
    if (!tz.includes('/')) return false;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  // ============ Dynamic Profile Operations ============

  /**
   * Get dynamic profile
   */
  getDynamicProfile(userId: string): DynamicProfile | null {
    return this.db.getDynamicProfile(userId);
  }

  /**
   * Add a topic to recent topics
   */
  addRecentTopic(userId: string, topic: string): void {
    const profile = this.db.getDynamicProfile(userId);
    const recentTopics = profile?.recentTopics ?? [];

    // Add to front, remove duplicates
    const filtered = recentTopics.filter((t) => t.toLowerCase() !== topic.toLowerCase());
    filtered.unshift(topic);

    // Trim to max
    const trimmed = filtered.slice(0, this.options.maxRecentTopics);

    this.db.updateDynamicProfile(userId, { recentTopics: trimmed });
  }

  /**
   * Set current mood
   */
  setCurrentMood(userId: string, mood: string | null): void {
    this.db.updateDynamicProfile(userId, { currentMood: mood });
  }

  /**
   * Add an active project
   */
  addActiveProject(userId: string, project: string): void {
    const profile = this.db.getDynamicProfile(userId);
    const activeProjects = profile?.activeProjects ?? [];

    // Add if not exists
    if (!activeProjects.some((p) => p.toLowerCase() === project.toLowerCase())) {
      activeProjects.unshift(project);
    }

    // Trim to max
    const trimmed = activeProjects.slice(0, this.options.maxActiveProjects);

    this.db.updateDynamicProfile(userId, { activeProjects: trimmed });
  }

  /**
   * Update dynamic profile from conversation
   */
  updateDynamicFromConversation(
    userId: string,
    message: string,
    extractedTopics?: string[],
    extractedMood?: string
  ): void {
    // Add topics
    if (extractedTopics) {
      for (const topic of extractedTopics) {
        this.addRecentTopic(userId, topic);
      }
    }

    // Set mood if extracted
    if (extractedMood) {
      this.setCurrentMood(userId, extractedMood);
    }

    // Extract projects from message
    const projectPatterns = [
      /working on (?:a |the )?([a-z0-9\s]+?)(?:\.|,|$)/gi,
      /my (?:project|app|tool|system) (?:is |called )?([a-z0-9\s]+?)(?:\.|,|$)/gi,
      /building (?:a |the )?([a-z0-9\s]+?)(?:\.|,|$)/gi,
    ];

    for (const pattern of projectPatterns) {
      let match;
      while ((match = pattern.exec(message)) !== null) {
        this.addActiveProject(userId, match[1].trim());
      }
    }

    // Update last interaction time
    this.db.updateDynamicProfile(userId, {});
  }

  // ============ Behavioral Patterns Operations ============

  /**
   * Get behavioral patterns
   */
  getBehavioralPatterns(userId: string): BehavioralPatterns | null {
    return this.db.getBehavioralPatterns(userId);
  }

  /**
   * Update behavioral patterns (typically run weekly)
   */
  updateBehavioralPatterns(
    userId: string,
    patterns: Partial<Omit<BehavioralPatterns, 'userId' | 'updatedAt'>>
  ): void {
    this.db.updateBehavioralPatterns(userId, patterns);
  }

  /** Track how many messages have been analyzed per user for incremental analysis */
  private lastAnalyzedCount: Map<string, number> = new Map();

  /**
   * Infer behavioral patterns from conversation history.
   * Incremental: only processes new messages since last analysis,
   * merging with existing patterns instead of recomputing from scratch.
   */
  inferBehavioralPatterns(userId: string, messages: Array<{ content: string; timestamp: number }>): void {
    if (messages.length === 0) return;

    // Only process messages we haven't seen yet
    const lastCount = this.lastAnalyzedCount.get(userId) ?? 0;
    const newMessages = messages.slice(lastCount);
    this.lastAnalyzedCount.set(userId, messages.length);

    // If no new messages, skip entirely
    if (newMessages.length === 0) return;

    // Load existing patterns for merging
    const existing = this.getBehavioralPatterns(userId);
    const existingHourCounts = new Map<number, number>();
    const existingTechTerms = new Map<string, number>();

    // Restore previous aggregates from existing patterns
    if (existing?.activeHours) {
      for (const hour of existing.activeHours) {
        existingHourCounts.set(hour, (existingHourCounts.get(hour) || 0) + 1);
      }
    }
    if (existing?.expertiseAreas) {
      for (const area of existing.expertiseAreas) {
        existingTechTerms.set(area, (existingTechTerms.get(area) || 0) + 1);
      }
    }

    // Analyze only new messages
    let totalLength = existing ? (lastCount * (existing.communicationStyle === 'concise' ? 30 : existing.communicationStyle === 'moderate' ? 125 : 300)) : 0;
    totalLength += newMessages.reduce((sum, m) => sum + m.content.length, 0);
    const avgLength = totalLength / messages.length;

    let communicationStyle: string;
    if (avgLength < 50) {
      communicationStyle = 'concise';
    } else if (avgLength < 200) {
      communicationStyle = 'moderate';
    } else {
      communicationStyle = 'detailed';
    }

    // Analyze active hours from new messages only, merge with existing
    for (const msg of newMessages) {
      const hour = new Date(msg.timestamp).getHours();
      existingHourCounts.set(hour, (existingHourCounts.get(hour) || 0) + 1);
    }

    const sortedHours = [...existingHourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => hour);

    // Analyze expertise from new messages only, merge with existing
    const techPatterns = /\b(javascript|typescript|python|react|vue|angular|node|api|database|sql|docker|kubernetes|aws|azure|gcp|machine learning|ai|ml|nlp)\b/gi;

    for (const msg of newMessages) {
      let match;
      while ((match = techPatterns.exec(msg.content)) !== null) {
        const term = match[1].toLowerCase();
        existingTechTerms.set(term, (existingTechTerms.get(term) || 0) + 1);
      }
    }

    const expertiseAreas = [...existingTechTerms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([term]) => term);

    // Analyze response preferences from new messages
    const hasCodeBlocks = newMessages.some((m) => m.content.includes('```')) ||
      (existing?.responsePreferences as Record<string, unknown>)?.prefersCodeExamples === true;
    const hasBulletPoints = newMessages.some((m) => m.content.includes('- ') || m.content.includes('* ')) ||
      (existing?.responsePreferences as Record<string, unknown>)?.prefersBulletPoints === true;
    const responsePreferences = {
      prefersCodeExamples: hasCodeBlocks,
      prefersBulletPoints: hasBulletPoints,
      verbosityLevel: avgLength < 100 ? 2 : avgLength < 300 ? 3 : 4,
    };

    this.updateBehavioralPatterns(userId, {
      communicationStyle,
      expertiseAreas,
      responsePreferences,
      activeHours: sortedHours,
    });
  }

  // ============ Full Profile Operations ============

  /**
   * Get full user profile (all three components)
   */
  getFullProfile(userId: string): FullUserProfile {
    return {
      userId,
      static: this.getStaticProfile(userId),
      dynamic: this.getDynamicProfile(userId),
      behavioral: this.getBehavioralPatterns(userId),
    };
  }

  /**
   * Format profile for LLM context injection
   */
  formatProfileContext(
    userId: string,
    relevantMemories: ScallopMemoryEntry[] = []
  ): ProfileContext {
    const profile = this.getFullProfile(userId);

    // Format static profile
    let staticProfile = '[SCALLOPMEMORY CONTEXT]\nUser Profile (Static):';
    if (Object.keys(profile.static).length > 0) {
      for (const [key, value] of Object.entries(profile.static)) {
        staticProfile += `\n  - ${key}: ${value}`;
      }
    } else {
      staticProfile += '\n  - (no static profile yet)';
    }

    // Format dynamic context
    let dynamicContext = '\nRecent Context (Dynamic):';
    if (profile.dynamic) {
      if (profile.dynamic.activeProjects.length > 0) {
        dynamicContext += `\n  - Working on: ${profile.dynamic.activeProjects.join(', ')}`;
      }
      if (profile.dynamic.recentTopics.length > 0) {
        dynamicContext += `\n  - Recent topics: ${profile.dynamic.recentTopics.slice(0, 5).join(', ')}`;
      }
      if (profile.dynamic.currentMood) {
        dynamicContext += `\n  - Current mood: ${profile.dynamic.currentMood}`;
      }
    } else {
      dynamicContext += '\n  - (no recent context)';
    }

    // Format behavioral patterns
    let behavioralPatterns = '\nBehavioral Patterns:';
    if (profile.behavioral) {
      if (profile.behavioral.communicationStyle) {
        behavioralPatterns += `\n  - Style: ${profile.behavioral.communicationStyle}`;
      }
      if (profile.behavioral.expertiseAreas.length > 0) {
        behavioralPatterns += `\n  - Expertise: ${profile.behavioral.expertiseAreas.join(', ')}`;
      }
    } else {
      behavioralPatterns += '\n  - (not yet analyzed)';
    }

    // Format relevant memories
    let relevantMemoriesStr = '\nRelevant Memories:';
    if (relevantMemories.length > 0) {
      for (const memory of relevantMemories.slice(0, 10)) {
        const confidence = Math.round(memory.prominence * 100);
        relevantMemoriesStr += `\n  - [${confidence}%] ${memory.content}`;
      }
    } else {
      relevantMemoriesStr += '\n  - (no relevant memories found)';
    }

    return {
      staticProfile,
      dynamicContext,
      behavioralPatterns,
      relevantMemories: relevantMemoriesStr,
    };
  }

  /**
   * Get full formatted context string for LLM injection
   */
  getContextString(userId: string, relevantMemories: ScallopMemoryEntry[] = []): string {
    const context = this.formatProfileContext(userId, relevantMemories);
    return `${context.staticProfile}${context.dynamicContext}${context.behavioralPatterns}${context.relevantMemories}`;
  }
}

/**
 * Create a ProfileManager instance
 */
export function createProfileManager(
  db: ScallopDatabase,
  options?: ProfileUpdateOptions
): ProfileManager {
  return new ProfileManager(db, options);
}
