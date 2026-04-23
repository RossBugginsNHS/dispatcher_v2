const processedDeliveries = new Map<string, number>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function isReplayDelivery(deliveryId: string, ttlMs = DEFAULT_TTL_MS): boolean {
  pruneExpired(ttlMs);
  const now = Date.now();
  const previousSeenAt = processedDeliveries.get(deliveryId);
  if (previousSeenAt && now - previousSeenAt <= ttlMs) {
    return true;
  }
  processedDeliveries.set(deliveryId, now);
  return false;
}

function pruneExpired(ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [deliveryId, seenAt] of processedDeliveries.entries()) {
    if (seenAt < cutoff) {
      processedDeliveries.delete(deliveryId);
    }
  }
}
