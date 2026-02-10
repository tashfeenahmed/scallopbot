export const CATEGORY_COLORS: Record<string, string> = {
  preference: '#f472b6',
  fact: '#60a5fa',
  event: '#a78bfa',
  relationship: '#34d399',
  insight: '#fbbf24',
};

export const RELATION_COLORS: Record<string, string> = {
  UPDATES: '#ef4444',
  EXTENDS: '#22d3ee',
  DERIVES: '#a855f7',
};

export const CATEGORY_LABELS: Record<string, string> = {
  preference: 'Preference',
  fact: 'Fact',
  event: 'Event',
  relationship: 'Relationship',
  insight: 'Insight',
};

/** Map importance (1-10) to node radius */
export function nodeSize(importance: number): number {
  return 0.15 + (importance / 10) * 0.45;
}

/** Map prominence (0-1) to opacity */
export function nodeOpacity(prominence: number): number {
  return 0.3 + prominence * 0.7;
}
