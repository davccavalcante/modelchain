import { ModelchainError } from '../errors.js';
import { buildScorer } from '../scoring/index.js';
import { buildStrategy } from '../strategies/index.js';
import type {
  ModelchainOptions,
  ModelchainRouter,
  RoutingStrategy,
  ScoringStrategy,
} from '../types.js';
import { BudgetGuard } from './BudgetGuard.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { HealthMonitor } from './HealthMonitor.js';
import { ModelRegistry } from './ModelRegistry.js';
import { Retrier } from './Retrier.js';
import { Router } from './Router.js';
import { Telemetry } from './Telemetry.js';

/**
 * Top-level factory. Wires up every primitive and returns the public
 * `ModelchainRouter` surface declared in SPEC.md.
 */
export function createModelchain(options: ModelchainOptions): ModelchainRouter {
  if (!options.models || options.models.length === 0) {
    throw new ModelchainError(
      'NO_MODELS_CONFIGURED',
      'createModelchain requires at least one model.',
    );
  }
  const registry = new ModelRegistry(options.models);
  const strategy: RoutingStrategy =
    typeof options.strategy === 'object' && options.strategy !== null
      ? options.strategy
      : buildStrategy(options.strategy ?? 'cost-then-quality', options.models);
  const scorers: ScoringStrategy[] = [
    ...(options.scoring?.built ?? []).map((name) => buildScorer(name)),
    ...(options.scoring?.custom ?? []),
  ];
  const retrier = new Retrier(
    options.retry ?? { max: 3, baseMs: 250, jitter: true, maxDelayMs: 30_000 },
  );
  const circuitBreaker = new CircuitBreaker(
    options.circuitBreaker ?? { threshold: 3, cooldownMs: 30_000 },
  );
  const healthMonitor = new HealthMonitor();
  const budgetGuard = new BudgetGuard(options.budget);
  const telemetry = new Telemetry(options.telemetry?.enabled ?? false);
  const fallback = {
    onError: options.fallback?.onError ?? 'next',
    maxAttempts: options.fallback?.maxAttempts ?? options.models.length,
  };
  const router = new Router(
    registry,
    strategy,
    scorers,
    circuitBreaker,
    retrier,
    healthMonitor,
    budgetGuard,
    telemetry,
    fallback,
  );
  if (options.state) {
    void options.state.load().then((snapshot) => {
      if (snapshot) {
        registry.restoreFrom(snapshot);
        budgetGuard.restore(snapshot.spentTodayUsd, snapshot.day);
      }
    });
  }
  return {
    complete: (request) => router.complete(request),
    stream: (request) => router.stream(request),
    inspect: () => router.inspect(),
    on: (listener) => telemetry.on(listener),
    close: async () => {
      telemetry.dispose();
      if (options.state) {
        await options.state.save(
          registry.toStateSnapshot(budgetGuard.getSpentToday(), budgetGuard.getCurrentDay()),
        );
      }
    },
  };
}
