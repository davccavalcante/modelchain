import type { ModelDefinition, ModelSnapshot, StateSnapshot } from '../types.js';
import type { CircuitBreakerState } from './CircuitBreaker.js';

/** Per-model mutable runtime state managed by the registry. */
export interface ModelRuntimeState {
  readonly definition: ModelDefinition;
  readonly circuit: CircuitBreakerState;
  healthScore: number;
  inFlight: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  qualityScores: number[];
  totalCostUsd: number;
  lastUsedAt: number;
}

/** Holds the declarative pool plus per-model runtime state. */
export class ModelRegistry {
  private readonly byId: Map<string, ModelRuntimeState>;

  public constructor(models: readonly ModelDefinition[]) {
    if (models.length === 0) {
      throw new Error('ModelRegistry requires at least one model definition.');
    }
    this.byId = new Map();
    for (const def of models) {
      const id = String(def.id);
      if (this.byId.has(id)) {
        throw new Error(`Duplicate model id: ${id}`);
      }
      this.byId.set(id, {
        definition: def,
        circuit: { state: 'closed', consecutiveFailures: 0, cooldownUntil: 0 },
        healthScore: 100,
        inFlight: 0,
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        qualityScores: [],
        totalCostUsd: 0,
        lastUsedAt: 0,
      });
    }
  }

  public get(modelId: string): ModelRuntimeState | undefined {
    return this.byId.get(modelId);
  }

  public all(): ModelRuntimeState[] {
    return Array.from(this.byId.values());
  }

  public snapshots(): ModelSnapshot[] {
    return this.all().map((s) => toSnapshot(s));
  }

  public restoreFrom(snapshot: StateSnapshot): void {
    for (const [id, state] of this.byId) {
      const prior = snapshot.models[id];
      if (!prior) continue;
      state.healthScore = prior.healthScore;
      state.avgLatencyMs = prior.avgLatencyMs;
      if (prior.avgQualityScore !== null) state.qualityScores = [prior.avgQualityScore];
      state.successCount = prior.successCount;
      state.failureCount = prior.failureCount;
      state.circuit.consecutiveFailures = prior.consecutiveFailures;
      state.circuit.cooldownUntil = prior.cooldownUntil;
      state.totalCostUsd = prior.totalCostUsd;
    }
  }

  public toStateSnapshot(spentTodayUsd: number, day: string): StateSnapshot {
    const models: Record<string, StateSnapshot['models'][string]> = {};
    for (const [id, state] of this.byId) {
      const avg =
        state.qualityScores.length > 0
          ? state.qualityScores.reduce((acc, v) => acc + v, 0) / state.qualityScores.length
          : null;
      models[id] = {
        healthScore: state.healthScore,
        avgLatencyMs: state.avgLatencyMs,
        avgQualityScore: avg,
        successCount: state.successCount,
        failureCount: state.failureCount,
        consecutiveFailures: state.circuit.consecutiveFailures,
        cooldownUntil: state.circuit.cooldownUntil,
        totalCostUsd: state.totalCostUsd,
      };
    }
    return { models, spentTodayUsd, day };
  }
}

export function toSnapshot(state: ModelRuntimeState): ModelSnapshot {
  const avg =
    state.qualityScores.length > 0
      ? state.qualityScores.reduce((acc, v) => acc + v, 0) / state.qualityScores.length
      : null;
  return {
    id: String(state.definition.id),
    providerName: state.definition.provider.name,
    circuitState: state.circuit.state,
    healthScore: state.healthScore,
    inFlight: state.inFlight,
    successCount: state.successCount,
    failureCount: state.failureCount,
    consecutiveFailures: state.circuit.consecutiveFailures,
    cooldownUntil: state.circuit.cooldownUntil,
    lastUsedAt: state.lastUsedAt,
    avgLatencyMs: state.avgLatencyMs,
    avgQualityScore: avg,
    totalCostUsd: state.totalCostUsd,
  };
}
