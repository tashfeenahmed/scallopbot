/** Stable, order-independent identity for a set of source memories. */
export function sourceMemoryFingerprint(sourceMemoryIds: readonly string[]): string {
  return JSON.stringify([...new Set(sourceMemoryIds)].sort());
}
