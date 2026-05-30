import type { ModelSnapshot, RoutingStrategy } from '../types.js';

/** Pick the model with the best observed quality. Cold-start uses healthScore. */
export class QualityFirst implements RoutingStrategy {
  public readonly name = 'quality-first';

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    let bestId: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const c of candidates) {
      const score = c.avgQualityScore !== null ? c.avgQualityScore * 100 : c.healthScore;
      if (score > bestScore) {
        bestScore = score;
        bestId = c.id;
      }
    }
    return bestId;
  }
}
