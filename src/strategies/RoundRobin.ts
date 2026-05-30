import type { ModelSnapshot, RoutingStrategy } from '../types.js';

/** Distribute requests evenly across available models. */
export class RoundRobin implements RoutingStrategy {
  public readonly name = 'round-robin';
  private cursor = 0;

  public select(candidates: readonly ModelSnapshot[]): string | null {
    if (candidates.length === 0) return null;
    const idx = this.cursor % candidates.length;
    this.cursor += 1;
    const chosen = candidates[idx];
    return chosen ? chosen.id : null;
  }
}
