import type { ModelDefinition, ModelSnapshot, RoutingStrategy } from '../types.js';

/** Pick the cheapest available model. */
export class CostFirst implements RoutingStrategy {
  public readonly name = 'cost-first';
  private readonly costById: Map<string, number>;

  public constructor(models: readonly ModelDefinition[]) {
    this.costById = new Map();
    for (const m of models) {
      const avg = (m.cost.costPer1kInput + m.cost.costPer1kOutput) / 2;
      this.costById.set(String(m.id), avg);
    }
  }

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    let bestId: string | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const cost = this.costById.get(c.id) ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        bestCost = cost;
        bestId = c.id;
      }
    }
    return bestId;
  }
}
