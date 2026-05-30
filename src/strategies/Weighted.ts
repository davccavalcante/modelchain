import type { ModelDefinition, ModelSnapshot, RoutingStrategy } from '../types.js';

/** Pick a model with probability proportional to its declared `weight`. */
export class Weighted implements RoutingStrategy {
  public readonly name = 'weighted';
  private readonly weightById: Map<string, number>;

  public constructor(models: readonly ModelDefinition[]) {
    this.weightById = new Map();
    for (const m of models) {
      const w = m.weight ?? 1;
      this.weightById.set(String(m.id), Math.max(0, w));
    }
  }

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    const weights = candidates.map((c) => this.weightById.get(c.id) ?? 1);
    const total = weights.reduce((acc, w) => acc + w, 0);
    if (total <= 0) {
      const first = candidates[0];
      return first ? first.id : null;
    }
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i += 1) {
      r -= weights[i] ?? 0;
      if (r <= 0) {
        const chosen = candidates[i];
        return chosen ? chosen.id : null;
      }
    }
    const last = candidates[candidates.length - 1];
    return last ? last.id : null;
  }
}
