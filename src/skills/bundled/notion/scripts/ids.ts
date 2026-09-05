/**
 * Notion identifier helpers.
 *
 * Notion accepts database/data-source/page IDs both dashed and undashed, and
 * people (and models) paste URLs. Everything is canonicalised to the dashed
 * lowercase UUID form so cache lookups and API paths are stable.
 */

const HEX32 = /^[0-9a-f]{32}$/i;

function dashed(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Return the canonical dashed UUID for a Notion ID, or null when the value is
 * not an ID at all (for example a title such as "gym_tracker").
 */
export function normalizeNotionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/-/g, '');
  if (HEX32.test(stripped)) return dashed(stripped);
  if (/^https?:\/\//i.test(trimmed) || /notion\.(?:so|site)\//i.test(trimmed)) {
    const path = trimmed.split(/[?#]/)[0].replace(/-/g, '');
    const runs = path.match(/[0-9a-f]{32,}/gi);
    if (runs && runs.length > 0) return dashed(runs[runs.length - 1].slice(-32));
  }
  return null;
}

export function sameNotionId(a: unknown, b: unknown): boolean {
  const left = normalizeNotionId(a);
  const right = normalizeNotionId(b);
  return !!left && !!right && left === right;
}
