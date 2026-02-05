/**
 * Rule-based fact extraction from text
 *
 * Extracts structured facts (name, location, occupation, preferences, relationships)
 * with subject attribution (user vs third party).
 */

import type { MemoryEntry, MemoryType } from './legacy-types.js';

/**
 * Extracted fact with subject attribution
 */
export interface ExtractedFact {
  /** The fact content */
  content: string;
  /** Who the fact is about: "user" or a person's name */
  subject: string;
}

/**
 * Extract the current subject context from text.
 * Handles multiple patterns:
 * - "my flatmate Bob" (relationship then name)
 * - "Bob is my flatmate" (name then relationship)
 * - "Bob, my flatmate" (name, comma, relationship - appositive)
 * - "my flatmates Bob and Sara" (multiple subjects)
 */
function findThirdPartySubject(text: string): Map<number, string> {
  const subjectRanges = new Map<number, string>();
  const RELATIONSHIPS = 'friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate';

  // Pattern 1: "my <relationship> <Name>"
  const myRelPattern = new RegExp(`[Mm]y\\s+(${RELATIONSHIPS})\\s+([A-Z][a-z]+)`, 'g');

  // Pattern 2: "<Name> is my <relationship>"
  const isMyPattern = new RegExp(`([A-Z][a-z]+)\\s+is\\s+[Mm]y\\s+(${RELATIONSHIPS})`, 'g');

  // Pattern 3: "<Name>, my <relationship>" (appositive)
  const appositivePattern = new RegExp(`([A-Z][a-z]+),?\\s+[Mm]y\\s+(${RELATIONSHIPS})`, 'g');

  // Pattern 4: "my <relationship>s? <Name> and <Name>" (multiple subjects)
  const multipleSubjectPattern = new RegExp(`[Mm]y\\s+(${RELATIONSHIPS})s?\\s+([A-Z][a-z]+)\\s+and\\s+([A-Z][a-z]+)`, 'g');

  let match;

  // Find "my flatmates Bob and Sara" patterns (check first - more specific)
  while ((match = multipleSubjectPattern.exec(text)) !== null) {
    subjectRanges.set(match.index, match[2]); // First name
    // Also mark the second name at the "and Name" position
    const andPos = text.indexOf(` and ${match[3]}`, match.index);
    if (andPos >= 0) {
      subjectRanges.set(andPos, match[3]);
    }
  }

  // Find "my flatmate Bob" patterns
  while ((match = myRelPattern.exec(text)) !== null) {
    subjectRanges.set(match.index, match[2]);
  }

  // Find "Bob is my flatmate" patterns
  while ((match = isMyPattern.exec(text)) !== null) {
    subjectRanges.set(match.index, match[1]);
  }

  // Find "Bob, my flatmate" patterns (appositive)
  while ((match = appositivePattern.exec(text)) !== null) {
    // Avoid duplicate if already matched by isMyPattern
    if (!subjectRanges.has(match.index)) {
      subjectRanges.set(match.index, match[1]);
    }
  }

  return subjectRanges;
}

/**
 * Determine subject for a fact at a given position
 */
function getSubjectAtPosition(position: number, subjectRanges: Map<number, string>): string {
  let currentSubject = 'user';
  let lastPos = -1;

  for (const [pos, subject] of subjectRanges) {
    if (pos <= position && pos > lastPos) {
      currentSubject = subject;
      lastPos = pos;
    }
  }

  return currentSubject;
}

/**
 * Extract facts from text with subject attribution
 */
export function extractFacts(text: string): ExtractedFact[] {
  if (!text.trim()) return [];

  const facts: ExtractedFact[] = [];
  const subjectRanges = findThirdPartySubject(text);

  // Name patterns (user's own name) - case insensitive for "i'm", "I'm" etc
  const namePatterns = [
    /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
  ];

  // Location patterns - case insensitive for "i live", "I live" etc
  const locationPatterns = [
    /(?:i live in|i'm from|i am from|i'm in|located in|based in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my home is in|my house is in|my apartment is in|my flat is in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my address is)\s+(.+?)(?:\.|$)/gi,
  ];

  // Office/workplace location patterns
  const officePatterns = [
    /(?:my office is (?:at|in|on)|my workplace is (?:at|in)|i work (?:at|from|in))\s+(.+?)(?:\.|,|$)/gi,
    /(?:our office is (?:at|in)|the office is (?:at|in))\s+(.+?)(?:\.|,|$)/gi,
  ];

  // Job patterns - user (case insensitive for "i work")
  const userJobPatterns = [
    /(?:i work as|i am a|i'm a|work as a|my job is|my role is|my position is)\s+([a-z]+(?:\s+[a-z]+)*)/gi,
    /(?:i work at|i'm working at|i am employed at|i work for|i'm at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
    /(?:my company is|i work for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gi,
  ];

  // Project/interest patterns
  const projectPatterns = [
    /(?:i'm working on|i am working on|i'm building|i am building|my project is)\s+(.+?)(?:\.|,|$)/gi,
    /(?:i'm learning|i am learning|i'm studying|i am studying)\s+(.+?)(?:\.|,|$)/gi,
  ];

  // Job patterns - third party (comes after relationship mention) - NO 'i' flag to preserve case matching
  // Pattern for company names (capitalized): "works at Google"
  const thirdPartyJobPattern = /(?:works at|working at|employed at|employed by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
  // Pattern for job titles (lowercase): "is a doctor", "is an engineer"
  const thirdPartyJobTitlePattern = /(?:is a|is an)\s+([a-z]+(?:\s+[a-z]+)*)/g;

  // Location patterns - third party - NO 'i' flag
  const thirdPartyLocationPattern = /(?:lives in|is from|is based in|is in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;

  // Preference patterns
  const preferencePatterns = [
    /(?:i prefer|i like|i love|i enjoy|i hate|i dislike)\s+([^.,!?]+)/gi,
  ];

  // Extract user's name
  for (const pattern of namePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Name: ${match[1]}`,
        subject: 'user',
      });
    }
  }

  // Extract user's location
  for (const pattern of locationPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Location: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract office/workplace location
  for (const pattern of officePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Office: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract projects/interests
  for (const pattern of projectPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Project: ${match[1].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract user's job
  for (const pattern of userJobPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: 'user',
      });
    }
  }

  // Extract preferences (always user)
  for (const pattern of preferencePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        content: `Preference: ${match[0].trim()}`,
        subject: 'user',
      });
    }
  }

  // Extract third party jobs (e.g., "my flatmate Bob works at Globex")
  let match;
  while ((match = thirdPartyJobPattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    // Only add if this is about a third party (not the user)
    if (subject !== 'user') {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract third party job titles (e.g., "my brother Ahmed is a doctor")
  while ((match = thirdPartyJobTitlePattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    // Only add if this is about a third party (not the user)
    if (subject !== 'user') {
      facts.push({
        content: `Occupation: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract third party locations (e.g., "my friend John lives in London")
  while ((match = thirdPartyLocationPattern.exec(text)) !== null) {
    const subject = getSubjectAtPosition(match.index, subjectRanges);
    if (subject !== 'user') {
      facts.push({
        content: `Location: ${match[1]}`,
        subject: subject,
      });
    }
  }

  // Extract relationships (my friend X, my flatmate Y, etc.) - NO 'i' flag to preserve case matching for names
  // Use [Mm]y to match both "my" and "My"
  const relationshipPattern1 = /[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)\s+(?:is\s+|named\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g;
  const relationshipPattern2 = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+is\s+[Mm]y\s+(friend|flatmate|roommate|colleague|coworker|brother|sister|mom|dad|mother|father|wife|husband|partner|boss|manager|teammate)/g;

  while ((match = relationshipPattern1.exec(text)) !== null) {
    const relationship = match[1];
    const name = match[2];
    facts.push({
      content: `Relationship: ${relationship} is ${name}`,
      subject: name,
    });
  }

  while ((match = relationshipPattern2.exec(text)) !== null) {
    const name = match[1];
    const relationship = match[2];
    facts.push({
      content: `Relationship: ${relationship} is ${name}`,
      subject: name,
    });
  }

  // Deduplicate by content+subject
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = `${f.subject}:${f.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Summarize multiple memories into a compact form
 */
export function summarizeMemories(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  // Group by type
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const mem of memories) {
    const group = byType.get(mem.type) || [];
    group.push(mem);
    byType.set(mem.type, group);
  }

  const parts: string[] = [];

  // Summarize each type
  for (const [type, mems] of byType) {
    if (mems.length === 1) {
      parts.push(mems[0].content);
    } else {
      // Simple concatenation with dedup
      const unique = [...new Set(mems.map((m) => m.content))];
      if (unique.length <= 3) {
        parts.push(unique.join('. '));
      } else {
        parts.push(`${type}: ${unique.slice(0, 3).join(', ')} (and ${unique.length - 3} more)`);
      }
    }
  }

  return parts.join(' | ');
}
