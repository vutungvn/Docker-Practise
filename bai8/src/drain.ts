/**
 * When a container stops taking realtime traffic, its ~2,000 open connections must move to the new version.
 * Closing them all at once makes every client reconnect in the same second (thundering herd), so each
 * connection gets its own moment inside the drain window: evenly spaced slots with random jitter.
 */
export function drainDelays(count: number, windowMs: number, random: () => number = Math.random): number[] {
  if (count <= 0) return [];
  const slot = windowMs / count;
  return Array.from({ length: count }, (_, i) => Math.floor(i * slot + random() * slot));
}
