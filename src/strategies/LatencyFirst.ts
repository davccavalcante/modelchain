import type { ModelSnapshot, RoutingStrategy } from '../types.js';

/** Lowest observed average latency. Cold-start (unseen) models are tried first. */
export class LatencyFirst implements RoutingStrategy {
  public readonly name = 'latency-first';

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    const unseen = candidates.find((c) => c.avgLatencyMs === 0 && c.successCount === 0);
    if (unseen) return unseen.id;
    let bestId: string | null = null;
    let bestLatency = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (c.avgLatencyMs > 0 && c.avgLatencyMs < bestLatency) {
        bestLatency = c.avgLatencyMs;
        bestId = c.id;
      }
    }
    return bestId ?? candidates[0]?.id ?? null;
  }
}
