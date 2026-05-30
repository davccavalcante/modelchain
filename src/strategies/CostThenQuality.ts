import type { ModelDefinition, ModelSnapshot, RoutingStrategy } from '../types.js';

/**
 * Pick the cheapest model that meets a quality floor. Cold-start models are
 * treated as meeting the floor so the strategy explores them first.
 */
export class CostThenQuality implements RoutingStrategy {
  public readonly name = 'cost-then-quality';
  private readonly costById: Map<string, number>;
  private readonly qualityFloor: number;

  public constructor(models: readonly ModelDefinition[], qualityFloor = 0.7) {
    this.costById = new Map();
    this.qualityFloor = Math.max(0, Math.min(1, qualityFloor));
    for (const m of models) {
      const avg = (m.cost.costPer1kInput + m.cost.costPer1kOutput) / 2;
      this.costById.set(String(m.id), avg);
    }
  }

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    const meetingFloor = candidates.filter(
      (c) => c.avgQualityScore === null || c.avgQualityScore >= this.qualityFloor,
    );
    const pool = meetingFloor.length > 0 ? meetingFloor : candidates;
    let bestId: string | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const c of pool) {
      const cost = this.costById.get(c.id) ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        bestCost = cost;
        bestId = c.id;
      }
    }
    return bestId;
  }
}
