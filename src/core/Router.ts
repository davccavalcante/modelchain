import { AllModelsExhaustedError, ProviderError } from '../errors.js';
import { resolveKey } from '../providers/_shared.js';
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  ModelId,
  PartialToolCall,
  ProviderErrorClass,
  RouterSnapshot,
  RoutingStrategy,
  ScoringStrategy,
  ToolCall,
} from '../types.js';
import type { BudgetGuard } from './BudgetGuard.js';
import type { CircuitBreaker } from './CircuitBreaker.js';
import type { HealthMonitor } from './HealthMonitor.js';
import { type ModelRegistry, type ModelRuntimeState, toSnapshot } from './ModelRegistry.js';
import type { Retrier } from './Retrier.js';
import type { Telemetry } from './Telemetry.js';

/** Inner orchestrator wired up by `createModelchain`. */
export class Router {
  private totalRequests = 0;
  private totalStreams = 0;
  private totalFailures = 0;

  public constructor(
    private readonly registry: ModelRegistry,
    private readonly strategy: RoutingStrategy,
    private readonly scorers: readonly ScoringStrategy[],
    private readonly circuitBreaker: CircuitBreaker,
    private readonly retrier: Retrier,
    private readonly healthMonitor: HealthMonitor,
    private readonly budgetGuard: BudgetGuard,
    private readonly telemetry: Telemetry,
    private readonly fallback: { onError: 'next' | 'fail'; maxAttempts: number },
  ) {}

  public async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.totalRequests += 1;
    const seenModelIds = new Set<string>();
    let lastError: unknown = null;
    let lastReason = 'no attempts made';

    for (let attempt = 0; attempt < this.fallback.maxAttempts; attempt += 1) {
      this.telemetry.emit({
        type: 'request.start',
        ...(request.task !== undefined ? { task: String(request.task) } : {}),
        attempt,
        timestamp: Date.now(),
      });
      const candidates = this.eligibleCandidates(seenModelIds);
      if (candidates.length === 0) {
        lastReason = 'no eligible models remaining';
        break;
      }
      const chosenId = this.strategy.select(candidates, request);
      if (!chosenId) {
        lastReason = `strategy ${this.strategy.name} returned null`;
        break;
      }
      const state = this.registry.get(chosenId);
      if (!state) {
        lastReason = `strategy chose unknown model ${chosenId}`;
        break;
      }
      seenModelIds.add(chosenId);
      this.circuitBreaker.enterHalfOpen(state.circuit, Date.now());
      this.telemetry.emit({
        type: 'model.selected',
        modelId: chosenId,
        reason: `${this.strategy.name}:attempt=${attempt}`,
        timestamp: Date.now(),
      });
      try {
        this.budgetGuard.preflight(
          request,
          this.budgetGuard.estimate(request, state.definition.cost),
        );
        const response = await this.executeCompleteOnce(state, request, attempt);
        return response;
      } catch (err: unknown) {
        lastError = err;
        lastReason = err instanceof Error ? err.message : String(err);
        const fatal = isFatal(err);
        if (fatal || this.fallback.onError === 'fail') break;
      }
    }

    this.totalFailures += 1;
    const snapshots = this.registry.snapshots();
    this.telemetry.emit({ type: 'all.exhausted', reason: lastReason, timestamp: Date.now() });
    if (lastError instanceof Error) {
      throw new AllModelsExhaustedError(snapshots, lastReason);
    }
    throw new AllModelsExhaustedError(snapshots, lastReason);
  }

  public async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.totalStreams += 1;
    const seenModelIds = new Set<string>();
    let lastError: unknown = null;
    let lastReason = 'no attempts made';

    for (let attempt = 0; attempt < this.fallback.maxAttempts; attempt += 1) {
      this.telemetry.emit({
        type: 'request.start',
        ...(request.task !== undefined ? { task: String(request.task) } : {}),
        attempt,
        timestamp: Date.now(),
      });
      const candidates = this.eligibleCandidates(seenModelIds);
      if (candidates.length === 0) {
        lastReason = 'no eligible models remaining';
        break;
      }
      const chosenId = this.strategy.select(candidates, request);
      if (!chosenId) {
        lastReason = `strategy ${this.strategy.name} returned null`;
        break;
      }
      const state = this.registry.get(chosenId);
      if (!state) {
        lastReason = `strategy chose unknown model ${chosenId}`;
        break;
      }
      seenModelIds.add(chosenId);
      this.circuitBreaker.enterHalfOpen(state.circuit, Date.now());
      this.telemetry.emit({
        type: 'model.selected',
        modelId: chosenId,
        reason: `${this.strategy.name}:attempt=${attempt}`,
        timestamp: Date.now(),
      });
      try {
        this.budgetGuard.preflight(
          request,
          this.budgetGuard.estimate(request, state.definition.cost),
        );
        yield* this.executeStreamOnce(state, request);
        return;
      } catch (err: unknown) {
        lastError = err;
        lastReason = err instanceof Error ? err.message : String(err);
        const fatal = isFatal(err);
        if (fatal || this.fallback.onError === 'fail') break;
      }
    }

    this.totalFailures += 1;
    this.telemetry.emit({ type: 'all.exhausted', reason: lastReason, timestamp: Date.now() });
    if (lastError instanceof Error)
      throw new AllModelsExhaustedError(this.registry.snapshots(), lastReason);
    throw new AllModelsExhaustedError(this.registry.snapshots(), lastReason);
  }

  public inspect(): RouterSnapshot {
    return {
      strategy: this.strategy.name,
      totalRequests: this.totalRequests,
      totalStreams: this.totalStreams,
      totalFailures: this.totalFailures,
      totalCostUsd: this.registry.all().reduce((acc, s) => acc + s.totalCostUsd, 0),
      budget: this.budgetGuard.snapshot(),
      models: this.registry.snapshots(),
    };
  }

  private eligibleCandidates(seenModelIds: ReadonlySet<string>) {
    const now = Date.now();
    const eligible: ReturnType<typeof toSnapshot>[] = [];
    for (const state of this.registry.all()) {
      if (seenModelIds.has(String(state.definition.id))) continue;
      if (!this.circuitBreaker.isAvailable(state.circuit, now)) continue;
      eligible.push(toSnapshot(state));
    }
    return eligible;
  }

  private async executeCompleteOnce(
    state: ModelRuntimeState,
    request: CompletionRequest,
    outerAttempt: number,
  ): Promise<CompletionResponse> {
    state.inFlight += 1;
    state.lastUsedAt = Date.now();
    const startedAt = Date.now();
    try {
      let lastErr: unknown = null;
      for (let innerAttempt = 0; innerAttempt <= this.retrier.maxAttempts; innerAttempt += 1) {
        const apiKey = await resolveKey(state.definition.keys);
        try {
          const response = await state.definition.provider.complete(request, {
            model: state.definition,
            apiKey,
            attemptNumber: outerAttempt + innerAttempt,
          });
          this.recordSuccess(state, request, response);
          return response;
        } catch (err: unknown) {
          lastErr = err;
          const parsed =
            err instanceof ProviderError
              ? {
                  classification: err.classification as ProviderErrorClass,
                  ...(err.status !== undefined ? { status: err.status } : {}),
                  message: err.message,
                }
              : state.definition.provider.parseError(err);
          this.telemetry.emit({
            type: 'request.fail',
            modelId: String(state.definition.id),
            ...(parsed.status !== undefined ? { status: parsed.status } : {}),
            classification: parsed.classification,
            message: parsed.message,
            timestamp: Date.now(),
          });
          const retryable = isRetryable(parsed.classification);
          if (!retryable || !this.retrier.shouldRetry(innerAttempt)) {
            this.recordFailure(state, parsed.classification);
            throw err;
          }
          const delay =
            (parsed as { retryAfterMs?: number }).retryAfterMs ??
            this.retrier.delayMs(innerAttempt);
          await this.retrier.sleep(delay, request.signal);
        }
      }
      throw lastErr ?? new Error('Retry loop exited without resolution');
    } finally {
      state.inFlight -= 1;
      const lat = Date.now() - startedAt;
      state.avgLatencyMs = state.avgLatencyMs === 0 ? lat : state.avgLatencyMs * 0.8 + lat * 0.2;
    }
  }

  private async *executeStreamOnce(
    state: ModelRuntimeState,
    request: CompletionRequest,
  ): AsyncIterable<CompletionChunk> {
    state.inFlight += 1;
    state.lastUsedAt = Date.now();
    const startedAt = Date.now();
    let collectedText = '';
    const partialToolCalls = new Map<number, PartialToolCall>();
    this.telemetry.emit({
      type: 'stream.start',
      modelId: String(state.definition.id),
      timestamp: Date.now(),
    });
    try {
      const apiKey = await resolveKey(state.definition.keys);
      const iterator = state.definition.provider.stream(request, {
        model: state.definition,
        apiKey,
        attemptNumber: 0,
      });
      for await (const chunk of iterator) {
        if (chunk.type === 'text-delta') {
          collectedText += chunk.delta;
        } else if (chunk.type === 'tool-call-delta') {
          mergePartialToolCall(partialToolCalls, chunk.toolCall);
        } else if (chunk.type === 'finish') {
          const toolCalls = finaliseToolCalls(partialToolCalls);
          const response: CompletionResponse = {
            text: collectedText,
            toolCalls,
            finishReason: chunk.finishReason,
            usage: chunk.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            modelId: state.definition.id as ModelId,
            providerName: state.definition.provider.name,
            latencyMs: Date.now() - startedAt,
          };
          this.recordSuccess(state, request, response, /* fromStream */ true);
        }
        yield chunk;
      }
    } catch (err: unknown) {
      const parsed =
        err instanceof ProviderError
          ? {
              classification: err.classification as ProviderErrorClass,
              ...(err.status !== undefined ? { status: err.status } : {}),
              message: err.message,
            }
          : state.definition.provider.parseError(err);
      this.telemetry.emit({
        type: 'request.fail',
        modelId: String(state.definition.id),
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        classification: parsed.classification,
        message: parsed.message,
        timestamp: Date.now(),
      });
      this.recordFailure(state, parsed.classification);
      throw err;
    } finally {
      state.inFlight -= 1;
      const lat = Date.now() - startedAt;
      state.avgLatencyMs = state.avgLatencyMs === 0 ? lat : state.avgLatencyMs * 0.8 + lat * 0.2;
    }
  }

  private recordSuccess(
    state: ModelRuntimeState,
    request: CompletionRequest,
    response: CompletionResponse,
    fromStream = false,
  ): void {
    state.successCount += 1;
    const transitioned = this.circuitBreaker.recordSuccess(state.circuit);
    if (transitioned) {
      this.telemetry.emit({
        type: 'circuit.closed',
        modelId: String(state.definition.id),
        timestamp: Date.now(),
      });
    }
    state.healthScore = this.healthMonitor.recordSuccess(state.healthScore);
    const actualCost = this.budgetGuard.commit(request, state.definition.cost, response.usage);
    state.totalCostUsd += actualCost;
    if (fromStream) {
      this.telemetry.emit({
        type: 'stream.finish',
        modelId: String(state.definition.id),
        latencyMs: response.latencyMs,
        costUsd: actualCost,
        usage: response.usage,
        finishReason: response.finishReason,
        toolCallCount: response.toolCalls.length,
        timestamp: Date.now(),
      });
    } else {
      this.telemetry.emit({
        type: 'request.success',
        modelId: String(state.definition.id),
        latencyMs: response.latencyMs,
        costUsd: actualCost,
        usage: response.usage,
        finishReason: response.finishReason,
        toolCallCount: response.toolCalls.length,
        timestamp: Date.now(),
      });
    }
    if (this.scorers.length > 0) {
      void this.runScorers(state, request, response);
    }
  }

  private async runScorers(
    state: ModelRuntimeState,
    request: CompletionRequest,
    response: CompletionResponse,
  ): Promise<void> {
    for (const scorer of this.scorers) {
      try {
        const result = await scorer.score(request, response);
        state.qualityScores.push(result.score);
        if (state.qualityScores.length > 100) state.qualityScores.shift();
        state.healthScore = this.healthMonitor.recordQuality(state.healthScore, result.score);
        this.telemetry.emit({
          type: 'score.recorded',
          modelId: String(state.definition.id),
          scorer: result.scorer,
          score: result.score,
          timestamp: Date.now(),
        });
        if (state.healthScore < 50) {
          this.telemetry.emit({
            type: 'model.degraded',
            modelId: String(state.definition.id),
            healthScore: state.healthScore,
            timestamp: Date.now(),
          });
        }
      } catch {
        // Scorer crashes never affect the request.
      }
    }
  }

  private recordFailure(state: ModelRuntimeState, classification: ProviderErrorClass): void {
    state.failureCount += 1;
    const severity = severityFor(classification);
    state.healthScore = this.healthMonitor.recordFailure(state.healthScore, severity);
    const transitioned = this.circuitBreaker.recordFailure(state.circuit, Date.now());
    if (transitioned && state.circuit.state === 'open') {
      this.telemetry.emit({
        type: 'circuit.open',
        modelId: String(state.definition.id),
        cooldownUntil: state.circuit.cooldownUntil,
        timestamp: Date.now(),
      });
    }
  }
}

function mergePartialToolCall(map: Map<number, PartialToolCall>, delta: PartialToolCall): void {
  const existing = map.get(delta.index);
  if (!existing) {
    map.set(delta.index, { ...delta });
    return;
  }
  const merged: PartialToolCall = {
    index: delta.index,
    ...(existing.id !== undefined ? { id: existing.id } : {}),
    ...(existing.name !== undefined ? { name: existing.name } : {}),
    ...(existing.argumentsDelta !== undefined ? { argumentsDelta: existing.argumentsDelta } : {}),
  };
  if (delta.id !== undefined) (merged as { id?: string }).id = delta.id;
  if (delta.name !== undefined) (merged as { name?: string }).name = delta.name;
  if (delta.argumentsDelta !== undefined) {
    (merged as { argumentsDelta?: string }).argumentsDelta =
      (existing.argumentsDelta ?? '') + delta.argumentsDelta;
  }
  map.set(delta.index, merged);
}

function finaliseToolCalls(map: Map<number, PartialToolCall>): readonly ToolCall[] {
  const result: ToolCall[] = [];
  const indices = Array.from(map.keys()).sort((a, b) => a - b);
  for (const i of indices) {
    const partial = map.get(i);
    if (!partial?.id || !partial.name) continue;
    let parsedArgs: Record<string, unknown> = {};
    if (partial.argumentsDelta) {
      try {
        const parsed = JSON.parse(partial.argumentsDelta);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore malformed JSON; emit empty args
      }
    }
    result.push({ id: partial.id, name: partial.name, arguments: parsedArgs });
  }
  return result;
}

function isRetryable(classification: ProviderErrorClass): boolean {
  return (
    classification === 'rate-limited' ||
    classification === 'server-error' ||
    classification === 'timeout' ||
    classification === 'network'
  );
}

function severityFor(classification: ProviderErrorClass): number {
  switch (classification) {
    case 'server-error':
      return 1;
    case 'unauthorized':
      return 0.9;
    case 'rate-limited':
      return 0.4;
    case 'timeout':
      return 0.5;
    case 'network':
      return 0.5;
    case 'bad-request':
      return 0.3;
    case 'unknown':
      return 0.4;
    default: {
      const exhaustive: never = classification;
      throw new Error(`Unhandled classification: ${String(exhaustive)}`);
    }
  }
}

function isFatal(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.classification === 'bad-request';
  }
  return false;
}
