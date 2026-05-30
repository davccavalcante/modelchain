import type { ModelSnapshot, RoutingStrategy } from '../types.js';

/** Always pick the first available model in declaration order. */
export class SequentialFallback implements RoutingStrategy {
  public readonly name = 'sequential-fallback';

  public select(candidates: readonly ModelSnapshot[]): string | null {
    const first = candidates[0];
    return first ? first.id : null;
  }
}
