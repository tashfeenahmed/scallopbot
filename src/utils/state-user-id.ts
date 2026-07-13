import { parseUserIdPrefix } from '../triggers/types.js';

/** Durable state identity used by memories, profiles, goals, and board items. */
export const DEFAULT_STATE_USER_ID = 'default';

/**
 * Resolve a channel identity to its durable state owner.
 *
 * `default` (including `api:default`) is canonical by definition. Any other
 * identity is collapsed to `default` only when the deployment explicitly
 * declares it as an alias for its single owner. Open or multi-user deployments
 * therefore retain the full channel-prefixed identity and cannot share state by
 * accident.
 */
export function resolveStateUserId(
  userId: string | null | undefined,
  canonicalSingleUserIds: readonly string[] = [],
): string {
  const trimmed = userId?.trim() ?? '';
  if (!trimmed) return DEFAULT_STATE_USER_ID;

  const { channel, rawUserId } = parseUserIdPrefix(trimmed);
  if (trimmed === DEFAULT_STATE_USER_ID || rawUserId === DEFAULT_STATE_USER_ID) {
    return DEFAULT_STATE_USER_ID;
  }

  const aliases = new Set(
    canonicalSingleUserIds
      .map(alias => alias.trim())
      .filter(Boolean),
  );
  // A raw alias exists for backward-compatible, unprefixed rows. Never apply
  // that raw match to another explicit transport: `api:123` must not inherit
  // the state of an allowed Telegram owner whose chat ID is also `123`.
  return aliases.has(trimmed) || (!channel && aliases.has(rawUserId))
    ? DEFAULT_STATE_USER_ID
    : trimmed;
}

/**
 * Resolve timezone configuration for a durable state owner. In a declared
 * single-user deployment, board/reminder rows intentionally use `default`,
 * while onboarding configuration may still live under the owner's channel ID.
 * Prefer that explicit owner timezone over the synthetic default UTC row.
 */
export function resolveStateUserTimezone(
  userId: string | null | undefined,
  canonicalSingleUserIds: readonly string[],
  getTimezone: (candidateUserId: string) => string,
): string {
  const requested = userId?.trim() || DEFAULT_STATE_USER_ID;
  const direct = getTimezone(requested) || 'UTC';
  if (resolveStateUserId(requested, canonicalSingleUserIds) !== DEFAULT_STATE_USER_ID) {
    return direct;
  }

  for (const alias of canonicalSingleUserIds) {
    const candidate = alias.trim();
    if (!candidate) continue;
    const timezone = getTimezone(candidate);
    if (timezone && timezone !== 'UTC') return timezone;
  }
  return direct;
}
