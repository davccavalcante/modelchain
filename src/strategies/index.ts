import type { ModelDefinition, RoutingStrategy, RoutingStrategyName } from '../types.js';
import { CostFirst } from './CostFirst.js';
import { CostThenQuality } from './CostThenQuality.js';
import { LatencyFirst } from './LatencyFirst.js';
import { QualityFirst } from './QualityFirst.js';
import { RoundRobin } from './RoundRobin.js';
import { SequentialFallback } from './SequentialFallback.js';
import { Weighted } from './Weighted.js';

/** Build a strategy instance from its name. Throws on unknown name. */
export function buildStrategy(
  name: RoutingStrategyName,
  models: readonly ModelDefinition[],
): RoutingStrategy {
  switch (name) {
    case 'round-robin':
      return new RoundRobin();
    case 'weighted':
      return new Weighted(models);
    case 'cost-first':
      return new CostFirst(models);
    case 'quality-first':
      return new QualityFirst();
    case 'cost-then-quality':
      return new CostThenQuality(models);
    case 'latency-first':
      return new LatencyFirst();
    case 'sequential-fallback':
      return new SequentialFallback();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown routing strategy: ${String(exhaustive)}`);
    }
  }
}

export {
  CostFirst,
  CostThenQuality,
  LatencyFirst,
  QualityFirst,
  RoundRobin,
  SequentialFallback,
  Weighted,
};
