import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/core/BudgetGuard.js';
import { CircuitBreaker } from '../../src/core/CircuitBreaker.js';
import { HealthMonitor } from '../../src/core/HealthMonitor.js';
import { ModelRegistry } from '../../src/core/ModelRegistry.js';
import { Retrier } from '../../src/core/Retrier.js';
import { Telemetry } from '../../src/core/Telemetry.js';
import { BudgetExceededError } from '../../src/errors.js';
import type { CompletionRequest, ModelDefinition, ProviderAdapter } from '../../src/types.js';

const noopProvider: ProviderAdapter = {
  name: 'noop',
  complete: () =>
    Promise.resolve({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      modelId: 'noop' as never,
      providerName: 'noop',
      latencyMs: 0,
    }),
  stream: async function* () {
    yield {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  },
  parseError: () => ({ classification: 'unknown', message: 'noop' }),
};

const modelDef = (id: string): ModelDefinition => ({
  id,
  provider: noopProvider,
  cost: { costPer1kInput: 0.001, costPer1kOutput: 0.002 },
  keys: 'sk-test',
});

const req = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  prompt: 'hello',
  ...overrides,
});

describe('Telemetry', () => {
  it('emits to subscribed listeners when enabled', () => {
    const t = new Telemetry(true);
    const seen: string[] = [];
    t.on((e) => seen.push(e.type));
    t.emit({ type: 'request.start', attempt: 0, timestamp: 1 });
    expect(seen).toEqual(['request.start']);
  });

  it('no-ops when disabled', () => {
    const t = new Telemetry(false);
    const seen: string[] = [];
    t.on((e) => seen.push(e.type));
    t.emit({ type: 'request.start', attempt: 0, timestamp: 1 });
    expect(seen).toEqual([]);
  });

  it('unsubscribe removes the listener', () => {
    const t = new Telemetry(true);
    const seen: string[] = [];
    const off = t.on((e) => seen.push(e.type));
    off();
    t.emit({ type: 'request.start', attempt: 0, timestamp: 1 });
    expect(seen).toEqual([]);
  });

  it('listener crash does not propagate', () => {
    const t = new Telemetry(true);
    const seen: string[] = [];
    t.on(() => {
      throw new Error('boom');
    });
    t.on((e) => seen.push(e.type));
    t.emit({ type: 'request.start', attempt: 0, timestamp: 1 });
    expect(seen).toEqual(['request.start']);
  });

  it('dispose clears listeners', () => {
    const t = new Telemetry(true);
    const seen: string[] = [];
    t.on((e) => seen.push(e.type));
    t.dispose();
    t.emit({ type: 'request.start', attempt: 0, timestamp: 1 });
    expect(seen).toEqual([]);
  });
});

describe('HealthMonitor', () => {
  const h = new HealthMonitor();

  it('recordSuccess moves toward 100', () => {
    expect(h.recordSuccess(80)).toBeGreaterThan(80);
    expect(h.recordSuccess(100)).toBe(100);
  });

  it('recordFailure reduces by severity*weight*currentScore', () => {
    const after = h.recordFailure(100, 1);
    expect(after).toBeLessThan(100);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('recordFailure with severity 0 leaves score unchanged', () => {
    expect(h.recordFailure(80, 0)).toBe(80);
  });

  it('recordQuality with perfect 1 leaves score unchanged', () => {
    expect(h.recordQuality(80, 1)).toBe(80);
  });

  it('recordQuality with 0 reduces score', () => {
    expect(h.recordQuality(80, 0)).toBeLessThan(80);
  });

  it('clamps to [0, 100]', () => {
    expect(h.recordFailure(0, 1)).toBe(0);
    expect(h.recordSuccess(100)).toBe(100);
  });
});

describe('CircuitBreaker', () => {
  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
    const state = { state: 'closed' as const, consecutiveFailures: 0, cooldownUntil: 0 };
    cb.recordFailure(state, 1000);
    expect(state.state).toBe('closed');
    cb.recordFailure(state, 1001);
    expect(state.state).toBe('open');
    expect(state.cooldownUntil).toBe(1101);
  });

  it('half-open after cooldown, closes on success', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 100 });
    const state = { state: 'closed' as const, consecutiveFailures: 0, cooldownUntil: 0 };
    cb.recordFailure(state, 1000);
    expect(state.state).toBe('open');
    expect(cb.isAvailable(state, 1050)).toBe(false);
    expect(cb.isAvailable(state, 1101)).toBe(true);
    cb.enterHalfOpen(state, 1101);
    expect(state.state).toBe('half-open');
    cb.recordSuccess(state);
    expect(state.state).toBe('closed');
    expect(state.consecutiveFailures).toBe(0);
  });

  it('re-opens on failure during half-open probe', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 100 });
    const state = { state: 'half-open' as const, consecutiveFailures: 1, cooldownUntil: 1000 };
    cb.recordFailure(state, 2000);
    expect(state.state).toBe('open');
    expect(state.cooldownUntil).toBe(2100);
  });
});

describe('Retrier', () => {
  it('shouldRetry respects max', () => {
    const r = new Retrier({ max: 3, baseMs: 10, jitter: false });
    expect(r.shouldRetry(0)).toBe(true);
    expect(r.shouldRetry(2)).toBe(true);
    expect(r.shouldRetry(3)).toBe(false);
  });

  it('delayMs grows exponentially without jitter', () => {
    const r = new Retrier({ max: 3, baseMs: 100, jitter: false });
    expect(r.delayMs(0)).toBe(100);
    expect(r.delayMs(1)).toBe(200);
    expect(r.delayMs(2)).toBe(400);
  });

  it('delayMs caps at maxDelayMs', () => {
    const r = new Retrier({ max: 5, baseMs: 1000, jitter: false, maxDelayMs: 1500 });
    expect(r.delayMs(10)).toBe(1500);
  });

  it('delayMs with jitter stays in [0, capped]', () => {
    const r = new Retrier({ max: 3, baseMs: 100, jitter: true, maxDelayMs: 1000 });
    for (let i = 0; i < 50; i += 1) {
      const d = r.delayMs(2);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(400);
    }
  });

  it('sleep resolves after the given ms', async () => {
    const r = new Retrier({ max: 3, baseMs: 1, jitter: false });
    const start = Date.now();
    await r.sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('sleep rejects on abort signal', async () => {
    const r = new Retrier({ max: 3, baseMs: 1, jitter: false });
    const ctrl = new AbortController();
    const p = r.sleep(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
  });

  it('sleep resolves immediately for non-positive ms', async () => {
    const r = new Retrier({ max: 3, baseMs: 1, jitter: false });
    await expect(r.sleep(0)).resolves.toBeUndefined();
  });

  it('maxAttempts getter returns the configured max', () => {
    const r = new Retrier({ max: 7, baseMs: 1, jitter: false });
    expect(r.maxAttempts).toBe(7);
  });
});

describe('BudgetGuard', () => {
  it('preflight throws on per-request breach', () => {
    const g = new BudgetGuard({ perRequestUsd: 0.001 });
    expect(() => g.preflight(req(), 0.002)).toThrow(BudgetExceededError);
  });

  it('preflight throws on daily breach', () => {
    const g = new BudgetGuard({ dailyUsd: 0.01 });
    expect(() => g.preflight(req(), 0.02)).toThrow(BudgetExceededError);
  });

  it('preflight throws on per-task breach', () => {
    const g = new BudgetGuard({ perTaskUsd: { reasoning: 0.001 } });
    expect(() => g.preflight(req({ task: 'reasoning' }), 0.002)).toThrow(BudgetExceededError);
  });

  it('commit accumulates spend', () => {
    const g = new BudgetGuard({ dailyUsd: 10 });
    const cost = g.commit(
      req(),
      { costPer1kInput: 1, costPer1kOutput: 1 },
      { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
    );
    expect(cost).toBeCloseTo(2);
    expect(g.snapshot().spentTodayUsd).toBeCloseTo(2);
  });

  it('estimate returns a positive number', () => {
    const g = new BudgetGuard(undefined);
    const e = g.estimate(req({ prompt: 'x'.repeat(400), maxTokens: 100 }), {
      costPer1kInput: 0.001,
      costPer1kOutput: 0.002,
    });
    expect(e).toBeGreaterThan(0);
  });

  it('restore hydrates spend when day matches', () => {
    const g = new BudgetGuard(undefined);
    g.restore(0.5, new Date().toISOString().slice(0, 10));
    expect(g.getSpentToday()).toBe(0.5);
  });

  it('restore ignores stale day', () => {
    const g = new BudgetGuard(undefined);
    g.restore(0.5, '1999-01-01');
    expect(g.getSpentToday()).toBe(0);
  });

  it('snapshot exposes remaining', () => {
    const g = new BudgetGuard({ dailyUsd: 1 });
    g.commit(
      req(),
      { costPer1kInput: 100, costPer1kOutput: 100 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    );
    expect(g.snapshot().remainingTodayUsd).toBeCloseTo(0.8, 1);
  });

  it('getCurrentDay returns the rollover key', () => {
    const g = new BudgetGuard(undefined);
    expect(g.getCurrentDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('exceedsStreamLimit returns false when no limit is configured', () => {
    const g = new BudgetGuard(undefined);
    expect(g.exceedsStreamLimit(99_999, undefined)).toBe(false);
  });

  it('exceedsStreamLimit returns false when accumulated tokens are within the limit', () => {
    const g = new BudgetGuard(undefined);
    expect(g.exceedsStreamLimit(500, 1000)).toBe(false);
  });

  it('exceedsStreamLimit returns true once accumulated tokens exceed the limit', () => {
    const g = new BudgetGuard(undefined);
    expect(g.exceedsStreamLimit(1001, 1000)).toBe(true);
  });
});

describe('ModelRegistry', () => {
  it('throws when constructed with zero models', () => {
    expect(() => new ModelRegistry([])).toThrow();
  });

  it('throws on duplicate model id', () => {
    expect(() => new ModelRegistry([modelDef('a'), modelDef('a')])).toThrow();
  });

  it('initialises runtime state', () => {
    const r = new ModelRegistry([modelDef('a'), modelDef('b')]);
    const a = r.get('a');
    expect(a).toBeDefined();
    expect(a?.healthScore).toBe(100);
    expect(a?.circuit.state).toBe('closed');
  });

  it('produces snapshots', () => {
    const r = new ModelRegistry([modelDef('a')]);
    const snaps = r.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.id).toBe('a');
  });

  it('round-trips state via snapshot + restore', () => {
    const r = new ModelRegistry([modelDef('a')]);
    const state = r.get('a');
    if (!state) throw new Error('missing state');
    state.healthScore = 42;
    state.qualityScores.push(0.5);
    const snap = r.toStateSnapshot(0, '2026-01-01');
    const r2 = new ModelRegistry([modelDef('a')]);
    r2.restoreFrom(snap);
    expect(r2.get('a')?.healthScore).toBe(42);
  });
});
