/**
 * Golden routing decision suite.
 *
 * Given a frozen fixture of three models with distinct cost, latency and
 * quality profiles, every built-in strategy must select the documented
 * model. These golden expectations are part of the v1.0.0 contract: a
 * change in any of them is a routing-semantics change and requires a
 * major version bump (see SPEC.md §5.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CostFirst,
  CostThenQuality,
  LatencyFirst,
  QualityFirst,
  RoundRobin,
  SequentialFallback,
  Weighted,
} from '../../src/strategies/index.js';
import type { ModelDefinition, ModelId, ModelSnapshot } from '../../src/types.js';

const MODELS: readonly ModelDefinition[] = [
  {
    id: 'cheap-haiku' as ModelId,
    provider: {
      name: 'fixture',
      complete: () => Promise.reject(new Error('fixture not callable')),
      stream: async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
      parseError: () => ({ classification: 'unknown', message: 'fixture' }),
    },
    cost: { costPer1kInput: 0.0001, costPer1kOutput: 0.0004 },
    keys: 'sk-fixture',
    weight: 3,
  },
  {
    id: 'mid-flash' as ModelId,
    provider: {
      name: 'fixture',
      complete: () => Promise.reject(new Error('fixture not callable')),
      stream: async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
      parseError: () => ({ classification: 'unknown', message: 'fixture' }),
    },
    cost: { costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
    keys: 'sk-fixture',
    weight: 1,
  },
  {
    id: 'premium-opus' as ModelId,
    provider: {
      name: 'fixture',
      complete: () => Promise.reject(new Error('fixture not callable')),
      stream: async function* () {
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
      parseError: () => ({ classification: 'unknown', message: 'fixture' }),
    },
    cost: { costPer1kInput: 0.015, costPer1kOutput: 0.075 },
    keys: 'sk-fixture',
    weight: 1,
  },
];

const CHEAP_SNAPSHOT: ModelSnapshot = {
  id: 'cheap-haiku',
  providerName: 'fixture',
  circuitState: 'closed',
  healthScore: 0.95,
  inFlight: 0,
  successCount: 100,
  failureCount: 0,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastUsedAt: 0,
  avgLatencyMs: 900,
  avgQualityScore: 0.65,
  totalCostUsd: 0,
};

const MID_SNAPSHOT: ModelSnapshot = {
  id: 'mid-flash',
  providerName: 'fixture',
  circuitState: 'closed',
  healthScore: 0.98,
  inFlight: 0,
  successCount: 100,
  failureCount: 0,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastUsedAt: 0,
  avgLatencyMs: 600,
  avgQualityScore: 0.85,
  totalCostUsd: 0,
};

const PREMIUM_SNAPSHOT: ModelSnapshot = {
  id: 'premium-opus',
  providerName: 'fixture',
  circuitState: 'closed',
  healthScore: 0.99,
  inFlight: 0,
  successCount: 100,
  failureCount: 0,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastUsedAt: 0,
  avgLatencyMs: 350,
  avgQualityScore: 0.95,
  totalCostUsd: 0,
};

const SNAPSHOTS: readonly ModelSnapshot[] = [CHEAP_SNAPSHOT, MID_SNAPSHOT, PREMIUM_SNAPSHOT];

describe('golden routing decisions (SemVer-locked v1.0.0)', () => {
  it('cost-first picks the cheapest model', () => {
    const result = new CostFirst(MODELS).select(SNAPSHOTS);
    expect(result).toBe('cheap-haiku');
  });

  it('cost-then-quality with default floor picks the cheapest above the floor', () => {
    const result = new CostThenQuality(MODELS).select(SNAPSHOTS);
    expect(result).toBe('mid-flash');
  });

  it('cost-then-quality with a strict floor narrows the pool to high-quality models', () => {
    const result = new CostThenQuality(MODELS, 0.9).select(SNAPSHOTS);
    expect(result).toBe('premium-opus');
  });

  it('latency-first picks the lowest measured latency', () => {
    const result = new LatencyFirst().select(SNAPSHOTS);
    expect(result).toBe('premium-opus');
  });

  it('latency-first prefers unseen models when they exist (cold start)', () => {
    const withColdStart: readonly ModelSnapshot[] = [
      { ...CHEAP_SNAPSHOT, avgLatencyMs: 100, successCount: 50 },
      { ...MID_SNAPSHOT, avgLatencyMs: 0, successCount: 0 },
    ];
    const result = new LatencyFirst().select(withColdStart);
    expect(result).toBe('mid-flash');
  });

  it('quality-first picks the highest observed quality', () => {
    const result = new QualityFirst().select(SNAPSHOTS);
    expect(result).toBe('premium-opus');
  });

  it('sequential-fallback returns the first candidate in declaration order', () => {
    const result = new SequentialFallback().select(SNAPSHOTS);
    expect(result).toBe('cheap-haiku');
  });

  it('round-robin cycles through every candidate in order', () => {
    const strategy = new RoundRobin();
    expect(strategy.select(SNAPSHOTS)).toBe('cheap-haiku');
    expect(strategy.select(SNAPSHOTS)).toBe('mid-flash');
    expect(strategy.select(SNAPSHOTS)).toBe('premium-opus');
    expect(strategy.select(SNAPSHOTS)).toBe('cheap-haiku');
  });

  describe('weighted strategy with deterministic Math.random', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('with random=0 always picks the first candidate', () => {
      const result = new Weighted(MODELS).select(SNAPSHOTS);
      expect(result).toBe('cheap-haiku');
    });

    it('with random=0.8 lands in the middle bucket (weights 3,1,1; total 5)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.8);
      const result = new Weighted(MODELS).select(SNAPSHOTS);
      expect(result).toBe('mid-flash');
    });

    it('with random=0.95 lands in the last bucket', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.95);
      const result = new Weighted(MODELS).select(SNAPSHOTS);
      expect(result).toBe('premium-opus');
    });
  });

  it('every strategy returns null on an empty candidate pool', () => {
    expect(new CostFirst(MODELS).select([])).toBeNull();
    expect(new CostThenQuality(MODELS).select([])).toBeNull();
    expect(new LatencyFirst().select([])).toBeNull();
    expect(new QualityFirst().select([])).toBeNull();
    expect(new RoundRobin().select([])).toBeNull();
    expect(new SequentialFallback().select([])).toBeNull();
    expect(new Weighted(MODELS).select([])).toBeNull();
  });
});
